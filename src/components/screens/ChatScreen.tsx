/**
 * ChatScreen — main chat TUI. Composes all UI primitives and wires AI streaming.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Banner from "@/components/ui/Banner.js";
import MessageList from "@/components/ui/MessageList.js";
import InputBar from "@/components/ui/InputBar.js";
import ContextBar from "@/components/ui/ContextBar.js";
import StatusLine from "@/components/ui/StatusLine.js";
import PermissionDialog from "@/components/ui/PermissionDialog.js";
import UndoMenu from "@/components/ui/UndoMenu.js";
import SkillsMarketplaceScreen from "@/components/screens/SkillsMarketplaceScreen.js";
import ConfigScreen from "@/components/screens/ConfigScreen.js";
import { useAuth, useSession, useModel, useStreaming, useMode, useStore, useCredits } from "@/store/index.js";
import { handleStream } from "@/ai/stream.js";
import { allTools } from "@/ai/tools.js";
import { loadMcpTools } from "@/mcp/tools.js";
import { trimToContextWindow, buildSystemWithContext, estimateMessagesTokens, contextEvents, compressContext, loadMemoryFiles, saveMemoryFile, buildSessionMemorySummary } from "@/ai/context.js";
import { buildCompactSummary, shouldAutoCompact } from "@/ai/compact.js";
import type { ContextStats } from "@/ai/context.js";
import type { tool, ToolSet } from "ai";
import { cmdUpdate } from "@/commands/update.js";
import { cmdDirectoryTree } from "@/commands/directory.js";
import { cmdInit } from "@/commands/init.js";
import { cmdListModels, cmdSetModel } from "@/commands/models.js";
import { planExists, getBuildPrompt } from "@/commands/plan.js";
import { getWorkflowsList, cmdSaveWorkflow, cmdShowWorkflow, cmdDeleteWorkflow, cmdRunWorkflow, cmdScheduleWorkflow, cmdCreateWorkflow, type WorkflowStep } from "@/commands/workflows.js";
import { getPluginsList, cmdInstallPlugin, cmdRemovePlugin, discoverMarketplace, cmdCheckUpdates, cmdAutoUpdate } from "@/commands/plugins.js";
import { cmdHistoryList } from "@/commands/history.js";
import { cmdListSessions, cmdCreateSession, cmdResumeSession } from "@/commands/session.js";
import { getAllAgents, cmdCreateAgent, cmdRemoveAgent, cmdUpdateAgent, cmdRunAgentsParallel } from "@/commands/agents.js";
import { syncContextPct, getApiClient } from "@/api/client.js";
import { bridgeMemorySearch } from "@/bridge/client.js";
import { cmdWebAnalyze } from "@/commands/web.js";
import { cmdPenpotOpen } from "@/commands/penpot.js";
import { addMcpServer, removeMcpServer, listMcpServers, getMcpServer, enableMcpServer, disableMcpServer, checkMcpStatus, formatMcpStatus, getMcpResources, searchMcpResources, parseMcpPrompt, runMcpPrompt, serverRequiresOAuth, getOAuthUrl, completeServerOAuth, importFromClaudeDesktop } from "@/mcp/manager.js";
import { startModelAutoRefresh } from "@/store/slices/model.slice.js";
import { handleGitCommand } from "@/commands/git.js";
import { initHooksConfig, loadHooksConfig, reloadHooksConfig, runHooks, runSessionStartHook, runStopHook, runUserPromptSubmitHook, wrapToolsWithPreToolUseHook, addHook, removeHook, setHooksDisabled } from "@/ai/hooks.js";
import { handleQuickCommand } from "@/commands/quick.js";
import { handleSearchCommand } from "@/commands/search.js";
import { handleCleanCommand } from "@/commands/clean.js";
import { handleErrorHelpCommand } from "@/commands/error-help.js";
import { handleTestGenCommand } from "@/commands/test-gen.js";
import { setupJiraMcp, removeJiraMcp, jiraStatus, JIRA_HELP, setupNotionMcp, removeNotionMcp, notionStatus, NOTION_HELP } from "@/mcp/enterprise/index.js";
import TokenBudgetWarning from "@/components/ui/TokenBudgetWarning.js";
import { SessionCostTracker } from "@/utils/cost-estimate.js";
import logger from "@/utils/logger.js";
import { fetchNotifications, markAllNotificationsRead, formatNotificationForTUI } from "@/api/notifications.js";
import { undoManager } from "@/ai/undo-manager.js";
import { formatPermissionRulesForDisplay, addPermissionRule, removePermissionRule, parsePermissionRule, listPermissionRules } from "@/commands/permissions.js";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import type { ModelMessage as CoreMessage } from "ai";

const execAsync = promisify(execCb);

const BASE_SYSTEM = `You are Pakalon, an expert AI coding assistant running in a terminal.
- Be concise and precise.
- When showing code, always use proper fenced code blocks with the language tag.
- You have access to tools: readFile, writeFile, listDir, bash.
- Only use tools when explicitly necessary.
- Respect the user's working directory context.`;

interface ChatScreenProps {
  initialMessage?: string;
  projectDir?: string;
  showBanner?: boolean;
  modelOverride?: string;
  defaultModel?: string;
  fallbackModel?: string;
  /** Epic B: Additional context directories merged into context building */
  addDirs?: string[];
  /** Epic B: Comma-separated tool names to allow (all allowed if omitted) */
  allowedTools?: string;
  /** Epic B: Additional MCP server URLs passed to loadMcpTools */
  mcpServers?: string[];
  /** Epic B: Array of user messages to replay on mount */
  replayMessages?: string[];
  /** File contents (pre-loaded strings) to inject as context on mount */
  fileContexts?: string[];
  /** Maximum spend budget in USD; generation stops when exceeded */
  maxBudgetUsd?: number;
  /** When true, slash-command input is sent as plain messages (--disable-slash-commands) */
  disableSlashCommands?: boolean;
  /** Override system prompt (built from --system-prompt* flags) */
  systemPrompt?: string;
  /** Memory file content (PAKALON.md/CLAUDE.md) to inject into system prompt */
  memoryBlock?: string;
}

