/**
 * Root Ink application component.
 * Decides which screen to render based on auth state and mode.
 */
import React, { useEffect } from "react";
import fs from "node:fs/promises";
import path from "node:path";
import { Box, Text } from "ink";
import SplashLoginScreen from "@/frontend/screens/SplashLoginScreen.js";
import ChatLayout from "@/frontend/screens/ChatLayout.js";
import AgentScreen from "@/components/screens/AgentScreen.js";
import { useAuth, useMode, useStore } from "@/store/index.js";
import { loadCredentials } from "@/auth/storage.js";
import { getApiClient } from "@/api/client.js";
import { cmdResumeSession, cmdForkSession, cmdReplayUserMessages, cmdContinue } from "@/commands/session.js";
import { resolveProjectConfig } from "@/utils/project-config.js";
import logger from "@/utils/logger.js";
import { checkStartupCredits } from "@/api/credits.js";
import { buildMemoryBlock } from "@/utils/memory-file.js";
import { cachePrContext, formatPrContextForPrompt } from "@/utils/github-pr.js";
import { checkStartupCredits } from "@/api/credits.js";

interface AppProps {
  initialMessage?: string;
  projectDir?: string;
  forceAgent?: boolean;
  showBanner?: boolean;
  permissionMode?: "plan" | "edit" | "auto-accept" | "bypass";
  modelOverride?: string;
  defaultModel?: string;
  fallbackModel?: string;
  sessionIdOverride?: string;
  /** Epic B: Additional context directories */
  addDirs?: string[];
  /** Epic B: Comma-separated list of allowed tool names */
  allowedTools?: string;
  /** Epic B: Additional MCP server URLs */
  mcpServers?: string[];
  /** Epic B: Fork the current session into a new one at startup */
  forkSession?: boolean;
  /** Epic B: Replay stored user messages from the last session */
  replayUserMessages?: boolean;
  /** Resume the most recent session automatically (--continue flag) */
  continueSession?: boolean;
  /** File paths whose contents should be injected as context (--file flag) */
  fileContexts?: string[];
  /** Optional path to a JSON settings override file (--settings flag) */
  settingsFile?: string;
  /** Maximum spend budget in USD — passed to ChatScreen (--max-budget-usd flag) */
  maxBudgetUsd?: number;
  /** Path to an extra MCP config JSON file to merge in (--mcp-config flag) */
  mcpConfigFile?: string;
  /** When true, all slash-command input is treated as plain messages (--disable-slash-commands) */
  disableSlashCommands?: boolean;
  /** Override or append to the system prompt (built from --system-prompt* flags) */
  systemPrompt?: string;
  /** Load PR diff/context from GitHub PR URL or number (--from-pr flag) */
  fromPr?: string;
  /** IDE to launch alongside Pakalon: vscode | cursor | windsurf (--ide flag) */
  ideMode?: "vscode" | "cursor" | "windsurf" | "none";
  /** When true, forces read-only plan mode and shows a teammate-mode indicator (--teammate-mode) */
  teammateMode?: boolean;
  /** Enabled beta feature flags (--betas comma-separated list) */
  betas?: string[];
}