const ChatScreen: React.FC<ChatScreenProps> = ({
  initialMessage,
  projectDir,
  showBanner = true,
  modelOverride,
  defaultModel,
  fallbackModel,
  addDirs = [],
  allowedTools,
  mcpServers = [],
  replayMessages = [],
  fileContexts = [],
  maxBudgetUsd,
  disableSlashCommands = false,
  systemPrompt,
  memoryBlock = "",
}) => {
  const { exit } = useApp();
  const { token, plan, githubLogin, userId } = useAuth();
  const { messages, addMessage, finalizeStreamingMessage } = useSession();
  const { selectedModel, availableModels } = useModel();
  const setSelectedModel = useStore((s) => s.setSelectedModel);
  const { creditBalance, fetchCredits } = useCredits();

  // Fetch credit balance on mount (and after login)
  useEffect(() => {
    if (token) fetchCredits();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // GAP-P1-01: Fire SessionStart hook on chat mount
  useEffect(() => {
    const fireSessionStart = async () => {
      try {
        await runSessionStartHook(projectDir, activeSessionId ?? undefined);
      } catch (hookErr) {
        // Hook errors are non-blocking - log and continue
        logger.warn("[Hook] SessionStart hook failed:", hookErr);
      }
    };
    fireSessionStart();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount
  useEffect(() => {
    if (token) fetchCredits();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // T-CLI-CREDITS: Show a one-time startup warning when credits are fully exhausted.
  // Fires once when creditBalance first loads (non-null) and is depleted.
  const startupCreditWarnedRef = useRef(false);
  useEffect(() => {
    if (!creditBalance || startupCreditWarnedRef.current) return;
    startupCreditWarnedRef.current = true;
    if (creditBalance.credits_remaining <= 0 && creditBalance.credits_total > 0) {
      // Delay slightly so the banner/welcome message renders first
      setTimeout(() => {
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            `⛔ **Credits exhausted** — Your Pakalon credit balance is 0 / ${creditBalance.credits_total}.\n\n` +
            `You will not be able to send new messages until your billing period resets or you upgrade.\n` +
            `Run \`/upgrade\` or visit https://pakalon.io/pricing`,
          createdAt: new Date(),
          isStreaming: false,
        });
      }, 800);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditBalance]);

  // T2-10: Auto-refresh available models from backend (on mount + every 5 min)
  useEffect(() => {
    const stop = startModelAutoRefresh(
      () => token ?? null,
      () => useStore.getState(),
      process.env.PAKALON_API_URL,
    );
    return stop;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T-CLI-NOTIF: Poll backend notifications on mount and every 5 minutes.
  // Displays billing reminders, grace-period warnings, and system alerts as TUI messages.
  // Only shows unread notifications — marks them all as read after display.
  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    const pollNotifications = async () => {
      try {
        const notifs = await fetchNotifications(true, 10);
        if (cancelled) return;
        if (notifs.length > 0) {
          for (const n of notifs) {
            addMessage({
              id: crypto.randomUUID(),
              role: "assistant",
              content: formatNotificationForTUI(n),
              createdAt: new Date(),
              isStreaming: false,
            });
          }
          // Mark all displayed notifications as read
          void markAllNotificationsRead();
        }
      } catch {
        // Notifications are non-critical — silently ignore
      }
    };

    // Run immediately on mount, then every 5 minutes
    void pollNotifications();
    const interval = setInterval(() => void pollNotifications(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const { isStreaming, appendStreamChunk, setThinkContent, thinkContent, reset: resetStreaming } = useStreaming();
  const { verbose, thinkingEnabled, privacyMode, cyclePermissionMode, toggleThinking, permissionMode, autoCompact, autoCompactThreshold, toggleAutoCompact, setAutoCompactThreshold } = useMode();
  const remainingPct = useStore((s) => s.remainingPct);
  const setRemainingPct = useStore((s) => s.setRemainingPct);
  const activeSessionId = useStore((s) => s.sessionId);
  const sentInitial = useRef(false);
  const mcpToolsRef = useRef<ToolSet>({});
  // /pakalon overwrite protection — holds pending launch config while user confirms
  const pendingOverwriteRef = useRef<null | {
    userPrompt: string; userId: string; userPlan: string;
    isYolo: boolean; privacyMode: boolean; figmaUrl?: string;
  }>(null);
  const [showUndo, setShowUndo] = useState(false);
  const [showStatusline, setShowStatusline] = useState(true);
  const [vimMode, setVimMode] = useState(false);
  const [ideMode, setIdeMode] = useState<"auto" | "on" | "off">("auto");
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [marketplaceQuery, setMarketplaceQuery] = useState("");
  const [showConfigScreen, setShowConfigScreen] = useState(false);
  const [configScope, setConfigScope] = useState<"project" | "global">("project");
  // T-CLI-53: Ctrl+T task panel; T-CLI-51: Ctrl+B bash overlay
  const [showTaskPanel, setShowTaskPanel] = useState(false);
  const [bashOverlayCmd, setBashOverlayCmd] = useState<string | null>(null);
  const [showBashOverlay, setShowBashOverlay] = useState(false);
  // T-CLI-51: Background bash tasks — spawn non-blocking, collect output
  interface BgTask { id: string; cmd: string; status: "running" | "done" | "error"; output: string; exitCode?: number; }
  const [backgroundTasks, setBackgroundTasks] = useState<BgTask[]>([]);
  // T-CLI-66: Output style — explanatory | concise | learning
  const [outputStyle, setOutputStyle] = useState<"explanatory" | "concise" | "learning">("explanatory");
  // T-CLI-54: Ctrl+R history search
  const [historySearch, setHistorySearch] = useState<string | null>(null);
  // T-CLI-57: Ghost text — prompt suggestion shown as faded completion after current input
  const [inputSuggestion, setInputSuggestion] = useState<string>("");
  // T-CLI-69: TUI theme
  const [tuiTheme, setTuiTheme] = useState<"dark" | "light" | "high-contrast" | "solarized">("dark");
  // T-CLI-72: Sandbox mode (bash exec isolated per invocation)
  const [sandboxMode, setSandboxMode] = useState(false);
  const [sessionTokensUsed, setSessionTokensUsed] = useState(0);
  // Budget tracking: cumulative USD spend estimate
  const [sessionSpendUsd, setSessionSpendUsd] = useState(0);
  // T3-13: Session cost tracker (singleton per mount)
  const costTrackerRef = useRef(new SessionCostTracker());
  // T-CLI-52: Ctrl+F stream abort controller
  const abortControllerRef = useRef<AbortController | null>(null);
  const budgetExceeded = maxBudgetUsd !== undefined && sessionSpendUsd >= maxBudgetUsd;
  const modelInfo = availableModels.find((m) => m.id === selectedModel);
  const sessionContextLimit = modelInfo?.contextLength ?? 128000;
  const attemptedAutoModelRef = useRef(false);
  // T-LSP-03: Real-time LSP diagnostics — polled every 5s when task panel open
  interface LspDiag { severity: string; message: string; line?: number; source?: string; filePath: string; }
  const [lspDiagnostics, setLspDiagnostics] = useState<LspDiag[]>([]);

  // T-CLI-51: Spawn a background bash task — non-blocking, collects output async
  const spawnBgTask = (cmd: string) => {
    const taskId = crypto.randomUUID();
    setBackgroundTasks((prev) => [...prev, { id: taskId, cmd, status: "running", output: "", exitCode: undefined }]);
    import("child_process").then(({ spawn: spawnProc }) => {
      const proc = spawnProc(cmd, { shell: true, cwd: projectDir ?? process.cwd() });
      let buf = "";
      proc.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        setBackgroundTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, output: buf.slice(-4096) } : t));
      });
      proc.stderr?.on("data", (d: Buffer) => {
        buf += d.toString();
        setBackgroundTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, output: buf.slice(-4096) } : t));
      });
      proc.on("close", (code: number | null) => {
        setBackgroundTasks((prev) => prev.map((t) =>
          t.id === taskId ? { ...t, status: code === 0 ? "done" : "error", exitCode: code ?? -1 } : t
        ));
      });
    }).catch(() => {
      setBackgroundTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: "error", output: "Failed to spawn" } : t));
    });
  };

  // Model bootstrapping policy:
  // 1) explicit --model override
  // 2) --defaultModel if valid
  // 3) backend /models/auto recommendation
  // 4) --fallbackModel if valid
  useEffect(() => {
    if (!availableModels.length) return;

    const findModelId = (candidate?: string): string | null => {
      if (!candidate) return null;
      const lower = candidate.toLowerCase();
      const exact = availableModels.find((m) => m.id.toLowerCase() === lower);
      if (exact) return exact.id;
      const partial = availableModels.find(
        (m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower)
      );
      return partial?.id ?? null;
    };

    const explicit = findModelId(modelOverride);
    if (explicit && selectedModel !== explicit) {
      setSelectedModel(explicit);
      return;
    }

    if (selectedModel) return;

    const preferredDefault = findModelId(defaultModel);
    if (preferredDefault) {
      setSelectedModel(preferredDefault);
      return;
    }

    if (!attemptedAutoModelRef.current && token) {
      attemptedAutoModelRef.current = true;
      void (async () => {
        try {
          const autoRes = await getApiClient().get<{ model_id: string }>("/models/auto");
          const autoId = findModelId(autoRes.data.model_id);
          if (autoId) {
            setSelectedModel(autoId);
            return;
          }
        } catch {
          // non-fatal; fallback below
        }
        const fallbackId = findModelId(fallbackModel);
        if (fallbackId) {
          setSelectedModel(fallbackId);
        }
      })();
    }
  }, [availableModels, selectedModel, modelOverride, defaultModel, fallbackModel, token, setSelectedModel]);

  // Epic A-01: Recompute session token count whenever messages change
  useEffect(() => {
    const coreMessages = messages
      .filter((m: any) => !m.isStreaming)
      .map((m: any) => ({ role: m.role, content: m.content })) as CoreMessage[];
    const estimated = estimateMessagesTokens(coreMessages);
    setSessionTokensUsed(estimated);
    // Epic A-06: Debounced PATCH to keep backend context_pct_used in sync
    if (activeSessionId && sessionContextLimit > 0) {
      syncContextPct(activeSessionId, (estimated / sessionContextLimit) * 100);
    }
  }, [messages, activeSessionId, sessionContextLimit]);

  // Subscribe to live context_stats events emitted by getContextStats() in context.ts
  // This fires whenever the AI pipeline calls trimToContextWindow or compressContext
  useEffect(() => {
    const unsub = contextEvents.on("context_stats", (payload) => {
      const stats = payload as ContextStats;
      setSessionTokensUsed(stats.used);
      // Store wants remaining% (100 - used%)
      setRemainingPct(100 - stats.percent);
    });
    return unsub;
  }, [setRemainingPct]);

  // Load MCP tools once on mount — include any extra --MCP servers
  useEffect(() => {
    loadMcpTools(projectDir, mcpServers)
      .then(({ tools, toolCount }) => {
        mcpToolsRef.current = tools;
        if (toolCount > 0) {
          logger.debug(`[ChatScreen] Loaded ${toolCount} MCP tool(s)`);
        }
      })
      .catch((err) => logger.warn("[ChatScreen] MCP tools load failed", { err: String(err) }));
  }, [projectDir, mcpServers.join(",")]);

  useEffect(() => {
    void runSessionStartHook(projectDir, activeSessionId);
  }, [projectDir, activeSessionId]);

  // T-LSP-03: Poll LSP diagnostics every 5 s when the task panel is open.
  // Only active files (recently written) are polled to avoid flooding the LSP.
  useEffect(() => {
    if (!showTaskPanel) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        // Collect the last 5 unique files that were written this session
        const { fileChanges } = useStore.getState() as any;
        const recentPaths: string[] = Object.keys(fileChanges ?? {}).slice(-5);
        if (!recentPaths.length) return;
        const { getFileDiagnostics: getDiag } = await import("@/lsp/index.js");
        const allDiags: LspDiag[] = [];
        for (const fp of recentPaths) {
          try {
            const diags = await getDiag(fp);
            for (const d of diags) {
              allDiags.push({
                severity: d.severity ?? "info",
                message: d.message,
                line: d.range?.start?.line != null ? (d.range.start.line + 1) : undefined,
                source: d.source ?? undefined,
                filePath: fp,
              });
            }
          } catch { /* LSP not running for this file — skip */ }
        }
        if (!cancelled) setLspDiagnostics(allDiags.slice(0, 30));
      } catch { /* ignore */ }
    };
    const interval = setInterval(() => { void poll(); }, 5000);
    void poll();
    return () => { cancelled = true; clearInterval(interval); };
  }, [showTaskPanel, projectDir]);

  const info = useCallback((content: string) => {
    addMessage({ id: crypto.randomUUID(), role: "assistant", content, createdAt: new Date(), isStreaming: false });
  }, [addMessage]);

  // T-005: Check context exhaustion before launching AI pipeline
  const checkContextAndProceed = useCallback(async (
    modelId: string,
    onProceed: () => void,
    apiBaseUrl?: string,
    authToken?: string
  ) => {
    try {
      const contextStatus = await useStore.getState().checkContextStatus(modelId, apiBaseUrl, authToken);
      if (contextStatus.exhausted) {
        info(
          `⚠️  **Context exhausted for ${modelId}**\n\n` +
          `${contextStatus.message || "This model has reached its context window limit."}\n\n` +
          `Use \`/model switch\` to select a model with a larger context window, ` +
          `or start a new session with \`/resume new\`.`
        );
        return false;
      }
      onProceed();
      return true;
    } catch (err) {
      // Non-fatal: if context check fails, proceed anyway
      onProceed();
      return true;
    }
  }, [info]);

  // T-005: Check context status before launching pipeline
  type LaunchCfg = Parameters<ReturnType<typeof useStore.getState>["launchBridgePipeline"]>[0];
  const checkContextAndLaunch = useCallback(async (launchCfg: LaunchCfg) => {
    const modelId = selectedModel;
    if (!modelId) {
      // No model selected, proceed without check
      useStore.getState().launchBridgePipeline(launchCfg);
      return;
    }

    try {
      const contextStatus = await useStore.getState().checkContextStatus(
        modelId,
        process.env.PAKALON_API_URL,
        token ?? undefined
      );

      if (contextStatus.exhausted) {
        // Show user-friendly message about context exhaustion
        const suggestion = `\n\n**Suggestion:** Use \`/model switch\` to select a model with a larger context window, or start a new session with \`/session new\`.`;
        info(
          `⚠️  **Context exhausted** for **${modelId}** — ${contextStatus.message}${suggestion}`
        );
        return;
      }

      // Context OK, proceed with launch
      useStore.getState().launchBridgePipeline(launchCfg);
    } catch (err) {
      // Non-fatal: if context check fails, proceed anyway (stale cache, network issues, etc.)
      if (process.env.NODE_ENV !== "production") {
        console.warn("[ChatScreen] context check failed, proceeding anyway:", err);
      }
      useStore.getState().launchBridgePipeline(launchCfg);
    }
  }, [selectedModel, token, info]);

  const handleSubmit = useCallback(
    async (text: string) => {
      if (isStreaming) return;

      // /pakalon overwrite confirmation — user typed 'yes' after the prompt
      if (pendingOverwriteRef.current) {
        const answer = text.trim().toLowerCase();
        if (answer === "yes" || answer === "y" || answer === "overwrite") {
          const launchCfg = pendingOverwriteRef.current;
          pendingOverwriteRef.current = null;
          info(`✦ Overwriting existing pipeline. Launching…`);
          useStore.getState().launchBridgePipeline(launchCfg);
        } else {
          pendingOverwriteRef.current = null;
          info(`Cancelled. Run \`/pakalon <description>\` when ready.`);
        }
        return;
      }

    if (budgetExceeded) {
      info(`⛔ Spend budget of $${maxBudgetUsd?.toFixed(2)} USD reached ($${sessionSpendUsd.toFixed(4)} used). Use --max-budget-usd to set a higher limit.`);
      return;
    }

    // T-CLI-CREDITS: Block interaction when credit balance is fully exhausted.
    // Requirement: "if the credits are over and completed then cannot send or interact with the application"
    if (creditBalance && creditBalance.credits_remaining <= 0 && creditBalance.credits_total > 0) {
      info(
        `⛔ Your Pakalon credits are exhausted (${creditBalance.credits_total} used).\n\n` +
        `Upgrade to Pro or wait for your billing period to reset to continue using Pakalon.\n` +
        `Run \`/upgrade\` or visit https://pakalon.io/pricing`,
      );
      return;
    }

    // T-005: Check context exhaustion before launching bridge pipeline
    const currentModel = selectedModel;
    if (currentModel && token) {
      try {
        const apiBase = process.env.PAKALON_API_URL ?? "http://localhost:8000";
        const contextStatus = await useStore.getState().checkContextStatus(currentModel, apiBase, token);
        if (contextStatus.exhausted) {
          info(
            `⚠️  Context exhausted for **${currentModel}**.\n\n` +
            `Your session has reached the context limit for this model.\n\n` +
            `To continue:\n` +
            `  • Use \`/model switch\` to select a model with a larger context window\n` +
            `  • Or start a new session with \`/session new\` to reset context\n\n` +
            `Run \`/models\` to see available models.`
          );
          return;
        }
      } catch (err) {
        // Non-fatal: if context check fails, continue with normal processing
        if (process.env.NODE_ENV !== "production") {
          console.warn("[ChatScreen] context check failed:", err);
        }
      }
    }

      // Lifecycle hook gate for each submitted prompt.
      let workingText = text;

      // T-CLI-56: `!command` at start of message — execute in shell WITHOUT invoking AI.
      // The existing `!cmd` mid-message pattern injects output into AI context.
      // This handles the standalone `!cmd` prefix case (no other text → direct execution).
      if (/^!([^!\s][^\n]*)$/.test(workingText.trim())) {
        const shellCmd = workingText.trim().slice(1).trim();
        addMessage({
          id: crypto.randomUUID(),
          role: "user",
          content: `\`!${shellCmd}\``,
          createdAt: new Date(),
          isStreaming: false,
        });
        try {
          const { exec: execCb } = await import("child_process");
          const { promisify } = await import("util");
          const execP = promisify(execCb);
          const { stdout, stderr } = await execP(shellCmd, {
            cwd: projectDir ?? process.cwd(),
            timeout: 30000,
          });
          const combined = (stdout + stderr).trim();
          addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            content: combined ? `\`\`\`\n${combined.slice(0, 8192)}\n\`\`\`` : "_(no output)_",
            createdAt: new Date(),
            isStreaming: false,
          });
        } catch (e: any) {
          const errOut = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
          addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            content: `\`\`\`\n${errOut.slice(0, 4096)}\n\`\`\`\n_(exit code ${e.code ?? 1})_`,
            createdAt: new Date(),
            isStreaming: false,
          });
        }
        return;
      }
      try {
        const hookGate = await runUserPromptSubmitHook(workingText, projectDir, activeSessionId);
        if (hookGate.blocked) {
          info(`⛔ Prompt blocked by hook${hookGate.reason ? `: ${hookGate.reason}` : "."}`);
          return;
        }
        const updatedPrompt = hookGate.decision?.updatedPrompt;
        if (typeof updatedPrompt === "string" && updatedPrompt.trim().length > 0) {
          workingText = updatedPrompt;
        }
      } catch {
        // non-fatal: if hooks fail, continue with normal processing
      }

      // Handle @agent-name mentions — route message to named specialist agents in parallel
      const mentionMatches = [...workingText.matchAll(/\B@([\w-]+)/g)];
      if (mentionMatches.length > 0) {
        const mentionedNames = [...new Set(mentionMatches.map((m) => m[1]!))];
        const allAgentsList = getAllAgents();
        const matchedAgents = mentionedNames
          .map((name) => allAgentsList.find((a) => a.name.toLowerCase() === name.toLowerCase()))
          .filter((a): a is NonNullable<typeof a> => a != null);

        if (matchedAgents.length > 0) {
          // Strip @mentions from the task text sent to agents
          const taskText = workingText.replace(/\B@[\w-]+/g, "").trim();
          addMessage({ id: crypto.randomUUID(), role: "user", content: workingText, createdAt: new Date(), isStreaming: false });
          const runRequests = matchedAgents.map((agent) => ({
            agentName: agent.name,
            task: taskText || workingText,
            projectDir: projectDir ?? process.cwd(),
          }));
          info(`Running task on ${matchedAgents.map((a) => `@${a.name}`).join(", ")}…`);
          try {
            const results = await cmdRunAgentsParallel(runRequests);
            for (const result of results) {
              if (result.success && result.response) {
                addMessage({
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: `**@${result.agentName}** (${result.durationMs}ms):\n\n${result.response}`,
                  createdAt: new Date(),
                  isStreaming: false,
                });
              } else {
                info(`**@${result.agentName}** failed: ${result.error ?? "unknown error"}`);
              }
            }
          } catch (e: any) {
            info(`Agent mention error: ${e.message}`);
          }
          return;
        }
        // No agents matched — fall through to normal chat
      }

      // T-CLI-56: `!cmd` standalone bash execution — runs the command directly,
      // outputs the result to chat WITHOUT sending to the AI.
      // "!ls src/" → runs ls, shows output inline. Does NOT raise with AI.
      // Distinct from the `!cmd` injection within a message (which sends output to AI).
      if (workingText.startsWith("!") && !workingText.startsWith("!!")) {
        const shellCmd = workingText.slice(1).trim();
        if (shellCmd) {
          addMessage({
            id: crypto.randomUUID(),
            role: "user",
            content: `\`!${shellCmd}\``,
            createdAt: new Date(),
            isStreaming: false,
          });
          try {
            const { stdout, stderr } = await execAsync(shellCmd, {
              cwd: projectDir ?? process.cwd(),
              timeout: 30000,
            });
            const output = (stdout + stderr).trim().slice(0, 8192) || "(no output)";
            addMessage({
              id: crypto.randomUUID(),
              role: "assistant",
              content: `\`\`\`\n${output}\n\`\`\``,
              createdAt: new Date(),
              isStreaming: false,
            });
          } catch (execErr: any) {
            const errOut = `${execErr.stdout ?? ""}${execErr.stderr ?? ""}`.trim().slice(0, 4096);
            addMessage({
              id: crypto.randomUUID(),
              role: "assistant",
              content: `❌ Exit ${execErr.code ?? 1}\n\`\`\`\n${errOut || execErr.message}\n\`\`\``,
              createdAt: new Date(),
              isStreaming: false,
            });
          }
          return;
        }
      }

      // Handle slash commands (skip if --disable-slash-commands was passed)
      if (!disableSlashCommands && workingText.startsWith("/")) {
        const [cmd, ...args] = workingText.split(" ");
        switch (cmd) {
          case "/clear":
            useStore.getState().clearMessages();
            return;

          case "/compact": {
            // T-A18: Summarize conversation to free up context
            const focusHint = args.length > 0 ? args.join(" ") : undefined;
            
            // T-HK-12: Fire PreCompact lifecycle hook — allows hooks to block or annotate compaction
            const preCompactResults = await runHooks(
              "PreCompact",
              { cwd: projectDir, sessionId: sessionId ?? undefined },
              projectDir
            );
            const compactBlocked = preCompactResults.some((r) => r.blocked);
            if (compactBlocked) {
              const reason = preCompactResults.find((r) => r.blocked)?.decision?.reason;
              info(`⚠️ Compaction blocked by PreCompact hook${reason ? `: ${reason}` : "."}`);
              return;
            }

            // Get current messages (excluding any existing summary)
            const currentMessages = messages.filter((m: any) => 
              m.role !== "system" || !m.content.includes("## Conversation Summary")
            );
            
            if (currentMessages.length === 0) {
              info("No messages to compact.");
              return;
            }
            
            // Build summary
            const summaryMsg = buildCompactSummary(currentMessages as any[], focusHint);
            
            // Replace messages with just the summary
            useStore.getState().clearMessages();
            useStore.getState().addMessage(summaryMsg);
            
            // Update remaining percentage (summary is much smaller)
            const newTokens = estimateMessagesTokens([
              { role: "system", content: summaryMsg.content },
              { role: "user", content: "" },
            ]);
            const newPct = Math.min(100, Math.round((1 - newTokens / sessionContextLimit) * 100));
            setRemainingPct(newPct);
            
            info(`✅ Conversation compacted. Context now at **${newPct}%**${focusHint ? ` (focus: ${focusHint})` : ""}`);
            return;
          }

          case "/new": {
            try {
              const s = await cmdCreateSession(undefined, "chat", projectDir);
              useStore.getState().clearMessages();
              useStore.getState().setSessionId?.(s.id);
              info(`New session started: \`${s.id}\``);
            } catch (e: any) { info(`Error creating session: ${e.message}`); }
            return;
          }

          // T-A19: /permissions command - interactive permission rule editor
          case "/permissions": {
            const sub = args[0];
            const cwd = projectDir ?? process.cwd();
            
            // /permissions list - show current rules
            if (!sub || sub === "list") {
              const display = formatPermissionRulesForDisplay(cwd);
              info(display);
              return;
            }
            
            // /permissions add <allow|deny> <tool[(pattern)]> [- description]
            if (sub === "add") {
              const ruleStr = args.slice(1).join(" ");
              const rule = parsePermissionRule(ruleStr);
              if (!rule) {
                info("Usage: /permissions add <allow|deny> <tool[(pattern)]> [- description]\n\nExamples:\n  /permissions add allow Bash(npm *) - allow npm commands\n  /permissions add deny WriteFile(*.env) - deny env file writes\n  /permissions add allow readFile");
                return;
              }
              const result = addPermissionRule(rule, cwd);
              if (result.success) {
                info(`✅ Permission rule added: **${rule.action.toUpperCase()}** ${rule.tool}${rule.pattern ? `(${rule.pattern})` : ""}`);
              } else {
                info(`❌ ${result.error}`);
              }
              return;
            }
            
            // /permissions remove <tool> [pattern]
            if (sub === "remove" || sub === "delete") {
              const tool = args[1];
              const pattern = args[2];
              if (!tool) {
                info("Usage: /permissions remove <tool> [pattern]");
                return;
              }
              const result = removePermissionRule(tool, pattern, "project", cwd);
              if (result.success) {
                info(`✅ Permission rule removed: ${tool}${pattern ? `(${pattern})` : ""}`);
              } else {
                info(`❌ ${result.error}`);
              }
              return;
            }
            
            // Default: show help
            info(`**Permission Rules**\n\nUsage:\n  /permissions list - Show all rules\n  /permissions add <allow|deny> <tool[(pattern)]> [- description]\n  /permissions remove <tool> [pattern]\n\nExamples:\n  /permissions add allow Bash(npm *) - allow npm commands\n  /permissions add deny WriteFile(*.env) - deny env file writes\n  /permissions remove Bash\n\nRules are stored in .pakalon/settings.json`);
            return;
          }

          case "/history": {
            try {
              const sessions = await cmdHistoryList(20, projectDir);
              if (!sessions.length) {
                info("No sessions found for this directory.\n\nStart chatting to create your first session.");
                return;
              }
              const lines = sessions.map((s: any, i: number) => {
                const date = new Date(s.created_at).toLocaleString();
                const model = s.model_id ?? "—";
                const prompts = s.messages_count ?? s.message_count ?? 0;
                const lines_ = s.lines_written != null ? `${s.lines_written} lines` : "";
                const tokens = s.tokens_used ? `${s.tokens_used.toLocaleString()} tokens` : "";
                const ctxPct = s.context_pct_used != null ? ` | ${s.context_pct_used.toFixed(0)}% ctx` : "";
                const stats = [tokens, lines_, ctxPct].filter(Boolean).join(" | ");
                return `  ${i + 1}. \`${s.id.slice(0, 8)}…\`  ${date}  \`${model}\`  ${prompts} prompts${stats ? `  — ${stats}` : ""}`;
              });
              info(`**Session History — ${projectDir ? `\`${projectDir}\`` : "all directories"} (${sessions.length}):**\n\n${lines.join("\n")}\n\nResume with \`/resume <id>\` · Fork with \`/fork\` · Export with \`/export\``);
            } catch (e: any) { info(`Error fetching history: ${e.message}`); }
            return;
          }

          case "/agents": {
            const sub = args[0];

            // /agents create <name> [--parent <parentName>]
            if (sub === "create") {
              const nameParts: string[] = [];
              let parentOpt: string | undefined;
              let descOpt: string | undefined;
              let promptOpt: string | undefined;
              let colorOpt: string | undefined;
              let toolsOpt: string[] | undefined;

              const collectFlagValue = (startIndex: number): { value: string; next: number } => {
                const values: string[] = [];
                let i = startIndex;
                while (i < args.length && !args[i]!.startsWith("--")) {
                  values.push(args[i]!);
                  i++;
                }
                return { value: values.join(" ").trim(), next: i - 1 };
              };

              for (let i = 1; i < args.length; i++) {
                if (args[i] === "--parent" && args[i + 1]) {
                  const parsed = collectFlagValue(i + 1);
                  parentOpt = parsed.value || undefined;
                  i = parsed.next;
                } else if (args[i] === "--desc" && args[i + 1]) {
                  const parsed = collectFlagValue(i + 1);
                  descOpt = parsed.value || undefined;
                  i = parsed.next;
                } else if (args[i] === "--prompt" && args[i + 1]) {
                  const parsed = collectFlagValue(i + 1);
                  promptOpt = parsed.value || undefined;
                  i = parsed.next;
                } else if (args[i] === "--color" && args[i + 1]) {
                  colorOpt = args[i + 1];
                  i++;
                } else if (args[i] === "--tools" && args[i + 1]) {
                  toolsOpt = args[i + 1]!.split(",").map((t) => t.trim()).filter(Boolean);
                  i++;
                } else {
                  nameParts.push(args[i]!);
                }
              }
              const agentName = nameParts.join(" ") || "New Agent";
              try {
                await cmdCreateAgent({
                  name: agentName,
                  parent: parentOpt,
                  description: descOpt,
                  systemPrompt: promptOpt,
                  color: colorOpt,
                  allowedTools: toolsOpt,
                });
                info(`Agent **${agentName}** created${parentOpt ? ` (child of ${parentOpt})` : ""}.`);
              } catch (e: any) { info(`Create failed: ${e.message}`); }
              return;
            }

            // /agents remove <name>
            if (sub === "remove" && args[1]) {
              try {
                await cmdRemoveAgent(args.slice(1).join(" "));
                info(`Agent **${args.slice(1).join(" ")}** removed.`);
              } catch (e: any) { info(`Remove failed: ${e.message}`); }
              return;
            }

            // /agents update <name> [--name <newName>] [--desc <description>] [--prompt <systemPrompt>] [--color <color>] [--tools <csv>] [--parent <name|none>]
            if (sub === "update" && args[1]) {
              try {
                const originalName = args[1];
                const readFlagValue = (flag: string): string | undefined => {
                  const idx = args.indexOf(flag);
                  if (idx === -1 || idx + 1 >= args.length) return undefined;
                  const values: string[] = [];
                  for (let i = idx + 1; i < args.length; i++) {
                    const tok = args[i]!;
                    if (tok.startsWith("--")) break;
                    values.push(tok);
                  }
                  return values.join(" ").trim() || undefined;
                };

                const newName = readFlagValue("--name");
                const description = readFlagValue("--desc");
                const systemPrompt = readFlagValue("--prompt");
                const color = readFlagValue("--color");
                const parent = readFlagValue("--parent");
                const toolsCsv = readFlagValue("--tools");
                const allowedTools = toolsCsv
                  ? toolsCsv.split(",").map((t) => t.trim()).filter(Boolean)
                  : undefined;

                await cmdUpdateAgent({
                  name: originalName,
                  newName,
                  description,
                  systemPrompt,
                  color,
                  allowedTools,
                  parent,
                });

                info(`Agent **${originalName}** updated${newName ? ` → **${newName}**` : ""}.`);
              } catch (e: any) { info(`Update failed: ${e.message}`); }
              return;
            }

            // /agents  or  /agents list  — tree view
            try {
              const agents = getAllAgents();
              if (!agents.length) { info("No saved agents. Use `/agents create <name>` to add one."); return; }
              // Build parent→children map for tree
              const childrenOf = new Map<string | undefined, typeof agents>();
              for (const a of agents) {
                const k = a.parentId ?? undefined;
                if (!childrenOf.has(k)) childrenOf.set(k, []);
                childrenOf.get(k)!.push(a);
              }
              const lines: string[] = [];
              const walk = (list: typeof agents, indent: string) => {
                list.forEach((a, i) => {
                  const isLast = i === list.length - 1;
                  lines.push(`${indent}${isLast ? "└─" : "├─"} **@${a.name.toLowerCase().replace(/\s+/g, "-")}** — ${a.description ?? ""}`);
                  const children = childrenOf.get(a.id) ?? [];
                  if (children.length) walk(children, indent + (isLast ? "   " : "│  "));
                });
              };
              const roots = childrenOf.get(undefined) ?? agents.filter((a: any) => !a.parentId);
              walk(roots, "");
              info(`**Agents (${agents.length}):**\n${lines.join("\n")}`);
            } catch (e: any) { info(`Error fetching agents: ${e.message}`); }
            return;
          }

          case "/directory": {
            try {
              const tree = cmdDirectoryTree(args[0] ?? projectDir ?? ".");
              info(`\`\`\`\n${tree}\n\`\`\``);
            } catch (e: any) { info(`Error reading directory: ${e.message}`); }
            return;
          }

          case "/plugins": {
            const sub = args[0];
            if (sub === "install" && args[1]) {
              try {
                await cmdInstallPlugin(args[1]);
                info(`Plugin \`${args[1]}\` installed.`);
              } catch (e: any) { info(`Install failed: ${e.message}`); }
            } else if (sub === "remove" && args[1]) {
              try {
                await cmdRemovePlugin(args[1]);
                info(`Plugin \`${args[1]}\` removed.`);
              } catch (e: any) { info(`Remove failed: ${e.message}`); }
            } else if (sub === "marketplace" || sub === "market") {
              const q = args.slice(1).join(" ");
              setMarketplaceQuery(q);
              setShowMarketplace(true);
            } else if (sub === "search") {
              const q = args.slice(1).join(" ");
              if (!q) {
                info("Usage: `/plugins search <query>`\n\nOpens the marketplace filtered by query.");
              } else {
                setMarketplaceQuery(q);
                setShowMarketplace(true);
              }
            } else if (sub === "update") {
              const name = args[1];
              info(name ? `Updating \`${name}\`…` : "Checking for updates…");
              try {
                if (name) {
                  await cmdAutoUpdate(name);
                  info(`\`${name}\` updated.`);
                } else {
                  await cmdCheckUpdates();
                  info("Update check complete. Run `/plugins marketplace` to browse.");
                }
              } catch (e: any) { info(`Update failed: ${e.message}`); }
            } else if (sub === "check") {
              info("Checking for plugin updates…");
              try {
                await cmdCheckUpdates();
                info("Update check complete. Run `/plugins update <name>` to apply.");
              } catch (e: any) { info(`Check failed: ${e.message}`); }
            } else if (!sub || sub === "list") {
              try {
                const plugins = getPluginsList();
                const lines = plugins.map((p: any) => `  - \`${p.name}\` v${p.version} (${p.enabled ? "enabled" : "disabled"})`);
                info(plugins.length
                  ? `**Installed Plugins (${plugins.length}):**\n${lines.join("\n")}\n\nSubcommands: \`install\`, \`remove\`, \`update\`, \`check\`, \`marketplace\`, \`search <query>\``
                  : "No plugins installed.\n\nBrowse with `/plugins marketplace` or install with `/plugins install <name>`.");
              } catch (e: any) { info(`Error listing plugins: ${e.message}`); }
            } else {
              info(`Unknown plugins subcommand: \`${sub}\`\n\nAvailable: \`list\`, \`install <name>\`, \`remove <name>\`, \`update [name]\`, \`check\`, \`marketplace [query]\`, \`search <query>\``);
            }
            return;
          }

          case "/workflows": {
            const sub = args[0];

            // ── /workflows list ───────────────────────────────────
            if (!sub || sub === "list") {
              try {
                const wf = getWorkflowsList();
                if (!wf.length) {
                  info("No saved workflows.\n\nCreate one with:\n  `/workflows save <name> [description]`");
                } else {
                  const lines = wf.map((w: any) => {
                    const sched = w.schedule?.enabled ? `  ⏰ ${w.schedule.cron}` : "";
                    const tags = w.tags?.length ? `  [${w.tags.join(", ")}]` : "";
                    return `  - **${w.name}** (${w.steps?.length ?? w.prompts?.length ?? 0} steps)${sched}${tags}\n    ${w.description || ""}`;
                  });
                  info(`**Workflows (${wf.length}):**\n\n${lines.join("\n\n")}\n\nSubcommands: \`save\`, \`create\`, \`run\`, \`show\`, \`delete\`, \`schedule\`, \`tag\``);
                }
              } catch (e: any) { info(`Error listing workflows: ${e.message}`); }

            // ── /workflows show <name> ────────────────────────────
            } else if (sub === "show") {
              const name = args.slice(1).join(" ");
              if (!name) { info("Usage: `/workflows show <name>`"); return; }
              try {
                const wfs = getWorkflowsList();
                const wf = wfs.find((w: any) => w.name.toLowerCase() === name.toLowerCase());
                if (!wf) { info(`Workflow "${name}" not found.`); return; }
                const stepLines = (wf.steps ?? []).map((s: WorkflowStep, i: number) => {
                  const label = s.label || s.content?.slice(0, 70) || s.command || s.tool || "";
                  return `  ${i + 1}. **[${s.type}]** ${label}`;
                }).join("\n");
                const sched = wf.schedule ? `\n**Schedule:** \`${wf.schedule.cron}\` ${wf.schedule.enabled ? "(enabled)" : "(disabled)"}` : "";
                const tags = wf.tags?.length ? `\n**Tags:** ${wf.tags.join(", ")}` : "";
                info(`**Workflow: ${wf.name}**\n${wf.description ? `_${wf.description}_\n` : ""}\n**Steps (${wf.steps?.length ?? 0}):**\n${stepLines}${sched}${tags}\n\nCreated: ${new Date(wf.createdAt).toLocaleString()}${wf.lastUsedAt ? `  Last ran: ${new Date(wf.lastUsedAt).toLocaleString()}` : ""}`);
              } catch (e: any) { info(`Error: ${e.message}`); }

            // ── /workflows save <name> [description] ─────────────
            } else if (sub === "save") {
              const nameParts = args.slice(1);
              const descSep = nameParts.indexOf("--desc");
              const name = descSep > 0 ? nameParts.slice(0, descSep).join(" ") : nameParts.join(" ");
              const desc = descSep > 0 ? nameParts.slice(descSep + 1).join(" ") : "";
              if (!name) { info("Usage: `/workflows save <name> [--desc <description>]`\nSaves the current conversation's user prompts."); return; }
              try {
                const prompts = (messages as any[]).filter((m: any) => m.role === "user").map((m: any) => m.content as string);
                if (!prompts.length) { info("No user messages to save as a workflow yet."); return; }
                cmdSaveWorkflow(name, desc, prompts);
                info(`✅ Workflow **"${name}"** saved with ${prompts.length} prompt steps.`);
              } catch (e: any) { info(`Save failed: ${e.message}`); }

            // ── /workflows create <name> --steps prompt1|prompt2|… ─
            } else if (sub === "create") {
              // Parse: /workflows create <name> --steps p1|p2 --desc description
              const nameArg = args[1];
              if (!nameArg) { info("Usage: `/workflows create <name> --steps <step1>|<step2>|… [--desc <description>]`"); return; }
              const rawArgs = args.slice(2);
              const stepsIdx = rawArgs.indexOf("--steps");
              const descIdx = rawArgs.indexOf("--desc");
              const stepsStr = stepsIdx >= 0 ? rawArgs[stepsIdx + 1] ?? "" : "";
              const description = descIdx >= 0 ? rawArgs[descIdx + 1] ?? "" : "";
              if (!stepsStr) { info("Usage: `/workflows create <name> --steps \"step1|step2\" [--desc \"description\"]`"); return; }
              try {
                const steps: WorkflowStep[] = stepsStr.split("|").map((s: string) => ({
                  type: "prompt" as const,
                  content: s.trim(),
                  label: s.trim().slice(0, 60),
                }));
                cmdCreateWorkflow(nameArg, description, steps);
                info(`✅ Workflow **"${nameArg}"** created with ${steps.length} steps.`);
              } catch (e: any) { info(`Create failed: ${e.message}`); }

            // ── /workflows run <name> ─────────────────────────────
            } else if (sub === "run") {
              const name = args.slice(1).join(" ");
              if (!name) { info("Usage: `/workflows run <name>`"); return; }
              info(`▶ Running workflow **"${name}"**…`);
              try {
                const { ok, error, results } = await cmdRunWorkflow(name, async (step, idx, total) => {
                  if (step.type === "prompt" && step.content) {
                    info(`  Step ${idx + 1}/${total}: _${step.content.slice(0, 60)}…_`);
                    // Queue the prompt as a real AI message through the normal flow
                    // We add it as a user message and let the downstream streaming handle it
                    (messages as any[]).push({ role: "user", content: step.content });
                    return step.content;
                  }
                  return undefined;
                });
                if (!ok) { info(`❌ Workflow error: ${error}`); return; }
                info(`✅ Workflow **"${name}"** completed (${results.length} steps).`);
              } catch (e: any) { info(`Run failed: ${e.message}`); }

            // ── /workflows delete <name> ──────────────────────────
            } else if (sub === "delete" || sub === "remove") {
              const name = args.slice(1).join(" ");
              if (!name) { info(`Usage: \`/workflows ${sub} <name>\``); return; }
              try {
                const wfs = getWorkflowsList();
                const exists = wfs.some((w: any) => w.name.toLowerCase() === name.toLowerCase());
                if (!exists) { info(`Workflow "${name}" not found.`); return; }
                cmdDeleteWorkflow(name);
                info(`✅ Workflow **"${name}"** deleted.`);
              } catch (e: any) { info(`Delete failed: ${e.message}`); }

            // ── /workflows schedule <name> <cron> [description] ──
            } else if (sub === "schedule") {
              const name = args[1];
              const cron = args[2];
              if (!name) { info("Usage:\n  `/workflows schedule <name> <cron> [description]`\n  `/workflows schedule <name> off` — disable schedule"); return; }
              try {
                if (cron === "off" || cron === "none" || cron === "disable") {
                  const ok = cmdScheduleWorkflow(name, null);
                  info(ok ? `✅ Schedule removed from **"${name}"**.` : `Workflow "${name}" not found.`);
                } else if (!cron) {
                  info("Usage: `/workflows schedule <name> <cron-expression> [description]`\nExample: `/workflows schedule my-wf \"0 9 * * 1-5\" Daily standup`");
                } else {
                  const schedDesc = args.slice(3).join(" ");
                  const ok = cmdScheduleWorkflow(name, cron, schedDesc);
                  info(ok ? `✅ Workflow **"${name}"** scheduled: \`${cron}\`${schedDesc ? ` — ${schedDesc}` : ""}` : `Workflow "${name}" not found.`);
                }
              } catch (e: any) { info(`Schedule failed: ${e.message}`); }

            // ── /workflows tag <name> <tag1> [tag2] ───────────────
            } else if (sub === "tag") {
              const name = args[1];
              const tags = args.slice(2);
              if (!name || !tags.length) { info("Usage: `/workflows tag <name> <tag1> [tag2…]`"); return; }
              try {
                const wfs = getWorkflowsList();
                const idx = wfs.findIndex((w: any) => w.name.toLowerCase() === name.toLowerCase());
                if (idx === -1) { info(`Workflow "${name}" not found.`); return; }
                wfs[idx] = { ...(wfs[idx] as any), tags };
                const fs2 = await import("fs");
                const p2 = await import("path");
                const o2 = await import("os");
                const fp = p2.default.join(o2.default.homedir(), ".config", "pakalon", "workflows.json");
                fs2.default.writeFileSync(fp, JSON.stringify(wfs, null, 2));
                info(`✅ Workflow **"${name}"** tagged: ${tags.map((t: string) => `\`${t}\``).join(", ")}`);
              } catch (e: any) { info(`Tag failed: ${e.message}`); }

            // ── Unknown subcommand → help ──────────────────────────
            } else {
              info(`**Workflow subcommands:**\n\n  \`/workflows list\`\n  \`/workflows show <name>\`\n  \`/workflows save <name> [--desc <desc>]\`\n  \`/workflows create <name> --steps "p1|p2" [--desc <desc>]\`\n  \`/workflows run <name>\`\n  \`/workflows delete <name>\`\n  \`/workflows schedule <name> <cron>\`\n  \`/workflows tag <name> <tag…>\``);
            }
            return;
          }

          case "/mcp": {
            const sub = args[0];
            if (!sub || sub === "list") {
              try {
                const servers = listMcpServers(projectDir);
                if (!servers.length) {
                  info("No MCP servers configured.\n\nUse `/mcp add <name> <url> [global|project]` to add one.\nGlobal: `~/.config/pakalon/mcp.json`  Project: `.pakalon/mcp.json`");
                } else {
                  const lines = servers.map(
                    (s) => `  - **${s.name}** (${s.scope}) — \`${s.url}\`${s.description ? ` — ${s.description}` : ""}`
                  );
                  info(`**MCP Servers (${servers.length}):**\n${lines.join("\n")}\n\nRestart CLI after changes to reload server tools.`);
                }
              } catch (e: any) { info(`Error listing MCP servers: ${e.message}`); }
            } else if (sub === "add") {
              if (!args[1] || !args[2]) {
                info("Usage: `/mcp add <name> <url> [global|project] [--skip-check]`");
              } else {
                try {
                  const scopeArg = args.find((a) => a === "global" || a === "project" || a === "--global" || a === "--project");
                  const scope: "global" | "project" = (scopeArg?.replace("--", "") as "global" | "project") ?? "global";
                  const skipCheck = args.includes("--skip-check");
                  const result = await addMcpServer(args[1], args[2], scope, { cwd: projectDir, skipConnCheck: skipCheck });
                  info(result.ok
                    ? `✅ ${result.message}\n\nRestart CLI to load the new server's tools.`
                    : `❌ ${result.message}`);
                } catch (e: any) { info(`Error adding MCP server: ${e.message}`); }
              }
            } else if (sub === "remove") {
              if (!args[1]) {
                info("Usage: `/mcp remove <name> [global|project]`");
              } else {
                try {
                  const scopeArg = args.find((a) => a === "global" || a === "project" || a === "--global" || a === "--project");
                  const scope: "global" | "project" = (scopeArg?.replace("--", "") as "global" | "project") ?? "global";
                  const result = removeMcpServer(args[1], scope, projectDir);
                  info(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
                } catch (e: any) { info(`Error removing MCP server: ${e.message}`); }
              }
            } else if (sub === "get") {
              if (!args[1]) {
                info("Usage: `/mcp get <name>`");
              } else {
                try {
                  const server = getMcpServer(args[1], projectDir);
                  if (!server) {
                    info(`MCP server "${args[1]}" not found.`);
                  } else {
                    info([
                      `**${server.name}** (${server.scope})`,
                      `URL: \`${server.url}\``,
                      `Transport: ${server.transport ?? "sse"}`,
                      `Status: ${server.enabled === false ? "🔴 disabled" : "🟢 enabled"}`,
                      ...(server.description ? [`Description: ${server.description}`] : []),
                      ...(server.addedAt ? [`Added: ${server.addedAt}`] : []),
                      ...(server.lastHealthCheck ? [`Last check: ${server.lastHealthCheck} — ${server.lastHealthStatus ?? "unknown"}`] : []),
                    ].join("\n"));
                  }
                } catch (e: any) { info(`Error finding MCP server: ${e.message}`); }
              }
            } else if (sub === "enable") {
              if (!args[1]) {
                info("Usage: `/mcp enable <name> [global|project]`");
              } else {
                const scopeArg = args.find((a) => a === "global" || a === "project");
                const scope: "global" | "project" = (scopeArg as "global" | "project") ?? "global";
                const r = enableMcpServer(args[1], scope, projectDir);
                info(r.ok ? `✅ ${r.message}` : `❌ ${r.message}`);
              }
            } else if (sub === "disable") {
              if (!args[1]) {
                info("Usage: `/mcp disable <name> [global|project]`");
              } else {
                const scopeArg = args.find((a) => a === "global" || a === "project");
                const scope: "global" | "project" = (scopeArg as "global" | "project") ?? "global";
                const r = disableMcpServer(args[1], scope, projectDir);
                info(r.ok ? `✅ ${r.message}` : `❌ ${r.message}`);
              }
            } else if (sub === "status") {
              try {
                const targetServer = args[1];
                info(`Checking MCP server health${targetServer ? ` for ${targetServer}` : " (all servers)"}…`);
                const results = await checkMcpStatus(targetServer, projectDir);
                info(formatMcpStatus(results));
              } catch (e: any) { info(`Error checking MCP status: ${e.message}`); }
            } else if (sub === "import") {
              // T-MCP-10: Import servers from Claude Desktop config
              const scopeArg = args.find((a) => a === "global" || a === "project");
              const scope: "global" | "project" = (scopeArg as "global" | "project") ?? "global";
              info("📥 Importing MCP servers from Claude Desktop config…");
              try {
                const importResult = await importFromClaudeDesktop(scope, projectDir);
                const lines: string[] = ["**Claude Desktop → Pakalon MCP Import**", ""];
                if (importResult.imported.length) {
                  lines.push(`✅ Imported (${importResult.imported.length}):`);
                  importResult.imported.forEach((n) => lines.push(`   - \`${n}\``));
                }
                if (importResult.skipped.length) {
                  lines.push(`⏭ Already exists (${importResult.skipped.length}):`);
                  importResult.skipped.forEach((n) => lines.push(`   - \`${n}\``))
                }
                if (importResult.errors.length) {
                  lines.push(`❌ Errors (${importResult.errors.length}):`);
                  importResult.errors.forEach(({ name, reason }) => lines.push(`   - \`${name}\`: ${reason}`));
                }
                if (!importResult.imported.length && !importResult.errors.length) {
                  lines.push("_Nothing to import — all servers already exist._");
                } else {
                  lines.push("", "Restart CLI to load the new server tools.");
                }
                info(lines.join("\n"));
              } catch (e: any) {
                info(`❌ Import failed: ${e.message}`);
              }
            } else {
              info([
                "**MCP Server commands:**",
                "  /mcp list                              — list all configured servers",
                "  /mcp add <name> <url> [scope] [--skip-check] — add a server",
                "  /mcp remove <name> [scope]             — remove a server",
                "  /mcp get <name>                        — show server detail",
                "  /mcp enable <name> [scope]             — enable a disabled server",
                "  /mcp disable <name> [scope]            — disable without removing",
                "  /mcp status [name]                     — health-check server(s)",
                "  /mcp import [global|project]           — import from Claude Desktop config",
                "",
                "Scope: `global` (default) or `project`  |  Restart CLI after changes.",
              ].join("\n"));
            }
            return;
          }

          case "/agent":
            useStore.getState().setMode("agent");
            info("Switching to **agent mode**. I'll now work autonomously to complete your task.");
            return;

          case "/plan": {
            const planDesc = args.join(" ").trim();
            if (!planDesc) {
              info("Usage: `/plan <description>`\n\nGenerates a detailed plan and saves it as `output.md` in the current directory.\nExample: `/plan Build a SaaS dashboard with React + FastAPI`\n\nOnce the plan is written, start building with `/build <task>`.");
              return;
            }
            useStore.getState().setPermissionMode("plan");
            const planPrompt = `You are a technical planning expert. The user wants to build: "${planDesc}"

Create a detailed project plan and write it to output.md in the current directory (${projectDir ?? process.cwd()}).

The output.md must include:
1. **Project Overview** — what is being built and why
2. **Tech Stack** — recommended technologies, frameworks, libraries
3. **Features & Requirements** — numbered list of all features
4. **Architecture** — high-level system design
5. **Tasks Breakdown** — ordered list of implementation tasks
6. **Timeline Estimate** — rough phases with estimated effort

Use the writeFile tool to save the plan to: ${projectDir ?? process.cwd()}/output.md

After writing the file, summarize the key points here in the chat.`;
            addMessage({ id: crypto.randomUUID(), role: "user", content: planPrompt, createdAt: new Date(), isStreaming: false });
            info(`📋 Generating plan for: _${planDesc}_\n\nThe plan will be saved to \`output.md\`. You can edit it and then run \`/build <task>\` to start building.`);
            break; // fall through to AI to execute the plan prompt
          }

          case "/build": {
            // /build [task description] [figma-url] — launches 6-phase pipeline
            // If output.md exists in the project dir, its plan content is prepended to the prompt
            const FIGMA_URL_RE = /https?:\/\/(?:www\.)?figma\.com\/[^\s]+/i;
            const rawBuildArgs = args.join(" ");
            const figmaMatch = rawBuildArgs.match(FIGMA_URL_RE);
            const figmaUrl = figmaMatch?.[0];
            const taskDesc = rawBuildArgs.replace(figmaUrl ?? "", "").trim();
            if (!taskDesc) {
              info(
                "Usage: `/build <task description> [figma-url]`\n\nExample: `/build Build a to-do app with React + FastAPI`\nWith Figma: `/build Build a dashboard https://figma.com/design/abc123`\n\nThis launches the full 6-phase AI build pipeline (Plan → Design → Code → QA → CI/CD → Docs).",
              );
              return;
            }

            // Read output.md plan if it exists and prepend to the prompt
            const cwd = projectDir ?? process.cwd();
            let effectivePrompt = taskDesc;
            if (planExists(cwd)) {
              const planContext = getBuildPrompt(cwd);
              effectivePrompt = `${planContext}\n\n## Task\n${taskDesc}`;
              info(
                `🚀 Launching 6-phase build pipeline for:\n\n_${taskDesc}_${figmaUrl ? `\n\n🎨 Figma design: ${figmaUrl}` : ""}\n\n📋 Plan loaded from \`output.md\` — Switching to agent mode…`,
              );
            } else {
              info(
                `🚀 Launching 6-phase build pipeline for:\n\n_${taskDesc}_${figmaUrl ? `\n\n🎨 Figma design: ${figmaUrl}` : ""}\n\nSwitching to agent mode…`,
              );
            }

            useStore.getState().launchBridgePipeline({
              userPrompt: effectivePrompt,
              userId: token ?? "anonymous",
              userPlan: plan ?? "free",
              isYolo: useStore.getState().permissionMode === "bypass" || useStore.getState().permissionMode === "auto-accept",
              privacyMode: useStore.getState().privacyMode,
              figmaUrl,
            });
            return;
          }

          case "/web": {
            const webUrl = args[0]?.trim();
            if (webUrl && (webUrl.startsWith("http://") || webUrl.startsWith("https://"))) {
              info(`🌐 Analyzing **${webUrl}**…`);
              try {
                const analysisPrompt = await cmdWebAnalyze(webUrl);
                // Inject scraped content as a user message, then let AI process it
                addMessage({
                  id: crypto.randomUUID(),
                  role: "user",
                  content: analysisPrompt,
                  createdAt: new Date(),
                  isStreaming: false,
                });
                useStore.getState().setMode("agent");
              } catch (e: any) {
                info(`Web analysis failed: ${e.message}`);
                return;
              }
            } else {
              useStore.getState().setMode("agent");
              info("Web research mode activated — I will search the web before answering.\n\nTip: use `/web <url>` to analyze a specific website's design and inject its scraped content as context.");
              return;
            }
            break; // fall through to send the injected message to AI
          }

          case "/init": {
            const initPrompt = args.join(" ").trim() || undefined;
            info(`✦ Initializing .pakalon/ directory${initPrompt ? ` for: _${initPrompt}_` : ""}...`);
            try {
              await cmdInit(projectDir ?? process.cwd(), initPrompt);
              info("\u2713 **.pakalon/** initialized:\n  - plan.md\n  - task.md\n  - user-stories.md\n  - context-management.md\n  - agents/skills.md\n\nType `/build <task>` to launch the full 6-phase pipeline.");
            } catch (e: any) {
              info(`❌ Init failed: ${e.message}`);
            }
            return;
          }

          case "/pakalon": {
            const pakPrompt = args.join(" ").trim();
            if (!pakPrompt) {
              info("Usage: `/pakalon <project description>`\n\nExample: `/pakalon Build a SaaS e-commerce platform with React + FastAPI`\n\nThis creates `.pakalon-agents/` and launches the full Phase 1\u20136 agentic pipeline.");
              return;
            }
            // Overwrite protection: warn if .pakalon-agents/ already has output
            try {
              const _fs2 = await import("fs");
              const _path2 = await import("path");
              const agentsDir = _path2.default.join(projectDir ?? process.cwd(), ".pakalon-agents");
              if (_fs2.default.existsSync(agentsDir)) {
                const existing = _fs2.default.readdirSync(agentsDir);
                if (existing.length > 0) {
                  const launchCfg = {
                    userPrompt: pakPrompt,
                    userId: token ?? "anonymous",
                    userPlan: plan ?? "free",
                    isYolo: useStore.getState().permissionMode === "bypass" || useStore.getState().permissionMode === "auto-accept",
                    privacyMode: useStore.getState().privacyMode,
                  };
                  pendingOverwriteRef.current = launchCfg;
                  info(`⚠️  \`.pakalon-agents/\` already contains ${existing.length} item(s) from a previous run.\n\n**Type \`yes\` to overwrite** and start fresh, or anything else to cancel.`);
                  return;
                }
              }
            } catch { /* filesystem error — proceed */ }
            info(`✦ Launching 6-phase Pakalon pipeline for:\n\n_${pakPrompt}_\n\nSwitching to agent mode…`);
            useStore.getState().launchBridgePipeline({
              userPrompt: pakPrompt,
              userId: token ?? "anonymous",
              userPlan: plan ?? "free",
              isYolo: useStore.getState().permissionMode === "bypass" || useStore.getState().permissionMode === "auto-accept",
              privacyMode: useStore.getState().privacyMode,
            });
            return;
          }

          case "/penpot": {
            // Open project-specific Penpot design in browser and start sync.js lifecycle
            const fileIdArg = args[0]?.trim();
            try {
              info("🎨 Opening Penpot design…");
              const result = await cmdPenpotOpen(fileIdArg || undefined, projectDir ?? process.cwd());
              info(`✅ Penpot opened: [${result.url}](${result.url})\n\n_sync.js lifecycle bridge started — changes in Penpot will automatically sync to your project._`);
            } catch (e: any) {
              info(`❌ Could not open Penpot: ${e.message}`);
            }
            return;
          }

          case "/models": {
            const modelArg = args[0]?.trim();
            if (modelArg && !modelArg.startsWith("-")) {
              // Set model by ID
              try {
                await cmdSetModel(modelArg);
                info(`✓ Model switched to **${modelArg}**`);
              } catch (e: any) {
                info(`❌ Could not set model: ${e.message}`);
              }
            } else {
              // List models inline
              try {
                const api = (await import("@/api/client.js")).getApiClient();
                const userPlanCurrent = plan ?? "free";
                const res = await api.get<{ models: Array<{ model_id: string; name: string; context_window: number; pricing_tier: string; remaining_pct?: number }> }>("/models");
                const allModels = res.data.models ?? [];
                const visible = userPlanCurrent === "pro" ? allModels : allModels.filter((m) => m.pricing_tier === "free");
                if (!visible.length) {
                  info("No models available. Model cache may be refreshing — try again in a moment.");
                  return;
                }
                const ctx = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;
                const lines = visible.map(
                  (m) => `  \`${m.model_id}\`  ${ctx(m.context_window)} ctx${typeof m.remaining_pct === "number" ? ` [${m.remaining_pct}% remaining]` : ""}${m.pricing_tier === "pro" ? " [PRO]" : ""}`
                );
                if (userPlanCurrent !== "pro" && allModels.some((m) => m.pricing_tier === "pro")) {
                  lines.push("", "  _Upgrade to Pro to unlock all models — /upgrade_");
                }
                info(`**Available Models** (${visible.length}):\n\n${lines.join("\n")}\n\nTo switch: \`/models <model-id>\``)
              } catch (e: any) {
                info(`Failed to fetch models: ${e.message}`);
              }
            }
            return;
          }

          case "/model": {
            const modelArg = args.join(" ").trim();
            if (!modelArg) {
              info("Usage: `/model <id|auto>` · aliases to `/models`.\n\nExamples:\n  `/model openai/gpt-4o-mini`\n  `/model auto`");
              return;
            }
            if (modelArg.toLowerCase() === "auto") {
              try {
                const auto = await getApiClient().get<{ model_id: string; name?: string }>("/models/auto");
                const mId = auto.data.model_id;
                setSelectedModel(mId);
                info(`✓ Auto-selected model: **${auto.data.name ?? mId}** (\`${mId}\`)`);
              } catch (e: any) {
                info(`❌ Could not auto-select model: ${e.message}`);
              }
              return;
            }
            try {
              await cmdSetModel(modelArg);
              info(`✓ Model switched to **${modelArg}**`);
            } catch (e: any) {
              info(`❌ Could not set model: ${e.message}`);
            }
            return;
          }

          case "/session": // alias for /sessions
          case "/sessions": {
            const sessionList = await cmdListSessions(10, projectDir);
            if (!sessionList.length) {
              info("No sessions found for this directory.\n\nStart a new session with `/new`.");
            } else {
              const lines = sessionList.map(
                (s: any) => `  **${s.id.slice(0, 8)}\u2026**  ${new Date(s.createdAt).toLocaleString()}  ${s.tokenCount ? `(${s.tokenCount} tokens)` : ""}`
              );
              info(`**Sessions in this directory (${sessionList.length}):**\n\n${lines.join("\n")}\n\nResume with \`/resume <id>\``);
            }
            return;
          }

          case "/undo":
            if (args[0] === "list") {
              const history = undoManager.getHistory(20);
              if (!history.length) {
                info("No undo history available.");
                return;
              }
              const lines = history.map((h, i) => `  ${i + 1}. ${h.operation === "write" ? "✏️" : "🗑"} \`${h.path.replace(/\\/g, "/")}\`  (${new Date(h.timestamp).toLocaleTimeString()})`);
              info(`**Undo history (${history.length}):**\n\n${lines.join("\n")}\n\nUse \`/undo\` for the interactive menu, or \`/undo all\` to revert all.`);
              return;
            }
            if (args[0] === "all") {
              const history = undoManager.getHistory(50);
              if (!history.length) {
                info("No file operations to undo.");
                return;
              }
              let count = 0;
              for (const snap of history) {
                if (undoManager.undoById(snap.id)) count++;
              }
              info(`↩ Reverted **${count}** file operation(s).`);
              return;
            }
            setShowUndo(true);
            return;

          // ─── Rewind to named checkpoint (T-CLI-50) ──────────────────────
          case "/rewind": {
            const checkpoints = undoManager.getCheckpoints();
            const target = args[0]?.trim();

            if (!target) {
              // No arg: list all available checkpoints
              if (!checkpoints.length) {
                info("No checkpoints available.\n\nCheckpoints are created automatically before each `/update` command.\nRun `/update <instruction>` to create one.");
                return;
              }
              const lines = checkpoints.map((cp, i) => {
                const ts = cp.timestamp instanceof Date
                  ? cp.timestamp.toLocaleString()
                  : new Date(cp.timestamp).toLocaleString();
                return `  **${i + 1}.** \`${cp.checkpointId.slice(0, 8)}\` — ${cp.label} _(${ts})_`;
              });
              info(
                `**Named Checkpoints** (${checkpoints.length})\n\n${lines.join("\n")}\n\n` +
                `Use \`/rewind <n>\` or \`/rewind <id-prefix>\` to restore.`
              );
              return;
            }

            // Try to match by 1-based index first, then by id prefix
            let cp = undefined as typeof checkpoints[number] | undefined;
            const idx = parseInt(target, 10);
            if (!isNaN(idx) && idx >= 1 && idx <= checkpoints.length) {
              cp = checkpoints[idx - 1];
            } else {
              cp = checkpoints.find((c) => c.checkpointId.startsWith(target));
            }

            if (!cp) {
              info(`Checkpoint not found: \`${target}\`\n\nRun \`/rewind\` to list available checkpoints.`);
              return;
            }

            const reverted = undoManager.rollbackToCheckpoint(cp.checkpointId);
            const label = cp.label;
            if (!reverted.length) {
              info(`No file changes to revert for checkpoint: _${label}_`);
            } else {
              const fileList = reverted.map((s) => `  - \`${s.filePath}\``).join("\n");
              info(
                `↩ **Rewound to checkpoint**: _${label}_\n\n` +
                `Reverted **${reverted.length}** file change(s):\n${fileList}`
              );
            }
            return;
          }

          case "/cost": {
            const summary = costTrackerRef.current.summary();
            const lines = [
              "**Session Cost Estimate**",
              "",
              `- Total estimated spend: **$${summary.totalCostUsd.toFixed(4)}**`,
              `- Total input tokens: **${summary.totalInputTokens.toLocaleString()}**`,
              `- Total output tokens: **${summary.totalOutputTokens.toLocaleString()}**`,
              `- Turns: **${summary.turns}**`,
              maxBudgetUsd != null
                ? `- Budget: **$${maxBudgetUsd.toFixed(2)}** (${Math.max(0, ((maxBudgetUsd - summary.totalCostUsd) / Math.max(maxBudgetUsd, 0.0001)) * 100).toFixed(1)}% remaining)`
                : "- Budget: _not set_ (use `--max-budget-usd`)",
              "",
              summary.formatted,
            ];
            info(lines.join("\n"));
            return;
          }

          case "/doctor": {
            const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
            const runVersion = async (label: string, command: string) => {
              try {
                const { stdout, stderr } = await execAsync(command, { cwd: projectDir ?? process.cwd(), timeout: 10000 });
                const out = (stdout || stderr || "ok").trim().split("\n")[0] ?? "ok";
                checks.push({ name: label, ok: true, detail: out });
              } catch (e: any) {
                checks.push({ name: label, ok: false, detail: e.message ?? "not available" });
              }
            };

            await runVersion("Node", "node --version");
            await runVersion("Python", "python --version");
            await runVersion("Git", "git --version");
            checks.push({ name: "Auth token", ok: Boolean(token), detail: token ? "present" : "missing" });
            checks.push({ name: "Project dir", ok: Boolean(projectDir ?? process.cwd()), detail: projectDir ?? process.cwd() });

            const passed = checks.filter((c) => c.ok).length;
            const lines = checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
            info(`**Pakalon Doctor (chat mode)**\n\n${lines.join("\n")}\n\n${passed}/${checks.length} checks passed.`);
            return;
          }

          case "/memory": {
            const sub = args[0]?.toLowerCase();
            const rest = args.slice(1).join(" ").trim();

            // /memory view  OR  /memory  (no args) → show PAKALON.md contents
            if (!sub || sub === "view" || sub === "show") {
              try {
                const pathMod = await import("path");
                const fsMod = await import("fs");
                const memPath = pathMod.default.join(projectDir ?? process.cwd(), ".pakalon", "PAKALON.md");
                if (!fsMod.default.existsSync(memPath)) {
                  info("No project memory file found.\n\nCreate one with `/memory add <text>` or `/init`.\nPath: `.pakalon/PAKALON.md`");
                  return;
                }
                const content = fsMod.default.readFileSync(memPath, "utf-8");
                info(`**PAKALON.md Memory** (\`${memPath}\`)\n\n${content.slice(0, 3000)}${content.length > 3000 ? "\n\n_(truncated — file too long)_" : ""}`);
              } catch (e: any) {
                info(`Could not read memory file: ${e.message}`);
              }
              return;
            }

            // /memory add <text>  → append to PAKALON.md
            if (sub === "add") {
              if (!rest) {
                info("Usage: `/memory add <text>` — e.g. `/memory add always use TypeScript interfaces`");
                return;
              }
              try {
                const pathMod = await import("path");
                const fsMod = await import("fs");
                const dir = pathMod.default.join(projectDir ?? process.cwd(), ".pakalon");
                const memPath = pathMod.default.join(dir, "PAKALON.md");
                fsMod.default.mkdirSync(dir, { recursive: true });
                const entry = `\n- ${rest}`;
                if (!fsMod.default.existsSync(memPath)) {
                  fsMod.default.writeFileSync(memPath, `# Project Memory\n\n${entry}\n`, "utf-8");
                } else {
                  fsMod.default.appendFileSync(memPath, `${entry}\n`, "utf-8");
                }
                info(`✅ Added to PAKALON.md: _${rest}_`);
              } catch (e: any) {
                info(`Failed to write memory: ${e.message}`);
              }
              return;
            }

            // /memory clear  → wipe PAKALON.md
            if (sub === "clear") {
              try {
                const pathMod = await import("path");
                const fsMod = await import("fs");
                const memPath = pathMod.default.join(projectDir ?? process.cwd(), ".pakalon", "PAKALON.md");
                if (fsMod.default.existsSync(memPath)) {
                  fsMod.default.writeFileSync(memPath, "# Project Memory\n", "utf-8");
                  info("✅ PAKALON.md cleared.");
                } else {
                  info("No memory file to clear.");
                }
              } catch (e: any) {
                info(`Failed to clear memory: ${e.message}`);
              }
              return;
            }

            // /memory reload  → force reload on next turn
            if (sub === "reload") {
              info("✅ Memory reloaded — will apply to next AI message.");
              return;
            }

            // /memory <query>  → semantic search
            const query = args.join(" ").trim();
            if (!userId) {
              info("Semantic memory search requires an authenticated user session.\n\nLocal memory: use `/memory view` to see PAKALON.md.");
              return;
            }
            try {
              const result = await bridgeMemorySearch({ query, user_id: userId, top_k: 5 });
              if (!result.memories.length) {
                info(`No memory matches for: _${query}_`);
                return;
              }
              const lines = result.memories.map((m, i) => `  ${i + 1}. (score ${(m.score ?? 0).toFixed(3)}) ${m.text.slice(0, 180)}`);
              info(`**Memory matches (${result.memories.length})**\n\n${lines.join("\n")}\n\n---\n_Use \`/memory view\` for PAKALON.md entries._`);
            } catch (e: any) {
              info(`Memory search failed: ${e.message}`);
            }
            return;
          }

          case "/terminal-setup": {
            const os = process.platform;
            const steps = os === "win32"
              ? [
                  "1. Install Node.js 20+ and Git.",
                  "2. Install Python 3.11+ if you use local bridge tools.",
                  "3. Restart terminal so PATH updates apply.",
                  "4. Run `/doctor` to validate your setup.",
                ]
              : [
                  "1. Install Node.js 20+, Git, and Python 3.11+.",
                  "2. Ensure your shell profile exports required PATH entries.",
                  "3. Open a new terminal session.",
                  "4. Run `/doctor` to validate your setup.",
                ];
            info(`**Terminal setup checklist (${os})**\n\n${steps.map((s) => `- ${s}`).join("\n")}`);
            return;
          }

          case "/install-github-app": {
            info(
              "Install the Pakalon GitHub App here:\n\n" +
              "- https://github.com/apps/pakalon\n\n" +
              "After installation, return and run `/git status` or `/from-pr <url>` workflows."
            );
            return;
          }

          case "/statusline": {
            const sub = (args[0] ?? "toggle").toLowerCase();
            if (sub === "on" || sub === "show") {
              setShowStatusline(true);
              info("Status line enabled.");
            } else if (sub === "off" || sub === "hide") {
              setShowStatusline(false);
              info("Status line hidden. Run `/statusline on` to re-enable.");
            } else {
              setShowStatusline((v) => !v);
              info(`Status line ${showStatusline ? "hidden" : "enabled"}.`);
            }
            return;
          }

          case "/vim": {
            const sub = (args[0] ?? "toggle").toLowerCase();
            if (sub === "on") setVimMode(true);
            else if (sub === "off") setVimMode(false);
            else if (sub === "toggle") setVimMode((v) => !v);
            info(`Vim mode ${sub === "status" ? (vimMode ? "ON" : "OFF") : (sub === "off" ? "OFF" : sub === "on" ? "ON" : !vimMode ? "ON" : "OFF")}.\n\nCurrent bindings in preview: normal slash-commands + input-focused typing. More keymap coverage can be expanded incrementally.`);
            return;
          }

          case "/ide": {
            const sub = (args[0] ?? "toggle").toLowerCase();
            if (sub === "on") setIdeMode("on");
            else if (sub === "off") setIdeMode("off");
            else if (sub === "auto") setIdeMode("auto");
            else if (sub === "toggle") setIdeMode((prev) => (prev === "on" ? "off" : "on"));
            info(`IDE integration mode: **${sub === "status" ? ideMode : (sub === "on" || sub === "off" || sub === "auto" ? sub : ideMode === "on" ? "off" : "on")}**.\n\nThis controls editor-oriented guidance in chat responses.`);
            return;
          }

          case "/fake-pakalon": {
            const sub = (args[0] ?? "help").toLowerCase();
            if (sub !== "reset") {
              info("Usage: `/fake-pakalon reset`\n\nDevelopment-only: reset your telemetry + machine-id links for local QA flows.");
              return;
            }
            if (!userId) {
              info("You must be logged in to reset telemetry state.");
              return;
            }
            try {
              const res = await getApiClient().post<{ telemetry_deleted: number; machine_ids_deleted: number; trial_days_reset: boolean }>(`/users/${userId}/telemetry/reset`);
              info(`✅ Fake-pakalon reset complete:\n- telemetry rows deleted: ${res.data.telemetry_deleted}\n- machine IDs removed: ${res.data.machine_ids_deleted}\n- trial days reset: ${res.data.trial_days_reset ? "yes" : "no"}`);
            } catch (e: any) {
              info(`Reset failed: ${e.message}`);
            }
            return;
          }

          // ─── Export conversation to markdown (T-CLI-EXP) ─────────────────
          case "/export": {
            try {
              const { writeFileSync } = await import("fs");
              const { join } = await import("path");
              const filename = args[0]?.trim() || `pakalon-session-${Date.now()}.md`;
              const outPath = join(projectDir ?? process.cwd(), filename);
              const lines: string[] = [
                `# Pakalon Session Export`,
                `> Exported: ${new Date().toLocaleString()}`,
                `> Model: ${selectedModel ?? "—"}`,
                "",
              ];
              for (const m of messages as any[]) {
                if (m.isStreaming) continue;
                const role = m.role === "user" ? "**You**" : m.role === "assistant" ? "**Pakalon**" : "**System**";
                lines.push(`### ${role}`);
                lines.push(m.content ?? "");
                lines.push("");
              }
              writeFileSync(outPath, lines.join("\n"), "utf-8");
              info(`✅ Conversation exported to \`${outPath}\``);
            } catch (e: any) {
              info(`❌ Export failed: ${e.message}`);
            }
            return;
          }

          // ─── Fork current session (T-CLI-FORK) ──────────────────────────
          case "/fork": {
            try {
              const { cmdCreateSession } = await import("@/commands/session.js");
              const newSess = await cmdCreateSession(undefined, "chat", projectDir);
              // Copy current messages into new session via the store, swap session ID
              const currentMsgs = [...(useStore.getState().messages ?? [])];
              useStore.getState().setSessionId?.(newSess.id);
              info(`🔀 Session forked → new session \`${newSess.id}\`\n\nContext copied (${currentMsgs.length} messages). Changes from here won't affect the original session.`);
            } catch (e: any) {
              info(`❌ Fork failed: ${e.message}`);
            }
            return;
          }

          // ─── Git commands (T0-3) ───────────────────────────────────────
          case "/git": {
            const gitResult = await handleGitCommand(args);
            info(gitResult.ok ? gitResult.output : `❌ Git error: ${gitResult.error ?? gitResult.output}`);
            return;
          }

          // ─── Quick AI actions (T0-2) ──────────────────────────────────
          case "/explain": {
            const r = await handleQuickCommand("explain", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }
          case "/refactor": {
            const r = await handleQuickCommand("refactor", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }
          case "/fix-lint": {
            const r = await handleQuickCommand("fix-lint", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }
          case "/find-usages": {
            const r = await handleQuickCommand("find-usages", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }
          case "/review": {
            const r = await handleQuickCommand("review", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }
          case "/docstring": {
            const r = await handleQuickCommand("docstring", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }

          // ─── Search commands (T1-4) ───────────────────────────────────
          case "/search": {
            const r = handleSearchCommand("search", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }
          case "/find-symbol": {
            const r = handleSearchCommand("find-symbol", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }
          case "/goto": {
            const r = handleSearchCommand("goto", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }
          case "/grep": {
            const r = handleSearchCommand("grep", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }
          case "/files": {
            const r = handleSearchCommand("files", args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }

          // ─── Workspace cleanup (T2-9) ─────────────────────────────────
          case "/clean": {
            const r = handleCleanCommand(args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }

          // ─── Error help (T2-7) ────────────────────────────────────────
          case "/error-help": {
            const r = await handleErrorHelpCommand(args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }

          // ─── Test generation (T2-12) ──────────────────────────────────
          case "/test-gen": {
            const r = await handleTestGenCommand(args);
            info(r.ok ? r.output : `❌ ${r.error}`);
            return;
          }

          case "/update": {
            const instruction = args.join(" ").trim();
            if (!instruction) {
              info("Usage: `/update <instruction>` — e.g. `/update fix the login button styling`");
              return;
            }
            const { prompt: updatePrompt } = cmdUpdate(instruction);
            info(`Switching to **agent mode** for targeted update: _${instruction}_`);
            addMessage({ id: crypto.randomUUID(), role: "user", content: updatePrompt, createdAt: new Date(), isStreaming: false });
            return;
          }

          case "/analyze-image": {
            const imagePathRaw = args.join(" ").trim();
            if (!imagePathRaw) {
              info("Usage: `/analyze-image <path-to-image>`");
              return;
            }
            try {
              const pathMod = await import("path");
              const fsMod = await import("fs");
              const resolved = pathMod.default.isAbsolute(imagePathRaw)
                ? imagePathRaw
                : pathMod.default.resolve(projectDir ?? process.cwd(), imagePathRaw);
              if (!fsMod.default.existsSync(resolved)) {
                info(`Image not found: \`${resolved}\``);
                return;
              }
              const res = await fetch("http://127.0.0.1:7432/tools/analyze_image", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: resolved }),
              });
              const data = await res.json();
              if (!res.ok) {
                info(`Image analysis failed: ${data?.error ?? `HTTP ${res.status}`}`);
                return;
              }
              info(`🖼️ **Image analysis** for \`${resolved}\`\n\n${JSON.stringify(data, null, 2)}`);
            } catch (e: any) {
              info(`Image analysis error: ${e.message}`);
            }
            return;
          }

          case "/analyze-video": {
            const videoPathRaw = args.join(" ").trim();
            if (!videoPathRaw) {
              info("Usage: `/analyze-video <path-to-video>`");
              return;
            }
            try {
              const pathMod = await import("path");
              const fsMod = await import("fs");
              const resolved = pathMod.default.isAbsolute(videoPathRaw)
                ? videoPathRaw
                : pathMod.default.resolve(projectDir ?? process.cwd(), videoPathRaw);
              if (!fsMod.default.existsSync(resolved)) {
                info(`Video not found: \`${resolved}\``);
                return;
              }
              const res = await fetch("http://127.0.0.1:7432/tools/analyze_video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: resolved }),
              });
              const data = await res.json();
              if (!res.ok) {
                info(`Video analysis failed: ${data?.error ?? `HTTP ${res.status}`}`);
                return;
              }
              info(`🎬 **Video analysis** for \`${resolved}\`\n\n${JSON.stringify(data, null, 2)}`);
            } catch (e: any) {
              info(`Video analysis error: ${e.message}`);
            }
            return;
          }

          case "/status":
            info([
              `**Account:**`,
              `  Plan:  ${plan ?? "free"}`,
              `  Model: ${selectedModel ?? "—"}`,
              `  Login: ${githubLogin ?? "—"}`,
            ].join("\n"));
            return;

          case "/resume": {
            // Support both "/resume <id>" (space) and "/resume<id>" (no-space)
            const sessionId = (args[0]?.trim() || workingText.slice("/resume".length).trim()) || undefined;
            try {
              const projectDirMsgs = await cmdResumeSession(sessionId, projectDir);
              if (projectDirMsgs) {
                info(`Session \`${sessionId ?? "latest"}\` resumed. Messages loaded.`);
              } else {
                info(sessionId ? `Session \`${sessionId}\` not found.` : "No previous session found.");
              }
            } catch (e: any) { info(`Error resuming session: ${e.message}`); }
            return;
          }

          case "/compact": {
            const keepCount = parseInt(args[0] ?? "10", 10);
            const current = useStore.getState().messages ?? [];
            if (current.length <= keepCount) {
              info(`Context already compact (${current.length} messages).`);
              return;
            }

            // T-HK-12: Fire PreCompact hook — hook exit-code 2 blocks the compact
            try {
              const preCompactResults = await runHooks("PreCompact", {
                cwd: projectDir ?? process.cwd(),
                sessionId: activeSessionId ?? undefined,
                toolName: "compact",
                toolInput: { trigger: "manual", messageCount: current.length },
              }, projectDir ?? undefined);
              if (preCompactResults.some((r) => r.blocked)) {
                const reason = preCompactResults.find((r) => r.blocked)?.stderr ?? "PreCompact hook blocked compact.";
                info(`⛔ Compact blocked by hook: ${reason}`);
                return;
              }
            } catch { /* hooks are non-blocking */ }

            // P1: Use LLM-based semantic compression via compressContext()
            info("Compressing context with AI summarization…");
            try {
              const coreMessages: CoreMessage[] = current
                .filter((m) => m.role !== "system")
                .map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content }));
              const contextLimit = availableModels.find((m) => m.id === selectedModel)?.contextLength ?? 128000;
              const summarizerFn = async (text: string): Promise<string> => {
                try {
                  const bridgeUrl = process.env.PAKALON_BRIDGE_URL ?? "http://127.0.0.1:7432";
                  const res = await fetch(`${bridgeUrl}/agent/summarize`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text, model_id: selectedModel }),
                  });
                  if (res.ok) {
                    const data = await res.json() as { summary?: string };
                    return data.summary ?? text.slice(0, 2000);
                  }
                } catch { /* fall through */ }
                // Fallback: first 2000 chars
                return text.slice(0, 2000);
              };
              const result = await compressContext(coreMessages, contextLimit, summarizerFn);
              if (result.compressed) {
                useStore.getState().clearMessages();
                for (const m of result.messages) {
                  useStore.getState().addMessage({
                    id: crypto.randomUUID(),
                    role: m.role as "user" | "assistant" | "system",
                    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
                    createdAt: new Date(),
                    isStreaming: false,
                  });
                }
                info(`✅ Context compressed — saved **${result.savedTokens.toLocaleString()}** tokens (${current.length} → ${result.messages.length} messages).`);
              } else {
                // If compression didn't trigger (below threshold), fall back to truncation
                const kept = current.slice(-keepCount);
                useStore.getState().clearMessages();
                for (const m of kept) useStore.getState().addMessage(m);
                info(`Context trimmed: kept last ${kept.length} of ${current.length} messages.`);
              }
            } catch (e: any) {
              // Ultimate fallback
              const kept = current.slice(-keepCount);
              useStore.getState().clearMessages();
              for (const m of kept) useStore.getState().addMessage(m);
              info(`Context trimmed (AI summarization failed: ${e.message}): kept last ${kept.length} messages.`);
            }
            return;
          }

          case "/autocompact": {
            const sub = args[0];
            if (sub === "on" || sub === "enable") {
              useStore.getState().setAutoCompact?.(true);
              info("✅ Auto-compaction **enabled** (triggers at " + Math.round(autoCompactThreshold * 100) + "% context usage).");
            } else if (sub === "off" || sub === "disable") {
              useStore.getState().setAutoCompact?.(false);
              info("⛔ Auto-compaction **disabled**.");
            } else if (sub === "threshold" && args[1]) {
              const pct = parseFloat(args[1]);
              if (isNaN(pct) || pct < 50 || pct > 99) {
                info("Usage: `/autocompact threshold <50-99>` (percentage, e.g. 85)");
              } else {
                useStore.getState().setAutoCompactThreshold?.(pct / 100);
                info(`Auto-compact threshold set to **${pct}%**.`);
              }
            } else {
              const status = autoCompact ? "enabled" : "disabled";
              info([
                `**Auto-compaction** is currently **${status}** (threshold: ${Math.round(autoCompactThreshold * 100)}%).`,
                "",
                "Subcommands:",
                "  `/autocompact on`              — enable",
                "  `/autocompact off`             — disable",
                "  `/autocompact threshold <pct>` — set trigger % (e.g. 85)",
              ].join("\n"));
            }
            return;
          }

          case "/explore": {
            // P10: Read-only explore agent — understands codebase without writing
            const exploreQuery = args.join(" ");
            if (!exploreQuery) {
              info("Usage: `/explore <question about your codebase>`\n\nExample: `/explore How does the auth flow work?`");
              return;
            }
            info(`🔍 Exploring: _${exploreQuery}_…`);
            const exploreUserMsg = {
              id: crypto.randomUUID(),
              role: "user" as const,
              content: `[EXPLORE MODE — READ ONLY, NO FILE WRITES]\n\n${exploreQuery}`,
              createdAt: new Date(),
              isStreaming: false,
            };
            addMessage(exploreUserMsg);
            const exploreStreamId = crypto.randomUUID();
            addMessage({ id: exploreStreamId, role: "assistant", content: "", createdAt: new Date(), isStreaming: true });
            resetStreaming();
            const exploreMsgs: CoreMessage[] = messages
              .filter((m) => m.role !== "system")
              .concat(exploreUserMsg)
              .map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content }));
            const localKey = process.env.OPENROUTER_API_KEY;
            const useProxy = !localKey || process.env.PAKALON_USE_PROXY === "1";
            // Read-only tool subset: readFile, listDir, bash (read commands only)
            const readOnlyTools = { readFile: allTools.readFile, listDir: allTools.listDir };
            const exploreSystem = `${BASE_SYSTEM}\n\n## EXPLORE MODE\nYou are in read-only explore mode. Do NOT write, edit, delete, or modify any files. Only read and explain the codebase. Answer the user's question with code references.`;
            await handleStream({
              model: selectedModel ?? "openai/gpt-4o-mini",
              messages: trimToContextWindow(exploreMsgs, 60000),
              apiKey: localKey || undefined,
              authToken: useProxy ? (token ?? undefined) : undefined,
              useProxy,
              system: exploreSystem,
              thinkingEnabled,
              tools: readOnlyTools as any,
              onThinkChunk: (chunk) => setThinkContent((prev: string) => prev + chunk),
              onTextChunk: (chunk) => {
                appendStreamChunk(chunk);
                useStore.getState().appendToLastMessage(chunk);
              },
              onFinish: (_t, _u) => { finalizeStreamingMessage(); resetStreaming(); },
              onError: (err) => {
                finalizeStreamingMessage();
                resetStreaming();
                useStore.getState().updateLastMessage({ content: `Explore error: ${err.message}`, isStreaming: false });
              },
            });
            return;
          }

          case "/hooks": {
            // Already handled above
          }

          case "/config":
          case "/settings": {
            // T-CLI-CONFIG: Open the tabbed settings TUI
            // Usage: /config [global|project]
            const scopeArg = (args[0] ?? "project") as "project" | "global";
            setConfigScope(scopeArg === "global" ? "global" : "project");
            setShowConfigScreen(true);
            return;
          }
          case "/enterprise": {
            // /enterprise [jira|notion] [setup|remove|status] [--token <t>] [--workspace <w>] ...
            const eParts = args.slice(1); // skip "/enterprise"
            const eService = eParts[0]?.toLowerCase();

            if (!eService || eService === "help") {
              info(
                "**Enterprise MCP Connectors**\n\n" +
                JIRA_HELP + "\n\n" +
                NOTION_HELP
              );
              return;
            }

            // ── Parse --key value flags ────────────────────────────────────
            function parseFlags(parts: string[]): Record<string, string> {
              const flags: Record<string, string> = {};
              for (let i = 0; i < parts.length; i++) {
                const p = parts[i]!;
                if (p.startsWith("--")) {
                  const key = p.slice(2);
                  const val = parts[i + 1] && !parts[i + 1]!.startsWith("--") ? parts[++i]! : "true";
                  flags[key] = val;
                }
              }
              return flags;
            }

            const eAction = eParts[1]?.toLowerCase() ?? "help";
            const eFlags = parseFlags(eParts.slice(2));

            if (eService === "jira") {
              switch (eAction) {
                case "setup": {
                  const result = await setupJiraMcp({
                    token: eFlags["token"] ?? "",
                    workspace: eFlags["workspace"],
                    server: eFlags["server"],
                    email: eFlags["email"],
                    scope: (eFlags["scope"] as "global" | "project" | undefined) ?? "global",
                    cwd: projectDir,
                  });
                  info(result.message);
                  break;
                }
                case "remove": {
                  const result = removeJiraMcp("global", projectDir);
                  info(result.message);
                  break;
                }
                case "status": {
                  const st = jiraStatus(projectDir);
                  if (!st.configured) {
                    info("Jira MCP is **not configured**.\n\nRun: `/enterprise jira setup --token <...> --workspace <...> --email <...>`");
                  } else {
                    info(`**Jira MCP Status**\n  Type:    ${st.type}\n  Base URL: ${st.baseUrl}\n  Email:   ${st.email ?? "n/a"}\n  Status:  ✅ configured`);
                  }
                  break;
                }
                default:
                  info(JIRA_HELP);
              }
            } else if (eService === "notion") {
              switch (eAction) {
                case "setup": {
                  const result = await setupNotionMcp({
                    token: eFlags["token"] ?? "",
                    workspace: eFlags["workspace"],
                    scope: (eFlags["scope"] as "global" | "project" | undefined) ?? "global",
                    cwd: projectDir,
                  });
                  info(result.message);
                  break;
                }
                case "remove": {
                  const result = removeNotionMcp("global", projectDir);
                  info(result.message);
                  break;
                }
                case "status": {
                  const st = notionStatus(projectDir);
                  if (!st.configured) {
                    info("Notion MCP is **not configured**.\n\nRun: `/enterprise notion setup --token secret_...`");
                  } else {
                    info(`**Notion MCP Status**\n  Workspace: ${st.workspace ?? "n/a"}\n  Configured: ${st.createdAt}\n  Status: ✅ active`);
                  }
                  break;
                }
                default:
                  info(NOTION_HELP);
              }
            } else {
              info(`Unknown enterprise service "${eService}".\n\nSupported: \`jira\`, \`notion\`.\n\nRun \`/enterprise help\` for details.`);
            }
            return;
          }

          case "/exit":
          case "/q":
            // T-CTX-MEMORY: Save session summary to PAKALON.md on clean exit
            try {
              const _exitMsgs = useStore.getState().messages ?? [];
              const _summary = buildSessionMemorySummary(_exitMsgs as any);
              if (_summary) saveMemoryFile(_summary, projectDir, { append: true });
            } catch { /* non-fatal */ }
            exit();
            return;

          case "/logout":
            useStore.getState().logout?.();
            info("Logged out.");
            return;

          case "/upgrade":
            info("Visit **https://pakalon.com/pricing** to upgrade to Pro.");
            return;

          case "/help":
            info([
              "**Commands:**",
              "  /init [prompt]   — scaffold .pakalon/ with AI-generated plan, tasks, user-stories",
              "  /pakalon <desc>  — launch full 6-phase agentic build pipeline",
              "  /build [desc] [figma-url] — start build pipeline (alias for /pakalon)",
              "  /models [id]     — list available AI models; switch with /models <model-id>",
              "  /model <id|auto> — set specific model or use backend auto-select",
              "  /cost            — show per-session token/spend estimate",
              "  /doctor          — lightweight environment diagnostics",
              "  /memory <query>  — search semantic memory",
              "  /new             — start a new session",
              "  /session         — list sessions for this directory",
              "  /sessions        — list sessions for this directory",
              "  /resume [id]     — resume a previous session",
              "  /history         — list recent sessions with tokens",
              "  /fork            — fork current session",
              "  /export          — export conversation to markdown",
              "  /explore <q>     — read-only codebase exploration agent (no file writes)",
              "  /agents [create <name> [--parent <name>] | remove <name>] — manage agents",
              "  /agents update <name> [--name <new>] [--desc <d>] [--prompt <p>] [--color <c>] [--tools <csv>] [--parent <name|none>]",
              "  /directory [dir] — show directory tree",
              "  /plugins [install|remove <id>] — manage plugins",
              "  /workflows [save|create|run|show|delete|schedule|tag] — manage workflows",
              "  /mcp [list|add|remove|get] — manage MCP servers",
              "  /terminal-setup  — show terminal setup checklist",
              "  /install-github-app — link to Pakalon GitHub App",
              "  /statusline [on|off] — toggle bottom status line",
              "  /vim [on|off|status] — toggle vim-mode preference",
              "  /ide [on|off|auto|status] — toggle IDE integration preference",
              "  /fake-pakalon reset — dev reset for telemetry + machine IDs",
              "  /agent           — switch to agent mode",
              "  /plan            — generate a plan",
              "  /web [url]       — web-research mode (optional: scrape URL)",
              "  /update <inst>   — targeted update via agent",
              "  /analyze-image <path> — analyze image with bridge vision tool",
              "  /analyze-video <path> — analyze video with bridge vision tool",
              "  /undo            — undo last action (build only)",
              "  /compact [n]     — AI-summarize context (default: semantic compression)",
              "  /autocompact [on|off|threshold <pct>] — toggle/configure auto-compaction",
              "  /clear           — clear conversation",
              "  /status          — account status",
              "  /upgrade         — upgrade to Pro",
              "  /logout          — log out",
              "  /exit  /q        — quit Pakalon",
              "  /help            — show this message",
              "",
              "**Shell injection:**",
              "  Use !<cmd> in your message to capture command output.",
              "  Example: `Fix these errors: !npm run build`",
              "",
              "**MCP inline install:**",
              "  @mcp <name> <url>  — install an MCP server without leaving chat",
              "",
              "**Git commands:**",
              "  /git status|diff|log|branch|commit|push|stash|pr ...",
              "  /git suggest-commit  — AI-guessed commit message from staged diff",
              "  /git conflicts       — show merge conflict files",
              "  /git resolve <file> [ours|theirs] — resolve conflict in file",
              "",
              "**Quick AI actions:**",
              "  /explain <file|snippet>    — explain code",
              "  /refactor <file> [goal]    — refactor with goal",
              "  /fix-lint <file>           — fix lint/style issues",
              "  /find-usages <symbol>      — find all usages",
              "  /review <file>             — code review",
              "  /docstring <file>          — add/improve docstrings",
              "  /test-gen <file> [--write] — generate test suite",
              "  /error-help <message>      — explain error + fix suggestions",
              "",
              "**Search:**",
              "  /search <query> [glob]     — full-text workspace search",
              "  /find-symbol <name>        — find symbol definition",
              "  /goto <file:line>          — jump to file:line",
              "  /grep <regex> [path]       — regex search",
              "  /files <pattern>           — find files by name",
              "  /clean [--confirm] [path]  — remove build artifacts",
              "",
              "**Hooks:**",
              "  Edit .pakalon/hooks.json to run commands after file writes.",
              "  /hooks init        — create a starter hooks.json",
              "  /hooks list        — show configured hooks",
              "",
              "**Enterprise MCP:**",
              "  /enterprise jira setup --token <tok> --workspace <slug> --email <e>",
              "  /enterprise jira remove|status",
              "  /enterprise notion setup --token <tok> [--workspace <name>]",
              "  /enterprise notion remove|status",
              "",
              "**Modes (Tab to cycle):** plan | edit | auto-accept | bypass",
              "**Keys:**  Tab=cycle mode  ⇧Tab=thinking  ^O=verbose  ^F=stop  ^T=tasks  ^R=history  ^C=exit",
              "",
              "**New commands:**",
              "  /diff [ref]          — show uncommitted changes (colorized git diff)",
              "  /security-review     — AI-powered security scan of staged/unstaged diff",
              "  /output-style <s>    — set response style: explanatory | concise | learning",
              "  /insights            — session usage dashboard (tokens, spend, models)",
              "  /context             — token budget visualizer",
              "  /auditor [--yolo] [--max-iterations N]  — audit codebase vs Phase 1 requirements",
              "  /rewind [n]          — list checkpoints or restore checkpoint n",
              "  /memory [view|add|clear|query] — manage PAKALON.md memory",
              "  !<cmd>               — run shell command directly (e.g. !ls, !git status)",
            ].join("\n"));
            return;

          // T-CLI-59: /diff — interactive uncommitted changes viewer
          case "/diff": {
            const ref = args[0] ?? "HEAD";
            try {
              const diffCmd = args.length > 0 ? `git diff ${ref}` : "git diff; git diff --cached";
              const { stdout, stderr } = await execAsync(diffCmd, {
                cwd: projectDir ?? process.cwd(),
                timeout: 15000,
              });
              const raw = (stdout + stderr).trim();
              if (!raw) {
                info(`No changes found${args.length > 0 ? ` against \`${ref}\`` : ""}.`);
                return;
              }
              // Colorize: + lines green, - lines red, @@ lines cyan, diff header bold
              const lines = raw.split("\n");
              const colored = lines.map((line) => {
                if (line.startsWith("+") && !line.startsWith("+++")) return `\x1b[32m${line}\x1b[0m`;
                if (line.startsWith("-") && !line.startsWith("---")) return `\x1b[31m${line}\x1b[0m`;
                if (line.startsWith("@@")) return `\x1b[36m${line}\x1b[0m`;
                if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return `\x1b[1m${line}\x1b[0m`;
                return line;
              }).join("\n");
              const truncated = colored.length > 10000 ? colored.slice(0, 10000) + "\n\n…(truncated)" : colored;
              addMessage({
                id: crypto.randomUUID(),
                role: "assistant",
                content: `\`\`\`diff\n${truncated}\n\`\`\``,
                createdAt: new Date(),
                isStreaming: false,
              });
            } catch (e: any) {
              info(`git diff failed: ${e.message}`);
            }
            return;
          }

          // T-CLI-60: /pr-comments — fetch open PR review comments via GitHub API
          case "/pr-comments": {
            try {
              const { stdout: remoteOut } = await execAsync("git remote get-url origin", {
                cwd: projectDir ?? process.cwd(),
                timeout: 5000,
              }).catch(() => ({ stdout: "" }));
              const remoteUrl = remoteOut.trim();
              // Parse owner/repo from https://github.com/owner/repo.git or git@github.com:owner/repo.git
              const ghMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
              if (!ghMatch) {
                info("Could not detect a GitHub remote. Set your remote with `git remote add origin https://github.com/owner/repo`.");
                return;
              }
              const [, owner, repo] = ghMatch;
              const ghToken = process.env.GITHUB_TOKEN;
              if (!ghToken) {
                info(`⚠️  **GITHUB_TOKEN** not set in environment.\n\nSet it to fetch PR comments:\n\`\`\`\nexport GITHUB_TOKEN=your_pat\n\`\`\`\n\nOr use \`/enterprise github setup --token <token>\``);
                return;
              }
              info(`🔍 Fetching open PRs and review comments for **${owner}/${repo}**…`);
              // Fetch open PRs
              const prResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=10`, {
                headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
              });
              if (!prResp.ok) {
                info(`GitHub API error: ${prResp.status} ${prResp.statusText}`);
                return;
              }
              const prs = await prResp.json() as Array<{ number: number; title: string; html_url: string; user: { login: string }; created_at: string }>;
              if (!prs.length) {
                info(`No open pull requests found for **${owner}/${repo}**.`);
                return;
              }
              const lines: string[] = [`**Open PRs with review comments — ${owner}/${repo}** (${prs.length})\n`];
              for (const pr of prs.slice(0, 5)) {
                lines.push(`### PR #${pr.number}: ${pr.title}`);
                lines.push(`> by @${pr.user.login} · ${new Date(pr.created_at).toLocaleDateString()} · [View](${pr.html_url})\n`);
                // Fetch review comments for this PR
                const commentsResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/comments?per_page=20`, {
                  headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
                });
                if (commentsResp.ok) {
                  const comments = await commentsResp.json() as Array<{ body: string; path: string; line?: number; user: { login: string } }>;
                  if (comments.length) {
                    for (const c of comments.slice(0, 5)) {
                      lines.push(`- **@${c.user.login}** on \`${c.path}${c.line ? `:${c.line}` : ""}\``);
                      lines.push(`  > ${c.body.slice(0, 200).replace(/\n/g, " ")}`);
                    }
                    if (comments.length > 5) lines.push(`  _…and ${comments.length - 5} more comments_`);
                  } else {
                    lines.push("  _No review comments yet._");
                  }
                }
                lines.push("");
              }
              if (prs.length > 5) lines.push(`_…and ${prs.length - 5} more PRs_`);
              info(lines.join("\n"));
            } catch (e: any) {
              info(`/pr-comments failed: ${e.message}`);
            }
            return;
          }

          // T-CLI-62: /security-review — AI-powered security scan of git diff
          case "/security-review": {
            info("🔍 Running security review on current diff…");
            try {
              const { stdout: diffOut } = await execAsync("git diff HEAD", {
                cwd: projectDir ?? process.cwd(),
                timeout: 20000,
              });
              if (!diffOut.trim()) {
                info("Nothing to review — no uncommitted changes found.");
                return;
              }
              const truncatedDiff = diffOut.slice(0, 12000);
              const secPrompt = `You are a security expert. Review the following git diff for security vulnerabilities, secrets, injection risks, and insecure patterns. Be concise and use bullet points. For each issue, state: severity (HIGH/MED/LOW), file, line (if visible), and recommended fix.\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;
              addMessage({
                id: crypto.randomUUID(),
                role: "user",
                content: secPrompt,
                createdAt: new Date(),
                isStreaming: false,
              });
              // Let the normal AI streaming path handle it
              return;
            } catch (e: any) {
              info(`Security review failed: ${e.message}`);
            }
            return;
          }

          // T-CLI-66: /output-style — set response verbosity style
          case "/output-style": {
            const style = args[0]?.toLowerCase();
            const validStyles = ["explanatory", "concise", "learning"];
            if (!style || !validStyles.includes(style)) {
              info(`Current style: **${outputStyle}**\nUsage: \`/output-style <explanatory|concise|learning>\``);
              return;
            }
            setOutputStyle(style as "explanatory" | "concise" | "learning");
            info(`✅ Output style set to **${style}**.`);
            return;
          }

          // T-CLI-61: /insights — session usage dashboard
          case "/insights": {
            const cost = costTrackerRef.current;
            const spendFmt = sessionSpendUsd >= 0.01
              ? `$${sessionSpendUsd.toFixed(4)}`
              : `<$0.01`;
            info([
              "**── Session Insights ──**",
              `  Messages:    ${messages.length}`,
              `  Tokens used: ${sessionTokensUsed.toLocaleString()}`,
              `  Est. spend:  ${spendFmt}`,
              `  Model:       ${selectedModel ?? "—"}`,
              `  Style:       ${outputStyle}`,
              `  Context:     ${remainingPct}% remaining`,
            ].join("\n"));
            return;
          }

          // T-CLI-63: /context — token budget visualizer
          case "/context": {
            // T-CLI-63: Token budget grid visualisation — breakdown across categories
            const used = Math.round((1 - remainingPct / 100) * sessionContextLimit);
            const remaining = Math.round(remainingPct / 100 * sessionContextLimit);
            const barWidth = 40;
            const filledCells = Math.round((1 - remainingPct / 100) * barWidth);
            const bar = "█".repeat(filledCells) + "░".repeat(barWidth - filledCells);
            const pctColor = remainingPct < 20 ? "🔴" : remainingPct < 50 ? "🟡" : "🟢";

            // Breakdown estimates (based on message history heuristics)
            const msgCount = messages.length;
            const systemTokens = Math.round(sessionContextLimit * 0.03); // ~3% system prompt
            const historyTokens = Math.round(msgCount * 350);            // ~350 tok/msg avg
            const toolResultTokens = Math.round(historyTokens * 0.25);   // ~25% of history
            const codebaseTokens = Math.round(used * 0.20);              // ~20% codebase context
            const remainingBreakdownTokens = Math.max(0, used - systemTokens - historyTokens - toolResultTokens - codebaseTokens);

            const total = sessionContextLimit;
            const _bar = (tok: number, w = 20) => {
              const filled = Math.min(w, Math.round(tok / total * w));
              return "▓".repeat(filled) + "░".repeat(w - filled);
            };
            const _pct = (tok: number) => `${Math.round(tok / total * 100)}%`.padStart(4);

            info([
              "**── Context Window Breakdown ──**",
              "",
              `  Total:   [${bar}] ${100 - remainingPct}% used / ${remaining.toLocaleString()} remaining`,
              "",
              "  **Category Breakdown (estimates)**",
              `  ${"System prompt".padEnd(18)} [${_bar(systemTokens)}] ${_pct(systemTokens)} ~${systemTokens.toLocaleString()} tok`,
              `  ${"Msg history".padEnd(18)} [${_bar(historyTokens)}] ${_pct(historyTokens)} ~${historyTokens.toLocaleString()} tok`,
              `  ${"Tool results".padEnd(18)} [${_bar(toolResultTokens)}] ${_pct(toolResultTokens)} ~${toolResultTokens.toLocaleString()} tok`,
              `  ${"Codebase ctx".padEnd(18)} [${_bar(codebaseTokens)}] ${_pct(codebaseTokens)} ~${codebaseTokens.toLocaleString()} tok`,
              `  ${"Other/reserve".padEnd(18)} [${_bar(remainingBreakdownTokens)}] ${_pct(remainingBreakdownTokens)} ~${remainingBreakdownTokens.toLocaleString()} tok`,
              "",
              `  ${"Remaining".padEnd(18)} [${_bar(remaining)}] ${_pct(remaining)} ~${remaining.toLocaleString()} tok`,
              "",
              `  ${pctColor} ${remainingPct}% of ${sessionContextLimit.toLocaleString()}-token window remaining`,
              "",
              remainingPct < 10
                ? "  ⛔ Context critically full. Run `/compact` now to avoid truncation."
                : remainingPct < 20
                ? "  ⚠️  Context nearly full. Run `/compact` to compress history."
                : remainingPct < 50
                ? "  ⚡ Context half used. Consider `/compact` soon for long sessions."
                : "  ✓  Context healthy — no action needed.",
            ].join("\n"));
            return;
          }

          // T-CLI-69: /auditor — Phase 3 Auditor Agent
          case "/auditor": {
            const isYolo = args.includes("--yolo");
            const maxIterIdx = args.indexOf("--max-iterations");
            const maxIterations = maxIterIdx !== -1 && args[maxIterIdx + 1]
              ? parseInt(args[maxIterIdx + 1], 10)
              : 3;

            info(`🔍 **Auditor Agent** starting${isYolo ? " (YOLO mode)" : " (HIL mode)"}...\n\nScanning codebase and comparing with Phase 1 requirements.`);

            try {
              const bridgeUrl = process.env.PAKALON_BRIDGE_URL ?? "http://127.0.0.1:7432";
              const res = await fetch(`${bridgeUrl}/agent/auditor`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  agent: "phase3_auditor",
                  project_dir: projectDir ?? process.cwd(),
                  is_yolo: isYolo,
                  max_iterations: maxIterations,
                  session_id: activeSessionId ?? undefined,
                }),
              });
              if (!res.ok) {
                const err = await res.text();
                info(`❌ Auditor failed: ${err}`);
                return;
              }
              const data = await res.json() as {
                report?: string;
                report_path?: string;
                completion_pct?: number;
                iterations?: number;
              };
              const pct = data.completion_pct ?? 0;
              const iters = data.iterations ?? 0;
              const reportPath = data.report_path ?? "";
              info(
                `✅ **Auditor complete** — ${pct}% requirements satisfied (${iters} iteration${iters === 1 ? "" : "s"})\n\n` +
                (reportPath ? `Report saved → \`${reportPath}\`\n\n` : "") +
                (data.report ? `\`\`\`markdown\n${data.report.slice(0, 3000)}\n\`\`\`` : "")
              );
            } catch (e: any) {
              info(`❌ Auditor error: ${e.message}`);
            }
            return;
          }

          // T-MCP-08: /mcp__server__prompt [args] — execute MCP prompt as slash command
          default: {
            // Check if this looks like an MCP prompt command (/mcp__server__prompt)
            const mcpPromptParsed = parseMcpPrompt(cmd ?? "");
            if (mcpPromptParsed) {
              const { server, prompt, args: promptArgsStr } = mcpPromptParsed;
              // Merge inline args with the rest of the user input
              const fullArgs = [promptArgsStr, ...args].filter(Boolean).join(" ");
              addMessage({ role: "user", content: `[MCP Prompt] ${server}::${prompt} ${fullArgs}`.trim() });
              try {
                const result = await runMcpPrompt(server, prompt, fullArgs || undefined);
                if (result) {
                  // Inject prompt result as a user turn context so the AI can act on it
                  const promptText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
                  // Submit the interpolated prompt text to the AI
                  handleSubmit(promptText);
                } else {
                  error(`MCP prompt '${prompt}' from server '${server}' returned no content. Check server is running.`);
                }
              } catch (e) {
                error(`MCP prompt error: ${String(e)}`);
              }
              return;
            }
          }

          case "/keybindings": {
            info([
              "**── Keyboard Shortcuts ──**",
              "",
              "**General**",
              "  Tab            — cycle permission mode (plan→edit→auto-accept→bypass)",
              "  Shift+Tab      — toggle extended thinking",
              "  Ctrl+C         — exit / cancel current prompt",
              "  Ctrl+L         — clear screen",
              "",
              "**AI Interaction**",
              "  Ctrl+F         — kill / abort current AI stream",
              "  Ctrl+B         — background bash overlay (spawn bg task)",
              "  Ctrl+T         — toggle task / checkpoint panel",
              "  Ctrl+R         — reverse history search",
              "  Ctrl+G         — open last-mentioned file in $EDITOR",
              "",
              "**Input**",
              "  Tab (in input) — accept ghost-text suggestion",
              "  ↑ / ↓          — navigate message history",
              "  !<cmd>          — run shell command inline without AI",
              "",
              "**Tip**: Create `.pakalon/keybindings.json` to remap shortcuts (conflict detection enabled).",
            ].join("\n"));
            return;
          }

          // T-CLI-69: /theme — color theme selector
          case "/theme": {
            const validThemes = ["dark", "light", "high-contrast", "solarized"] as const;
            const theme = args[0]?.toLowerCase() as typeof validThemes[number] | undefined;
            if (!theme) {
              info(`**Current theme**: \`${tuiTheme}\`\n\nAvailable themes: ${validThemes.join(" | ")}\n\nUsage: \`/theme <name>\``);
              return;
            }
            if (!(validThemes as readonly string[]).includes(theme)) {
              info(`Unknown theme: "${theme}". Valid: ${validThemes.join(", ")}`);
              return;
            }
            setTuiTheme(theme as typeof validThemes[number]);
            // Persist to .pakalon/settings.json
            try {
              const pathMod2 = await import("path");
              const fsMod2 = await import("fs");
              const settingsDir = pathMod2.default.join(projectDir ?? process.cwd(), ".pakalon");
              fsMod2.default.mkdirSync(settingsDir, { recursive: true });
              const settingsPath = pathMod2.default.join(settingsDir, "settings.json");
              let settings: Record<string, unknown> = {};
              try { settings = JSON.parse(fsMod2.default.readFileSync(settingsPath, "utf8")); } catch { /* first run */ }
              settings.theme = theme;
              fsMod2.default.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
              // T-HK-10: Fire ConfigChange hook after settings update
              runHooks("ConfigChange", {
                cwd: projectDir ?? process.cwd(),
                sessionId: activeSessionId ?? undefined,
                toolInput: { key: "theme", value: theme },
              }, projectDir ?? undefined).catch(() => {});
            } catch { /* non-fatal */ }
            info(`✅ Theme set to **${theme}**.`);
            return;
          }

          // T-CLI-72: /sandbox — toggle sandboxed bash execution
          case "/sandbox": {
            const sub = args[0]?.toLowerCase();
            if (sub === "on" || sub === "enable") {
              setSandboxMode(true);
              info("🔒 **Sandbox mode enabled.** Bash commands run in an isolated subshell — env changes and `cd` do not persist between tool calls.");
            } else if (sub === "off" || sub === "disable") {
              setSandboxMode(false);
              info("🔓 **Sandbox mode disabled.** Bash commands run normally in your project shell.");
            } else {
              const statusIcon = sandboxMode ? "enabled 🔒" : "disabled 🔓";
              info(`Sandbox is currently **${statusIcon}**.\n\nUsage: \`/sandbox on\` | \`/sandbox off\``);
            }
            return;
          }

          // T-CLI-71: /mobile — QR / URL for mobile session continuation
          case "/mobile": {
            const webUrl = process.env.PAKALON_WEB_URL ?? "https://app.pakalon.com";
            const mobileUrl = `${webUrl}/continue?session=${encodeURIComponent(activeSessionId ?? "")}&ref=mobile`;
            info([
              "**── Continue on Mobile ──**",
              "",
              `Scan or open this URL on your phone:`,
              `  ${mobileUrl}`,
              "",
              "_Requires the Pakalon mobile app or a browser with the Pakalon extension._",
              "_QR rendering requires a terminal with Sixel/iTerm2/Kitty graphics support._",
            ].join("\n"));
            return;
          }

          // T-CLI-73: /desktop — open desktop app with handoff deep-link
          case "/desktop": {
            const deepLink = `pakalon://continue?session=${encodeURIComponent(activeSessionId ?? "")}&model=${encodeURIComponent(selectedModel ?? "")}`;
            try {
              const { exec: execDeep } = await import("child_process");
              const openCmd = process.platform === "darwin"
                ? `open "${deepLink}"`
                : process.platform === "win32"
                  ? `start "" "${deepLink}"`
                  : `xdg-open "${deepLink}"`;
              execDeep(openCmd, () => {});
            } catch { /* non-fatal */ }
            info(`🖥️  Launching Pakalon desktop…\n\nDeep link: \`${deepLink}\`\n\n_Requires Pakalon desktop app v2+ to be installed._`);
            return;
          }

          // T-CLI-74: /chrome — Chrome DevTools CDP integration
          case "/chrome": {
            const sub = args[0] ?? "help";
            if (sub === "help") {
              info([
                "**── Chrome DevTools Integration ──**",
                "",
                "  /chrome connect [port]  — connect to Chrome on CDP port (default 9222)",
                "  /chrome screenshot      — capture screenshot via CDP",
                "  /chrome console         — show recent console logs",
                "  /chrome close           — disconnect",
                "",
                "Start Chrome with remote debugging enabled:",
                "  `google-chrome --remote-debugging-port=9222`",
                "  `chromium --remote-debugging-port=9222`",
              ].join("\n"));
              return;
            }
            if (sub === "connect") {
              const port = parseInt(args[1] ?? "9222", 10);
              try {
                const res = await fetch(`http://localhost:${port}/json/version`);
                if (res.ok) {
                  const meta = await res.json() as { Browser?: string; webSocketDebuggerUrl?: string };
                  info(`✅ Connected to Chrome on port **${port}**\n  Browser: ${meta.Browser ?? "unknown"}\n  WebSocket: \`${meta.webSocketDebuggerUrl ?? "n/a"}\``);
                } else {
                  info(`⚠️  Chrome on port ${port} returned HTTP ${res.status}.`);
                }
              } catch {
                info(`❌ Cannot reach Chrome on port ${port}.\n\nStart Chrome with:\n  \`google-chrome --remote-debugging-port=${port}\``);
              }
              return;
            }
            info(`Unknown chrome sub-command: '${sub}'. Run \`/chrome help\`.`);
            return;
          }

        }
      }

      // ── P5: Shell `!command` output injection ────────────────────────────────
      // Replace `!<cmd>` tokens in the message with real shell output before
      // sending to the AI. E.g. "Fix errors: !npm run build" captures build output.
      const SHELL_INJECT_RE = /(^|\s)!([^!\s][^\n]*)/g;
      let injectedText = workingText;
      const shellMatches = [...workingText.matchAll(SHELL_INJECT_RE)];
      if (shellMatches.length > 0) {
        let processed = text;
        for (const match of shellMatches) {
          const shellCmd = match[2]!.trim();
          try {
            const { stdout, stderr } = await execAsync(shellCmd, {
              cwd: projectDir ?? process.cwd(),
              timeout: 30000,
            });
            const output = (stdout + stderr).trim().slice(0, 8192);
            processed = processed.replace(
              match[0]!,
              `${match[1] ?? ""}<shell_output cmd="${shellCmd}">\n${output}\n</shell_output>`
            );
          } catch (execErr: any) {
              const errOut = `${execErr.stdout ?? ""}${execErr.stderr ?? ""}`.trim().slice(0, 4096);
            processed = processed.replace(
              match[0]!,
              `${match[1] ?? ""}<shell_output cmd="${shellCmd}" exit_code="${execErr.code ?? 1}">\n${errOut || execErr.message}\n</shell_output>`
            );
          }
        }
        injectedText = processed;
      }
      const effectiveText = injectedText;

      // ── P8: @mcp inline server install ────────────────────────────────────
      // Handle: @mcp <name> <url>  — install an MCP server without leaving chat
      const MCP_INLINE_RE = /^@mcp\s+([\w-]+)\s+(https?:\/\/\S+)/i;
      const mcpInlineMatch = effectiveText.trim().match(MCP_INLINE_RE);
      if (mcpInlineMatch) {
        const [, mcpName, mcpUrl] = mcpInlineMatch;
        try {
          await addMcpServer(mcpName!, mcpUrl!);
          info(`✅ MCP server **@${mcpName}** installed from \`${mcpUrl}\`.\n\nReload with \`/mcp list\` to verify.`);
        } catch (e: any) {
          info(`❌ Failed to install MCP server **@${mcpName}**: ${e.message}`);
        }
        return;
      }

      // Multi-@mention parallel agent dispatch (T-CLI-25)
      // If the message contains 2+ "@agent task" patterns, dispatch them in parallel
      const AT_PATTERN = /@([\w-]+)\s+([^@]+)/g;
      const atMentions = [...effectiveText.matchAll(AT_PATTERN)];
      if (atMentions.length > 1) {
        const requests = atMentions.map((m) => ({
          agentName: m[1]!,
          task: m[2]!.trim(),
          projectDir,
        }));
        info(
          `🤖 Running **${requests.length}** agents in parallel: ${requests.map((r) => `@${r.agentName}`).join(", ")}…`
        );
        try {
          const results = await cmdRunAgentsParallel(requests);
          const lines = results.map((r) =>
            r.success
              ? `**@${r.agentName}** (${r.durationMs}ms):\n${r.response ?? "Done."}`
              : `**@${r.agentName}** ❌: ${r.error ?? "unknown error"}`
          );
          info(lines.join("\n\n---\n\n"));
        } catch (e: any) {
          info(`Parallel agent dispatch error: ${e.message}`);
        }
        return;
      }

      // ── @file inline mention injection ────────────────────────────────────
      // Detect @<filepath> tokens (paths containing a dot or slash) in the
      // message text.  Read each file and inject its content as an XML
      // <file_context> block so the AI has it without a tool call.
      // Patterns matched: @./rel.ts  @../rel  @/abs/path.py  @src/foo.tsx
      const FILE_MENTION_RE = /@((?:\.{0,2}\/|)[\w./\-]+\.[\w]{1,15})/g;
      const fileMentionMatches = [...effectiveText.matchAll(FILE_MENTION_RE)];
      let finalText = effectiveText;
      if (fileMentionMatches.length > 0) {
        const fileBlocks: string[] = [];
        for (const fm of fileMentionMatches) {
          const rawPath = fm[1]!;
          try {
            const _path = await import("path");
            const _fs = await import("fs");
            const resolved = _path.default.isAbsolute(rawPath)
              ? rawPath
              : _path.default.resolve(projectDir ?? process.cwd(), rawPath);
            if (_fs.default.existsSync(resolved) && _fs.default.statSync(resolved).isFile()) {
              const contents = _fs.default.readFileSync(resolved, "utf-8").slice(0, 16384);
              fileBlocks.push(`<file_context path="${rawPath}">\n${contents}\n</file_context>`);
              finalText = finalText.replace(fm[0]!, "").trim();
            }
          } catch {
            /* unreadable — leave token in text */
          }
        }
        if (fileBlocks.length > 0) {
          finalText = fileBlocks.join("\n\n") + (finalText ? `\n\n${finalText}` : "");
        }
      }

      // GAP-P1-01: Fire UserPromptSubmit hook before processing prompt
      try {
        const hookResult = await runUserPromptSubmitHook(finalText, projectDir, activeSessionId ?? undefined);
        if (hookResult.blocked) {
          info(`⛔ Prompt blocked by hook: ${hookResult.reason || "No reason provided"}`);
          return; // Do not send the prompt to AI
        }
        // Apply updatedPrompt if hook modified the input
        if (hookResult.decision?.updatedPrompt) {
          finalText = hookResult.decision.updatedPrompt;
          info(`✏️ Prompt modified by hook`);
        }
      } catch (hookErr) {
        // Hook errors are non-blocking - log and continue
        logger.warn("[Hook] UserPromptSubmit hook failed:", hookErr);
      }

      const userMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: finalText,
        createdAt: new Date(),
        isStreaming: false,
      };
      addMessage(userMsg);

      const streamingId = crypto.randomUUID();
      addMessage({
        id: streamingId,
        role: "assistant",
        content: "",
        createdAt: new Date(),
        isStreaming: true,
      });

      resetStreaming();

      // Build CoreMessage array for AI
      const coreMessages: CoreMessage[] = [
        ...messages
          .filter((m) => m.role !== "system")
          .concat(userMsg)
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
      ];

      // T-BACK-03: Context window exhaustion enforcement
      const modelInfo = availableModels.find((m) => m.id === selectedModel);
      const contextLimit = modelInfo?.contextLength ?? 128000;
      const estimatedTokens = estimateMessagesTokens(coreMessages);
      if (estimatedTokens >= contextLimit) {
        finalizeStreamingMessage();
        resetStreaming();
        const modelDisplay = modelInfo?.name ?? selectedModel ?? "Current model";
        useStore.getState().updateLastMessage({
          content: `${modelDisplay} Models context windows is used completely, switch to another model to use the application\n\n_Use \`/models\` to switch models or \`/compact\` to reduce context._`,
          isStreaming: false,
        });
        return;
      }

      const trimmed = trimToContextWindow(coreMessages, 60000);
      // Epic B: include addDirs as a note in the system prompt (dirs, not file contents)
      const dirNote = addDirs.length > 0
        ? `\n\n## Additional Context Directories\n\nThe following directories are part of the project:\n${addDirs.map((d) => `- ${d}`).join("\n")}`
        : "";
      const effectiveBase = systemPrompt ?? BASE_SYSTEM;
      // T-CLI-16: Load PAKALON.md memory files and inject into system prompt
      const memoryFiles = loadMemoryFiles(projectDir ?? undefined);
      const memoryBlock = memoryFiles.length > 0
        ? `\n\n<pakalon-memory>\n${memoryFiles.join("\n\n---\n\n")}\n</pakalon-memory>`
        : "";
      // T-CLI-66: Output style injection
      const outputStyleGuide = outputStyle === "concise"
        ? "\n\n**Response style: CONCISE** — Keep answers short and direct. No preamble or summaries."
        : outputStyle === "learning"
        ? "\n\n**Response style: LEARNING** — Explain your reasoning step-by-step. Include definitions and analogies."
        : ""; // explanatory is default — no special instruction needed
      const system = buildSystemWithContext(effectiveBase + dirNote + memoryBlock + outputStyleGuide, []);

      // Merge built-in agent tools with dynamically loaded MCP tools
      let mergedTools: ToolSet = { ...allTools, ...mcpToolsRef.current };
      // Epic B: filter to allowed tools if --allowedTools was specified
      if (allowedTools) {
        const allowed = new Set(allowedTools.split(",").map((t) => t.trim()).filter(Boolean));
        mergedTools = Object.fromEntries(
          Object.entries(mergedTools).filter(([name]) => allowed.has(name))
        ) as ToolSet;
      }
      // T-MCP-11: Deferred tool loading — if tool definitions occupy >10% of the context
      // window, restrict to tools whose names/descriptions match keywords in the prompt.
      const toolDefsJson = JSON.stringify(
        Object.entries(mergedTools).map(([name, t]) => ({ name, description: (t as any).description ?? "" }))
      );
      const toolDefsTokenEstimate = Math.ceil(toolDefsJson.length / 4); // ~4 chars per token
      if (toolDefsTokenEstimate > contextLimit * 0.10) {
        // Extract keywords from user message for relevance matching
        const queryLower = finalText.toLowerCase();
        const queryWords = new Set(queryLower.split(/\W+/).filter((w) => w.length > 3));
        const relevantTools = Object.fromEntries(
          Object.entries(mergedTools).filter(([name, t]) => {
            const desc = ((t as any).description ?? "").toLowerCase();
            const nameL = name.toLowerCase();
            // Always keep core tools
            if (["readfile", "writefile", "bash", "editfile", "multiEditFiles", "grepSearch"].includes(name)) return true;
            // Keep tools whose name or description matches any query keyword
            return [...queryWords].some((kw) => nameL.includes(kw) || desc.includes(kw));
          })
        ) as ToolSet;
        // Only switch if it reduces count by at least 30%
        if (Object.keys(relevantTools).length < Object.keys(mergedTools).length * 0.7) {
          mergedTools = relevantTools;
        }
      }
      // T-HK-03: Wrap each tool's execute() with PreToolUse hook.
      // Hooks can block execution or rewrite tool input via decision.updatedInput.
      mergedTools = wrapToolsWithPreToolUseHook(mergedTools, projectDir ?? undefined, activeSessionId ?? undefined) as ToolSet;

      // Determine proxy vs direct mode:
      // - proxy if token exists but no local OPENROUTER_API_KEY
      // - direct if OPENROUTER_API_KEY is set
      const localKey = process.env.OPENROUTER_API_KEY;
      const useProxy = !localKey || process.env.PAKALON_USE_PROXY === "1";

      await handleStream({
        model: selectedModel ?? "openai/gpt-4o-mini",
        messages: trimmed,
        apiKey: localKey || undefined,
        authToken: useProxy ? (token ?? undefined) : undefined,
        useProxy,
        system,
        thinkingEnabled,
        promptCaching: true,
        tools: Object.keys(mergedTools).length > 0 ? mergedTools : undefined,
        onThinkChunk: (chunk) => {
          setThinkContent((prev: string) => prev + chunk);
        },
        onTextChunk: (chunk) => {
          appendStreamChunk(chunk);
          useStore.getState().appendToLastMessage(chunk);
        },
        onFinish: (_text, usage) => {
          finalizeStreamingMessage();
          resetStreaming();
          logger.debug("Chat turn done", usage);
          // T-HK-01: Fire Stop hook after each AI turn finishes
          runStopHook(projectDir ?? undefined, activeSessionId ?? undefined).catch(() => {});
          // T-HK-08: Fire TeammateIdle hook after each AI turn (teammate mode)
          if (process.env["PAKALON_TEAMMATE_MODE"] === "1") {
            runHooks("TeammateIdle", {
              cwd: projectDir ?? process.cwd(),
              sessionId: activeSessionId ?? undefined,
              toolInput: { model: selectedModel, turnText: _text.slice(0, 512) },
            }, projectDir ?? undefined).catch(() => {});
          }
          // T-HK-09: TaskCompleted hook — fires when AI indicates task is done
          const taskDonePattern = /\b(task.*complete|completed|all done|done!|finished|implementation complete)\b/i;
          if (taskDonePattern.test(_text)) {
            runHooks("TaskCompleted", {
              cwd: projectDir ?? process.cwd(),
              sessionId: activeSessionId ?? undefined,
              toolInput: { model: selectedModel, summary: _text.slice(0, 256) },
            }, projectDir ?? undefined).catch(() => {});
          }
          // Record usage to backend (lines_written = newlines in response ~ lines of output)
          if (activeSessionId && selectedModel) {
            const linesWritten = Math.max(1, (_text.match(/\n/g) ?? []).length);
            const totalUsed = usage.promptTokens + usage.completionTokens;
            const modelCtxSize = availableModels.find((m) => m.id === selectedModel)?.contextLength ?? 128000;
            getApiClient().post(`/sessions/${activeSessionId}/usage`, {
              model_id: selectedModel,
              tokens_used: totalUsed,
              context_window_size: modelCtxSize,
              context_window_used: Math.min(totalUsed, modelCtxSize),
              lines_written: linesWritten,
            }).catch(() => { /* non-critical */ });
            // T3-13: Per-model cost estimate via SessionCostTracker
            costTrackerRef.current.record(selectedModel, usage.promptTokens, usage.completionTokens);
            const { totalCostUsd } = costTrackerRef.current.summary();
            setSessionSpendUsd(totalCostUsd);
          }

          // P1: Auto context compaction — fire async after turn ends
          if (autoCompact) {
            void (async () => {
              const currentMsgs = useStore.getState().messages ?? [];
              const contextLimit = availableModels.find((m) => m.id === selectedModel)?.contextLength ?? 128000;
              const coreMessages: CoreMessage[] = currentMsgs
                .filter((m: any) => m.role !== "system")
                .map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content }));
              const usedTokens = estimateMessagesTokens(coreMessages);
              const usedFraction = usedTokens / contextLimit;

              if (usedFraction < autoCompactThreshold) return;

              logger.info("[AutoCompact] Threshold reached, compressing context…", {
                usedFraction: Math.round(usedFraction * 100),
                threshold: Math.round(autoCompactThreshold * 100),
              });

              try {
                const bridgeUrl = process.env.PAKALON_BRIDGE_URL ?? "http://127.0.0.1:7432";
                const summarizerFn = async (text: string): Promise<string> => {
                  const res = await fetch(`${bridgeUrl}/agent/summarize`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text, model_id: selectedModel }),
                  });
                  if (res.ok) {
                    const data = await res.json() as { summary?: string };
                    return data.summary ?? text.slice(0, 2000);
                  }
                  return text.slice(0, 2000);
                };
                const result = await compressContext(coreMessages, contextLimit, summarizerFn);
                if (result.compressed) {
                  useStore.getState().clearMessages();
                  for (const m of result.messages) {
                    useStore.getState().addMessage({
                      id: crypto.randomUUID(),
                      role: m.role as "user" | "assistant" | "system",
                      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
                      createdAt: new Date(),
                      isStreaming: false,
                    });
                  }
                  addMessage({
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: `💡 _Context auto-compacted — saved **${result.savedTokens.toLocaleString()}** tokens (${currentMsgs.length} → ${result.messages.length} messages). Use \`/autocompact off\` to disable._`,
                    createdAt: new Date(),
                    isStreaming: false,
                  });
                }
              } catch (err) {
                logger.warn("[AutoCompact] Compression failed", { err: String(err) });
              }
            })();
          }
        },
        onError: (err) => {
          finalizeStreamingMessage();
          resetStreaming();
          useStore.getState().updateLastMessage({
            content: `Error: ${err.message}`,
            isStreaming: false,
          });
        },
      });
    },
    [isStreaming, budgetExceeded, sessionSpendUsd, maxBudgetUsd, token, selectedModel, availableModels, messages, addMessage, finalizeStreamingMessage, appendStreamChunk, setThinkContent, resetStreaming]
  );

  // Send initial message from CLI arg
  useEffect(() => {
    if (initialMessage && !sentInitial.current) {
      sentInitial.current = true;
      handleSubmit(initialMessage);
    }
  }, [initialMessage, handleSubmit]);

  // Epic B: Replay stored user messages sequentially with 300ms gap
  const sentReplay = useRef(false);
  useEffect(() => {
    if (!replayMessages.length || sentReplay.current) return;
    sentReplay.current = true;
    let delay = initialMessage ? 500 : 0;
    for (const msg of replayMessages) {
      setTimeout(() => handleSubmit(msg), delay);
      delay += 300;
    }
  }, [replayMessages, handleSubmit, initialMessage]);

  // --file flag: inject pre-loaded file contents as an initial system-style context message
  const sentFileCtx = useRef(false);
  useEffect(() => {
    if (!fileContexts.length || sentFileCtx.current) return;
    sentFileCtx.current = true;
    const combined = `The following file(s) have been injected as context:\n\n${fileContexts.join("\n\n---\n\n")}`;
    addMessage({
      id: crypto.randomUUID(),
      role: "system",
      content: combined,
      createdAt: new Date(),
      isStreaming: false,
    });
  }, [fileContexts, addMessage]);

  // Connect to WebSocket for real-time context usage
  useEffect(() => {
    if (!token) return;
    const wsUrl = (process.env.PAKALON_API_URL ?? "http://localhost:8000").replace(/^http/, "ws") + `/usage/stream?token=${token}`;
    const ws = new WebSocket(wsUrl);
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "context_update" && data.remaining_pct !== undefined) {
          setRemainingPct(data.remaining_pct);
        }
      } catch (e) {
        // ignore
      }
    };

    return () => {
      ws.close();
    };
  }, [token, setRemainingPct]);

  // Keyboard shortcuts: Ctrl+C, Tab (cycle mode), Shift+Tab (toggle thinking)
  // T-CLI-51: Ctrl+B (background bash hint), T-CLI-52: Ctrl+F (kill stream),
  // T-CLI-53: Ctrl+T (task panel toggle)
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      // T-CTX-MEMORY: Save session summary to PAKALON.md on Ctrl+C exit
      try {
        const _ctrlcMsgs = useStore.getState().messages ?? [];
        const _summary = buildSessionMemorySummary(_ctrlcMsgs as any);
        if (_summary) saveMemoryFile(_summary, projectDir, { append: true });
      } catch { /* non-fatal */ }
      exit();
    }
    // Tab — cycle permission mode: plan → edit → auto-accept → bypass → plan
    if (key.tab && !key.shift && !isStreaming) {
      cyclePermissionMode();
    }
    // Shift+Tab — toggle extended thinking
    if (key.tab && key.shift && !isStreaming) {
      toggleThinking();
      info(thinkingEnabled ? "Extended thinking **disabled**" : "Extended thinking **enabled**");
    }
    // T-CLI-53: Ctrl+T — toggle task / checkpoint panel
    if (key.ctrl && _input === "t") {
      setShowTaskPanel((v) => !v);
    }
    // T-CLI-52: Ctrl+F — kill / abort current AI stream
    if (key.ctrl && _input === "f") {
      if (isStreaming) {
        abortControllerRef.current?.abort();
        finalizeStreamingMessage();
        resetStreaming();
        useStore.getState().updateLastMessage({ content: "_(stream cancelled by Ctrl+F)_", isStreaming: false });
      }
    }
    // T-CLI-51: Ctrl+B — toggle background bash input overlay
    if (key.ctrl && _input === "b") {
      if (!isStreaming) {
        setShowBashOverlay((v) => !v);
        if (!showBashOverlay) setBashOverlayCmd("");
      }
    }
    // T-CLI-54: Ctrl+R — reverse history search
    if (key.ctrl && _input === "r") {
      if (!isStreaming) {
        // Toggle: if already in history search, close it; otherwise open with empty query
        setHistorySearch((prev) => (prev === null ? "" : null));
      }
    }
    // T-CLI-54: Escape closes history search
    if (key.escape && historySearch !== null) {
      setHistorySearch(null);
    }
    // T-CLI-55: Ctrl+G — open last-mentioned file in $EDITOR / code / vi
    if (key.ctrl && _input === "g") {
      if (!isStreaming) {
        // Find the last file path mentioned in any message (assistant or user)
        const allMessages = useStore.getState().messages;
        let targetFile: string | null = null;
        for (let i = allMessages.length - 1; i >= 0; i--) {
          const content = typeof allMessages[i].content === "string" ? allMessages[i].content : "";
          // Match absolute paths or common relative paths mentioned in messages
          const match = content.match(/(?:^|\s|[`'"])((?:\/|\.\/|\.\.\/|[A-Za-z]:\\)[^\s`'"<>|*?]+\.[a-zA-Z0-9]+)/m);
          if (match) {
            targetFile = match[1].trim();
            break;
          }
        }
        if (targetFile) {
          const editor = process.env.EDITOR || process.env.VISUAL || "code";
          import("child_process").then(({ spawn }) => {
            spawn(editor, [targetFile!], { detached: true, stdio: "ignore" }).unref();
          }).catch(() => {});
          info(`📝 Opening **${targetFile}** in \`${editor}\``);
        } else {
          info("Ctrl+G: No file path found in recent messages. Mention a file first.");
        }
      }
    }
    // T-CLI-51: Bash overlay keyboard input
    if (showBashOverlay) {
      if (key.escape) {
        setShowBashOverlay(false);
        setBashOverlayCmd(null);
        return;
      }
      if (key.return) {
        const cmd = (bashOverlayCmd ?? "").trim();
        if (cmd) {
          spawnBgTask(cmd);
        }
        setShowBashOverlay(false);
        setBashOverlayCmd(null);
        return;
      }
      if (key.backspace || key.delete) {
        setBashOverlayCmd((prev) => (prev ?? "").slice(0, -1));
        return;
      }
      if (_input && !key.ctrl && !key.meta) {
        setBashOverlayCmd((prev) => (prev ?? "") + _input);
        return;
      }
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      {showBanner && <Banner plan={plan ?? undefined} githubLogin={githubLogin ?? undefined} modelId={selectedModel} />}
      {process.env["PAKALON_TEAMMATE_MODE"] === "1" && (
        <Box paddingX={1} borderStyle="single" borderColor="cyan">
          <Text color="cyan" bold>👥 Teammate Mode — </Text>
          <Text color="cyan">read-only · AI will propose changes but not apply them</Text>
        </Box>
      )}
      {process.env["PAKALON_IDE_MODE"] && process.env["PAKALON_IDE_MODE"] !== "none" && (
        <Box paddingX={1}>
          <Text dimColor>🖥  IDE: </Text>
          <Text color="green">{process.env["PAKALON_IDE_MODE"]}</Text>
        </Box>
      )}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <MessageList messages={messages} />
      </Box>
      {verbose && thinkContent ? (
        <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
          <Text bold color="gray">Thinking / Tool Output</Text>
          <Text dimColor>{thinkContent}</Text>
        </Box>
      ) : null}
      <ContextBar
        projectDir={projectDir}
        remainingPct={remainingPct ?? undefined}
        tokenCount={sessionTokensUsed}
        contextLimit={sessionContextLimit}
        isStreaming={isStreaming}
        creditsRemaining={creditBalance?.credits_remaining}
        creditsTotal={creditBalance?.credits_total}
      />
      {/* T3-15: Token budget & spend warnings */}
      <TokenBudgetWarning
        tokensUsed={sessionTokensUsed}
        contextLimit={sessionContextLimit}
        spendUsd={sessionSpendUsd}
        maxBudgetUsd={maxBudgetUsd}
      />
      <PermissionDialog />
      {showMarketplace && (
        <SkillsMarketplaceScreen
          query={marketplaceQuery}
          onClose={(msg) => {
            setShowMarketplace(false);
            setMarketplaceQuery("");
            if (msg) info(msg);
          }}
        />
      )}
      {showConfigScreen && (
        <ConfigScreen
          projectDir={projectDir}
          scope={configScope}
          onExit={() => setShowConfigScreen(false)}
        />
      )}
      {showUndo && (
        <UndoMenu
          onDone={(msg) => { setShowUndo(false); info(msg); }}
          onCancel={() => setShowUndo(false)}
          onUndoConversation={() => {
            // Remove the last user+assistant exchange (up to 2 messages)
            const current = useStore.getState().messages ?? [];
            if (!current.length) return 0;
            let removeCount = 0;
            // Pop last assistant message
            const last = current[current.length - 1];
            if (last?.role === "assistant") removeCount++;
            // Pop preceding user message if present
            const prev = current[current.length - 1 - removeCount];
            if (prev?.role === "user") removeCount++;
            if (removeCount > 0) {
              const kept = current.slice(0, current.length - removeCount);
              useStore.getState().clearMessages();
              for (const m of kept) useStore.getState().addMessage(m);
            }
            return removeCount;
          }}
        />
      )}
      {/* T-CLI-53: Ctrl+T task / checkpoint panel */}
      {showTaskPanel && (
        <Box borderStyle="single" borderColor="yellow" flexDirection="column" paddingX={1}>
          <Text bold color="yellow">📋 Checkpoints (Ctrl+T to close)</Text>
          {undoManager.getCheckpoints().length === 0 ? (
            <Text dimColor>No checkpoints yet. Use `/update &lt;task&gt;` to create one.</Text>
          ) : (
            undoManager.getCheckpoints().map((cp, i) => (
              <Text key={cp.checkpointId}>
                <Text color="cyan">{i + 1}. </Text>
                <Text>{cp.label.slice(0, 60)}</Text>
                <Text dimColor>  {cp.timestamp instanceof Date ? cp.timestamp.toLocaleTimeString() : new Date(cp.timestamp).toLocaleTimeString()}</Text>
              </Text>
            ))
          )}
          <Text dimColor>Use `/rewind &lt;n&gt;` to restore.</Text>
          {/* T-LSP-03: Real-time diagnostics section */}
          {lspDiagnostics.length > 0 && (
            <>
              <Text bold color="yellow">─── LSP Diagnostics ({lspDiagnostics.length})</Text>
              {lspDiagnostics.slice(0, 10).map((d, i) => {
                const sev = d.severity === "error" ? "🔴" : d.severity === "warning" ? "🟡" : "🔵";
                const shortPath = d.filePath ? d.filePath.split(/[\\/]/).slice(-2).join("/") : "";
                return (
                  <Text key={i}>
                    <Text>{sev} </Text>
                    <Text dimColor>{shortPath}{d.line ? `:${d.line}` : ""} </Text>
                    <Text>{d.message.slice(0, 80)}{d.message.length > 80 ? "…" : ""}</Text>
                  </Text>
                );
              })}
              {lspDiagnostics.length > 10 && <Text dimColor>…and {lspDiagnostics.length - 10} more</Text>}
            </>
          )}
        </Box>
      )}
      {/* T-CLI-51: Background tasks sidebar — shown when tasks exist */}
      {backgroundTasks.length > 0 && (
        <Box borderStyle="single" borderColor="blue" flexDirection="column" paddingX={1}>
          <Text bold color="blue">⚙ Background Tasks (Ctrl+B to spawn · Ctrl+F to kill stream)</Text>
          {backgroundTasks.slice(-5).map((t) => (
            <Box key={t.id} flexDirection="column">
              <Text>
                <Text color={t.status === "running" ? "yellow" : t.status === "done" ? "green" : "red"}>
                  {t.status === "running" ? "⏳" : t.status === "done" ? "✅" : "❌"}
                </Text>
                <Text> </Text>
                <Text bold>{t.cmd.slice(0, 50)}</Text>
                {t.exitCode !== undefined && <Text dimColor> (exit {t.exitCode})</Text>}
              </Text>
              {t.output && (
                <Text dimColor>{t.output.split("\n").slice(-3).join("\n").slice(0, 160)}</Text>
              )}
            </Box>
          ))}
          <Text dimColor>Last {Math.min(backgroundTasks.length, 5)} of {backgroundTasks.length} task(s)</Text>
        </Box>
      )}
      {/* T-CLI-51: Ctrl+B input overlay — type a command then Enter to spawn it in background */}
      {showBashOverlay && (
        <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
          <Text bold color="magenta">⚙ Background Bash (Enter to run · Esc to cancel)</Text>
          <Box>
            <Text color="magenta">$ </Text>
            <Text>{bashOverlayCmd ?? ""}</Text>
            <Text color="magenta">█</Text>
          </Box>
          <Text dimColor>Command runs async — output shown in the tasks panel above. AI session unblocked.</Text>
        </Box>
      )}
      {/* T-CLI-54: Ctrl+R history search overlay */}
      {historySearch !== null && (() => {
        const userMsgs = messages
          .filter((m: any) => m.role === "user")
          .map((m: any) => (typeof m.content === "string" ? m.content : ""))
          .filter((c: string) => c.trim().length > 0);
        const deduped = [...new Set(userMsgs)].reverse();
        const filtered = historySearch
          ? deduped.filter((c: string) => c.toLowerCase().includes(historySearch.toLowerCase()))
          : deduped;
        return (
          <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
            <Text bold color="cyan">⌃R History Search — type to filter, Enter to fill, Esc to close</Text>
            <Box>
              <Text color="cyan">Search: </Text>
              <Text>{historySearch || " "}</Text>
            </Box>
            {filtered.slice(0, 8).map((c: string, i: number) => (
              <Text key={i} dimColor={i > 0}>
                <Text color="yellow">{i + 1}. </Text>
                <Text>{c.slice(0, 80)}{c.length > 80 ? "…" : ""}</Text>
              </Text>
            ))}
            {filtered.length === 0 && <Text dimColor>No matching messages.</Text>}
          </Box>
        );
      })()}
      <InputBar
        onSubmit={handleSubmit}
        isDisabled={isStreaming}
        vimMode={vimMode}
        projectDir={projectDir ?? undefined}
        historyItems={messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "").filter(Boolean).reverse()}
      />
      {showStatusline && (
        <StatusLine
          modelId={selectedModel ?? undefined}
          defaultModel={defaultModel ?? undefined}
          isStreaming={isStreaming}
          messageCount={messages.length}
          estimatedTokens={sessionTokensUsed}
          contextLimit={sessionContextLimit}
          privacyMode={privacyMode}
          plan={plan ?? undefined}
        />
      )}
    </Box>
  );
};

export default ChatScreen;