const App: React.FC<AppProps> = ({
  initialMessage,
  projectDir,
  forceAgent = false,
  showBanner = true,
  permissionMode,
  modelOverride,
  defaultModel,
  fallbackModel,
  sessionIdOverride,
  addDirs = [],
  allowedTools,
  mcpServers = [],
  forkSession = false,
  replayUserMessages = false,
  continueSession = false,
  fileContexts = [],
  settingsFile,
  maxBudgetUsd,
  mcpConfigFile,
  disableSlashCommands = false,
  systemPrompt,
  fromPr,
  ideMode,
  teammateMode = false,
  betas = [],
}) => {
  const { isLoggedIn, restoreSession, hasEverLoggedIn } = useAuth();
  const { mode } = useMode();
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const pendingBridgeMode = useStore((s) => s.pendingBridgeMode);

  // Track whether login just completed this session (for logo animation)
  const [justLoggedIn, setJustLoggedIn] = React.useState(false);
  const prevLoggedIn = React.useRef(isLoggedIn);
  useEffect(() => {
    if (!prevLoggedIn.current && isLoggedIn) {
      setJustLoggedIn(true);
    }
    prevLoggedIn.current = isLoggedIn;
  }, [isLoggedIn]);

  // Startup credit check — block interaction if credits are exhausted
  const [creditsBlocked, setCreditsBlocked] = React.useState(false);
  const [creditsBlockedReason, setCreditsBlockedReason] = React.useState<string>("");
  useEffect(() => {
    if (!isLoggedIn) return;
    checkStartupCredits().then((result) => {
      if (result && !result.can_interact) {
        setCreditsBlocked(true);
        setCreditsBlockedReason(result.reason ?? "No credits remaining. Please upgrade your plan.");
      }
    }).catch(() => { /* non-blocking on error */ });
  }, [isLoggedIn]);

  // --permission-mode / --plan / --edit / --auto-accept / --bypass-permissions
  useEffect(() => {
    if (permissionMode) {
      setPermissionMode(permissionMode);
    }
  }, [permissionMode, setPermissionMode]);

  // --teammate-mode: always force plan mode regardless of other flags
  useEffect(() => {
    if (teammateMode) {
      setPermissionMode("plan");
      // Store the flag so ChatScreen can render the teammate-mode banner
      process.env["PAKALON_TEAMMATE_MODE"] = "1";
    }
  }, [teammateMode, setPermissionMode]);

  // --ide: open the IDE in the project directory after the app mounts
  useEffect(() => {
    if (!ideMode || ideMode === "none") return;
    const cwd = projectDir ?? process.cwd();
    const commands: Record<string, string> = {
      vscode: `code "${cwd}"`,
      cursor: `cursor "${cwd}"`,
      windsurf: `windsurf "${cwd}"`,
    };
    const cmd = commands[ideMode];
    if (!cmd) return;
    try {
      const { execSync } = require("child_process") as typeof import("child_process");
      execSync(cmd, { stdio: "ignore" });
      logger.debug(`[ide] Launched ${ideMode} at ${cwd}`);
    } catch (err) {
      logger.warn(`[ide] Failed to launch ${ideMode}: ${err instanceof Error ? err.message : String(err)}`);
    }
  // Run once on mount only
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --betas: expose enabled features to rest of runtime
  useEffect(() => {
    for (const flag of betas) {
      const key = `PAKALON_BETA_${flag.toUpperCase().replace(/-/g, "_")}`;
      if (!process.env[key]) process.env[key] = "1";
    }
  }, [betas]);

  // Resolved state from async file loads
  const [fileContextContents, setFileContextContents] = React.useState<string[]>([]);
  const [resolvedMcpServers, setResolvedMcpServers] = React.useState<string[]>(mcpServers);
  const [resolvedMaxBudget, setResolvedMaxBudget] = React.useState<number | undefined>(maxBudgetUsd);

  // Load .pakalon/config.json (project-level config) on mount
  useEffect(() => {
    const cwd = projectDir ?? process.cwd();
    try {
      const cfg = resolveProjectConfig(cwd);

      // Apply permission mode (only if not already set by CLI flag)
      if (cfg.permissionMode && !permissionMode) {
        setPermissionMode(cfg.permissionMode);
      }

      // Apply privacy mode
      const setPrivacyMode = useStore.getState().setPrivacyMode;
      if (cfg.privacy !== undefined && typeof setPrivacyMode === "function") {
        (setPrivacyMode as (v: boolean) => void)(cfg.privacy);
      }

      // Apply thinking mode
      const agentDefs = cfg.agentDefaults ?? {};
      if (agentDefs.thinkingEnabled !== undefined) {
        const toggle = useStore.getState().toggleThinking;
        const thinking = useStore.getState().thinkingEnabled;
        if (typeof toggle === "function" && thinking !== agentDefs.thinkingEnabled) {
          (toggle as () => void)();
        }
      }

      // Apply max budget
      if (cfg.maxBudgetUsd !== undefined && maxBudgetUsd === undefined) {
        setResolvedMaxBudget(cfg.maxBudgetUsd);
      }

      // Merge MCP servers from project config
      if (cfg.mcpServers && cfg.mcpServers.length > 0) {
        const extraUrls = cfg.mcpServers
          .filter((s) => s.enabled !== false)
          .map((s) => s.url)
          .filter(Boolean);
        if (extraUrls.length > 0) {
          setResolvedMcpServers((prev) => [...new Set([...prev, ...extraUrls])]);
        }
      }

      logger.debug("[project-config] Applied project config", cfg);
    } catch (err) {
      logger.debug("[project-config] No project config found or parse error", err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir]);

  // Restore session from disk on mount
  useEffect(() => {
    const restored = restoreSession();
    if (restored) {
      const creds = loadCredentials();
      if (creds) {
        getApiClient();
        logger.debug("Session restored", { userId: creds.userId, plan: creds.plan });
      }
    }
  }, [restoreSession]);

  // Resume specific session if --session-id flag was passed
  useEffect(() => {
    if (sessionIdOverride && isLoggedIn) {
      cmdResumeSession(sessionIdOverride).catch((err) => {
        logger.warn("Failed to resume session", err);
      });
    }
  }, [sessionIdOverride, isLoggedIn]);

  // --continue flag: resume the most recent session
  useEffect(() => {
    if (continueSession && isLoggedIn && !sessionIdOverride) {
      cmdContinue().catch((err) => {
        logger.warn("Failed to continue last session", err);
      });
    }
  }, [continueSession, isLoggedIn, sessionIdOverride]);

  // --file flag: read each specified file and store contents
  useEffect(() => {
    if (!fileContexts || fileContexts.length === 0) return;
    const cwd = projectDir ?? process.cwd();
    Promise.all(
      fileContexts.map(async (p) => {
        try {
          const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
          const content = await fs.readFile(abs, "utf8");
          return `### File: ${path.relative(cwd, abs)}\n\`\`\`\n${content}\n\`\`\``;
        } catch (err) {
          logger.warn(`--file: could not read ${p}`, err);
          return null;
        }
      })
    ).then((items) => setFileContextContents(items.filter(Boolean) as string[]));
  }, [fileContexts, projectDir]);

  // T-A17: Load PAKALON.md/CLAUDE.md memory file on mount
  const [memoryBlock, setMemoryBlock] = React.useState<string>("");
  React.useEffect(() => {
    const cwd = projectDir ?? process.cwd();
    const block = buildMemoryBlock(cwd);
    if (block) {
      setMemoryBlock(block);
      logger.debug("[app] Loaded memory file into system prompt");
    }
  }, [projectDir]);

  // --settings flag: load JSON settings file and apply overrides

  // --from-pr flag: load PR context from GitHub
  const [prContextContent, setPrContextContent] = React.useState<string>("");
  React.useEffect(() => {
    if (!fromPr) return;
    const cwd = projectDir ?? process.cwd();
    cachePrContext(fromPr, cwd)
      .then((cacheFile) => fs.readFile(cacheFile, "utf8"))
      .then((content) => setPrContextContent(content))
      .catch((err) => {
        logger.warn("--from-pr: failed to load PR context", { prRef: fromPr, error: String(err) });
      });
  }, [fromPr, projectDir]);

  // --settings flag: load JSON settings file and apply overrides
  useEffect(() => {
    if (!settingsFile) return;
    const load = async () => {
      try {
        const raw = await fs.readFile(settingsFile, "utf8");
        const settings = JSON.parse(raw) as Record<string, unknown>;
        if (typeof settings.maxBudgetUsd === "number") {
          setResolvedMaxBudget(settings.maxBudgetUsd as number);
        }
      } catch (err) {
        logger.warn(`--settings: could not load ${settingsFile}`, err);
      }
    };
    load();
  }, [settingsFile]);

  // --mcp-config flag: load extra MCP config JSON and merge servers
  useEffect(() => {
    if (!mcpConfigFile) return;
    const load = async () => {
      try {
        const raw = await fs.readFile(mcpConfigFile, "utf8");
        const config = JSON.parse(raw) as { servers?: string[] };
        if (Array.isArray(config.servers)) {
          setResolvedMcpServers((prev) => [...new Set([...prev, ...config.servers!])]);
        }
      } catch (err) {
        logger.warn(`--mcp-config: could not load ${mcpConfigFile}`, err);
      }
    };
    load();
  }, [mcpConfigFile]);

  // Epic B: Fork the current session at startup
  useEffect(() => {
    if (forkSession && isLoggedIn) {
      cmdForkSession(undefined, projectDir).catch((err) => {
        logger.warn("Failed to fork session", err);
      });
    }
  }, [forkSession, isLoggedIn, projectDir]);

  // Epic B: Stash replayed user messages into the store so ChatScreen can
  //         send them sequentially on mount (handled in ChatScreen via prop)
  const [replayMessages, setReplayMessages] = React.useState<string[]>([]);
  useEffect(() => {
    if (replayUserMessages && isLoggedIn) {
      cmdReplayUserMessages(projectDir).then(setReplayMessages).catch((err) => {
        logger.warn("Failed to load replay messages", err);
      });
    }
  }, [replayUserMessages, isLoggedIn, projectDir]);

  // --from-pr flag: fetch PR diff/metadata and prepend to initialMessage
  const [resolvedInitialMessage, setResolvedInitialMessage] = React.useState<string | undefined>(initialMessage);
  useEffect(() => {
    if (!fromPr) return;
    const fetchPr = async () => {
      try {
        // Parse PR reference: full URL or bare number
        let owner: string | undefined;
        let repoName: string | undefined;
        let prNumber = "";

        const urlMatch = fromPr.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
        if (urlMatch) {
          owner = urlMatch[1];
          repoName = urlMatch[2];
          prNumber = urlMatch[3] ?? "";
        } else if (/^\d+$/.test(fromPr.trim())) {
          prNumber = fromPr.trim();
          // Try to infer owner/repo from git remote
          try {
            const { execSync } = await import("child_process");
            const remote = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
            const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
            if (m) { owner = m[1]; repoName = m[2]; }
          } catch {
            // ignore
          }
        } else {
          logger.warn("[from-pr] Could not parse PR reference:", fromPr);
          return;
        }

        if (!owner || !repoName) {
          logger.warn("[from-pr] Could not determine repo — provide a full GitHub PR URL");
          return;
        }

        // Fetch PR metadata via GitHub API (no token needed for public repos)
        const apiBase = `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`;
        const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
        const ghToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
        if (ghToken) headers["Authorization"] = `Bearer ${ghToken}`;

        const [prRes, diffRes] = await Promise.all([
          fetch(apiBase, { headers }),
          fetch(apiBase, { headers: { ...headers, Accept: "application/vnd.github.diff" } }),
        ]);

        if (!prRes.ok) {
          logger.warn(`[from-pr] GitHub API error ${prRes.status}: ${await prRes.text()}`);
          return;
        }

        const pr = await prRes.json() as {
          title: string; body: string | null; number: number;
          user: { login: string }; base: { ref: string }; head: { ref: string };
          changed_files: number; additions: number; deletions: number;
        };
        const diff = diffRes.ok ? await diffRes.text() : "";

        // Truncate diff to avoid blowing the context window
        const MAX_DIFF_CHARS = 12_000;
        const truncatedDiff = diff.length > MAX_DIFF_CHARS
          ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated — too large to display in full]"
          : diff;

        const prContext = [
          `## Pull Request #${pr.number}: ${pr.title}`,
          `**Repo:** ${owner}/${repoName}  |  **Author:** ${pr.user.login}`,
          `**Branch:** \`${pr.head.ref}\` → \`${pr.base.ref}\``,
          `**Changes:** +${pr.additions} -${pr.deletions} across ${pr.changed_files} file(s)`,
          "",
          pr.body ? `**Description:**\n${pr.body}` : "_No description provided._",
          "",
          truncatedDiff ? `**Diff:**\n\`\`\`diff\n${truncatedDiff}\n\`\`\`` : "",
        ].filter(Boolean).join("\n");

        setResolvedInitialMessage((prev) =>
          prev ? `${prContext}\n\n---\n\n${prev}` : prContext
        );
      } catch (err) {
        logger.warn("[from-pr] Failed to fetch PR context:", err);
      }
    };
    fetchPr();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromPr]);

  if (!isLoggedIn) {
    return (
      <SplashLoginScreen
        showAnimation={!hasEverLoggedIn}
      />
    );
  }

  // Credits exhausted — block all interaction with a clear message
  if (creditsBlocked) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="red" bold>⛔ No credits remaining</Text>
        <Box marginTop={1}>
          <Text>{creditsBlockedReason}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Visit pakalon.com/pricing to upgrade your plan.</Text>
        </Box>
      </Box>
    );
  }

  const isAgent = forceAgent || mode === "agent";

  if (isAgent) {
    return (
      <AgentScreen
        initialTask={initialMessage}
        projectDir={projectDir}
        bridgeMode={pendingBridgeMode ?? undefined}
      />
    );
  }

  return (
    <ChatLayout
      initialMessage={resolvedInitialMessage}
      projectDir={projectDir}
      showBanner={false}
      modelOverride={modelOverride}
      defaultModel={defaultModel}
      fallbackModel={fallbackModel}
      addDirs={addDirs}
      allowedTools={allowedTools}
      mcpServers={resolvedMcpServers}
      replayMessages={replayMessages}
      fileContexts={fileContextContents}
      maxBudgetUsd={resolvedMaxBudget}
      disableSlashCommands={disableSlashCommands}
      systemPrompt={systemPrompt}
      playLogoAnimation={justLoggedIn}
      memoryBlock={memoryBlock}
    />
  );
};

export default App;
