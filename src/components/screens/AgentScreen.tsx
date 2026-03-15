/**
 * AgentScreen — agent mode TUI showing step-by-step tool execution progress.
 * Supports both:
 *   1. Normal agent mode (direct AI streaming via Vercel AI SDK)
 *   2. Bridge pipeline mode (SSE events from Python bridge for phases 1–6)
 */
import path from "node:path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import MessageList from "@/components/ui/MessageList.js";
import InputBar from "@/components/ui/InputBar.js";
import StatusLine from "@/components/ui/StatusLine.js";
import { useAuth, useSession, useModel, useMode, useStreaming, useStore } from "@/store/index.js";
import { handleStream } from "@/ai/stream.js";
import { allTools } from "@/ai/tools.js";
import { loadMcpTools } from "@/mcp/tools.js";
import { cmdPenpotOpen } from "@/commands/penpot.js";
import { trimToContextWindow, buildSystemWithContext } from "@/ai/context.js";
import { runProxyToolLoop } from "@/ai/proxy-tool-runner.js";
import type { tool, ToolSet } from "ai";
import {
  bridgeGetPenpotProjectState,
  bridgeStartPipeline,
  bridgeStreamPipeline,
  bridgeSendPipelineInput,
  bridgeMemorySearch,
} from "@/bridge/client.js";
import type { ChoiceRequestEvent, PhaseSSEEvent } from "@/bridge/types.js";
import logger from "@/utils/logger.js";
import type { ModelMessage as CoreMessage } from "ai";
import { DEFAULT_FREE_MODEL_ID } from "@/constants/models.js";
import type { PenpotProjectState } from "@/utils/penpot-state.js";

const AGENT_SYSTEM = `You are Pakalon, an agentic AI coding assistant running in a terminal.
You operate autonomously to complete tasks and you must prefer doing the work over describing shell steps.

Follow a PAUL-style loop for every request:
1. PLAN — inspect the project, identify the smallest concrete next action, and use read/search/LSP tools when needed.
2. APPLY — execute the change with the appropriate tool. Do not answer with "I'll do X" or with suggested shell commands when a tool can perform the task.
3. UNIFY — validate the result (prefer LSP diagnostics or project checks after code changes) and then summarize what was completed.

Available tool families:
- Files: readFile, listDir, globFind, grepSearch, writeFile, editFile, multiEditFiles
- Commands: bash
- LSP: lspDefinition, lspReferences, lspHover, lspCompletion, lspRename, lspDiagnostics, lspSymbols
- Research/support: webFetch, webSearch, todoRead, todoWrite, notebookRead, notebookEdit

When command-line work is requested, use shell-style execution via bash/grep tools (including cd/Set-Location workflows) rather than generating Python scripts as command wrappers.

When the user asks for a concrete file or code change, actually perform it before responding.
Prefer LSP tools whenever symbol-aware inspection or validation would help.
Keep the completion summary concise and focused on the completed work, blockers, and validation.`;

const PHASE_LABELS: Record<number, string> = {
  1: "Phase 1 — Planning & Research",
  2: "Phase 2 — Wireframe Design",
  3: "Phase 3 — Development (5 sub-agents)",
  4: "Phase 4 — Security QA",
  5: "Phase 5 — CI/CD",
  6: "Phase 6 — Documentation",
};

interface AgentScreenProps {
  initialTask?: string;
  projectDir?: string;
  /** When set, runs in bridge pipeline mode (phases 1-6) */
  bridgeMode?: {
    userPrompt: string;
    userId: string;
    userPlan: string;
    isYolo: boolean;
    privacyMode?: boolean;
    figmaUrl?: string;
    targetUrl?: string;
  };
}

const AgentScreen: React.FC<AgentScreenProps> = ({ initialTask, projectDir, bridgeMode }) => {
  const { exit } = useApp();
  const { token } = useAuth();
  const { messages, addMessage, finalizeStreamingMessage } = useSession();
  const { selectedModel } = useModel();
  const { agentCurrentStep, setAgentStep, setAgentRunning, thinkingEnabled, permissionMode, privacyMode } = useMode();
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const { isStreaming, appendStreamChunk, setThinkContent, reset: resetStreaming } = useStreaming();
  const clearBridgeMode = useStore((s) => s.clearBridgeMode);
  const sentInitial = useRef(false);
  const stepCount = useRef(0);
  const mcpToolsRef = useRef<ToolSet>({});
  const effectiveProjectDir = projectDir ?? process.cwd();

  // Load MCP tools on mount
  useEffect(() => {
    loadMcpTools(projectDir)
      .then(({ tools, toolCount }) => {
        mcpToolsRef.current = tools;
        if (toolCount > 0) logger.debug(`[AgentScreen] Loaded ${toolCount} MCP tool(s)`);
      })
      .catch((err) => {
        logger.warn("[AgentScreen] MCP load failed", { err: String(err) });
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: `⚠️ MCP tools could not be loaded: ${String(err)}`,
          createdAt: new Date(),
          isStreaming: false,
        });
      });
  }, [addMessage, projectDir]);

  // Bridge pipeline state
  const [currentPhase, setCurrentPhase] = useState<number | null>(null);
  const [pipelineSessionId, setPipelineSessionId] = useState<string | null>(null);
  const [pendingChoice, setPendingChoice] = useState<ChoiceRequestEvent | null>(null);
  const [awaitingFreeText, setAwaitingFreeText] = useState<string | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [proxyToolLoopRunning, setProxyToolLoopRunning] = useState(false);
  const [penpotState, setPenpotState] = useState<PenpotProjectState | null>(null);
  const [openingPenpot, setOpeningPenpot] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const agentBusy = isStreaming || proxyToolLoopRunning || pipelineRunning;
  const historyItems = React.useMemo(
    () => messages
      .filter((m) => m.role === "user")
      .map((m) => typeof m.content === "string" ? m.content : "")
      .filter(Boolean)
      .reverse(),
    [messages],
  );

  useEffect(() => {
    if (permissionMode === "plan" || permissionMode === "orchestration") {
      setPermissionMode("normal");
      logger.debug("[AgentScreen] Reset permission mode for agent execution", {
        from: permissionMode,
        to: "normal",
      });
    }
  }, [permissionMode, setPermissionMode]);

  const formatAgentError = useCallback((err: unknown): string => {
    if (err instanceof Error) {
      return err.message || String(err);
    }
    if (err && typeof err === "object") {
      try {
        return JSON.stringify(err, null, 2);
      } catch {
        return String(err);
      }
    }
    return String(err);
  }, []);

  const formatPenpotStateSummary = useCallback((state: PenpotProjectState | null) => {
    if (!state?.fileId) return null;

    const lines = [`🎨 Current Penpot design: ${state.fileUrl ?? state.projectUrl ?? state.baseUrl}`];

    if (state.revision !== null) lines.push(`   revision: ${state.revision}`);
    if (state.status) lines.push(`   status: ${state.status}`);
    if (state.localSvgPath) lines.push(`   svg: ${path.basename(state.localSvgPath)}`);
    if (state.localJsonPath) lines.push(`   json: ${path.basename(state.localJsonPath)}`);

    return lines.join("\n");
  }, []);

  const refreshPenpotState = useCallback(
    async (reason: "mount" | "phase-complete" | "design-updated") => {
      try {
        const nextState = await bridgeGetPenpotProjectState(effectiveProjectDir);
        setPenpotState(nextState);
        if (nextState?.fileId) {
          logger.debug(`[AgentScreen] Penpot state refreshed (${reason})`, {
            fileId: nextState.fileId,
            revision: nextState.revision,
            status: nextState.status,
          });
        }
        return nextState;
      } catch (err) {
        logger.debug(`[AgentScreen] Penpot state refresh failed (${reason})`, err);
        return null;
      }
    },
    [effectiveProjectDir],
  );

  // -----------------------------------------------------------------
  // Bridge pipeline mode
  // -----------------------------------------------------------------

  const appendPipelineText = useCallback((content: string) => {
    // Append to the last streaming message or add new one
    const store = useStore.getState();
    const msgs = store.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (last?.isStreaming) {
      store.appendToLastMessage(content);
    } else {
      store.addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        createdAt: new Date(),
        isStreaming: false,
      });
    }
  }, []);

  const openCurrentPenpotDesign = useCallback(
    async (source: "bridge-panel" | "hil-prompt") => {
      if (openingPenpot) return;

      if (!penpotState?.fileId) {
        appendPipelineText("\nℹ️ No Penpot design is available for this project yet.\n");
        return;
      }

      setOpeningPenpot(true);
      try {
        const result = await cmdPenpotOpen(undefined, effectiveProjectDir);
        appendPipelineText(`\n🌐 Opened current Penpot design (${source}): ${result.url}\n`);
      } catch (err) {
        appendPipelineText(`\n❌ Unable to open current Penpot design: ${String(err)}\n`);
      } finally {
        setOpeningPenpot(false);
      }
    },
    [appendPipelineText, effectiveProjectDir, openingPenpot, penpotState?.fileId],
  );

  const handlePipelineEvent = useCallback(
    (event: PhaseSSEEvent) => {
      switch (event.type) {
        case "text_delta":
          appendPipelineText(event.content);
          break;

        case "tool_call":
          setAgentStep(`🔧 ${event.tool}`);
          break;

        case "tool_result":
          setAgentStep(null);
          break;

        case "choice_request":
        case "approval_request":
          // Pause and show HIL choice UI
          setPendingChoice(event);
          setAgentStep("⏸  Waiting for your input…");
          break;

        case "phase_complete":
          setAgentStep(null);
          setCurrentPhase((prev) => (prev !== null ? prev + 1 : null));
          appendPipelineText(
            `\n✅ ${PHASE_LABELS[event.phase] ?? `Phase ${event.phase}`} complete.\n` +
              (event.files.length > 0
                ? `  Files written: ${event.files.length}\n`
                : ""),
          );
          if (event.phase >= 2) {
            void (async () => {
              const nextState = await refreshPenpotState("phase-complete");
              const summary = formatPenpotStateSummary(nextState);
              if (summary) {
                appendPipelineText(`\n${summary}\n`);
              }
            })();
          }
          break;

        case "awaiting_input":
          // Phase 2 design modification reflection — free-text input from user
          setAwaitingFreeText((event as { type: string; prompt?: string }).prompt ?? "Enter your response:");
          setAgentStep("⏸  Awaiting your input…");
          break;

        case "error":
          setAgentStep(null);
          appendPipelineText(`\n❌ Error: ${event.message}\n`);
          break;

        case "stream_end":
          setPipelineRunning(false);
          setAgentRunning(false);
          setAgentStep(null);
          clearBridgeMode();
          break;

        case "design_updated":
          // D-04: Penpot browser edits synced back to disk
          appendPipelineText(
            `\n🎨 Design updated from browser — ${(event as any).files_updated?.length ?? 0} file(s) refreshed.\n`
          );
          setAgentStep(null);
          void (async () => {
            const nextState = await refreshPenpotState("design-updated");
            const summary = formatPenpotStateSummary(nextState);
            if (summary) {
              appendPipelineText(`${summary}\n`);
            }
          })();
          break;

        default:
          break;
      }
    },
    [appendPipelineText, clearBridgeMode, formatPenpotStateSummary, refreshPenpotState, setAgentRunning, setAgentStep],
  );

  const runPipelinePhase = useCallback(
    async (phase: number, sessionId: string) => {
      if (!bridgeMode) return;
      setCurrentPhase(phase);
      setAgentStep(`▶ ${PHASE_LABELS[phase] ?? `Phase ${phase}`}…`);

      addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content: `\n🚀 ${PHASE_LABELS[phase] ?? `Phase ${phase}`}\n`,
        createdAt: new Date(),
        isStreaming: false,
      });

      abortRef.current = new AbortController();
      await bridgeStreamPipeline(
        sessionId,
        {
          phase,
          project_dir: projectDir ?? process.cwd(),
          user_prompt: bridgeMode.userPrompt,
          user_id: bridgeMode.userId,
          user_plan: bridgeMode.userPlan,
          is_yolo: bridgeMode.isYolo,
          figma_url: bridgeMode.figmaUrl,
          target_url: bridgeMode.targetUrl,
        },
        handlePipelineEvent,
        abortRef.current.signal,
      );
    },
    [bridgeMode, projectDir, addMessage, setAgentStep, handlePipelineEvent],
  );

  // Start bridge pipeline on mount if bridgeMode is set
  useEffect(() => {
    if (!bridgeMode || sentInitial.current) return;
    sentInitial.current = true;
    setPipelineRunning(true);
    setAgentRunning(true);
    void refreshPenpotState("mount");

    (async () => {
      try {
        const sessionId = await bridgeStartPipeline({
          phase: 1,
          project_dir: projectDir ?? process.cwd(),
          user_prompt: bridgeMode.userPrompt,
          user_id: bridgeMode.userId,
          user_plan: bridgeMode.userPlan,
          is_yolo: bridgeMode.isYolo,
          figma_url: bridgeMode.figmaUrl,
          target_url: bridgeMode.targetUrl,
        });
        setPipelineSessionId(sessionId);

        // Phases 1 and 2 run individually. Phase 3 auto-chains 4→5→6 on the bridge server,
        // so runPipelinePhase(3) streams all of 3, 4, 5, 6 and only returns when stream_end fires.
        for (let phase = 1; phase <= 3; phase++) {
          if (!bridgeMode.isYolo && phase > 1) {
            // Brief pause between phases for SSE events to be processed
            await new Promise((r) => setTimeout(r, 500));
          }
          await runPipelinePhase(phase, sessionId);
        }

        setPipelineRunning(false);
        setAgentRunning(false);
        setAgentStep(null);
        clearBridgeMode();
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "\n🎉 All 6 phases complete! Your application has been built.\n",
          createdAt: new Date(),
          isStreaming: false,
        });
      } catch (err) {
        setPipelineRunning(false);
        setAgentRunning(false);
        setAgentStep(null);
        clearBridgeMode();
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: `\n❌ Pipeline failed: ${String(err)}\n`,
          createdAt: new Date(),
          isStreaming: false,
        });
        logger.debug("Bridge pipeline error", err);
      }
    })();
  }, [bridgeMode, addMessage, clearBridgeMode, projectDir, refreshPenpotState, setAgentRunning, setAgentStep, token, runPipelinePhase]);

  // -----------------------------------------------------------------
  // HIL choice submission
  // -----------------------------------------------------------------
  const handleChoiceSelect = useCallback(
    async (item: { value: string; label: string }) => {
      if (!pipelineSessionId || !pendingChoice) return;
      setPendingChoice(null);
      setAgentStep(`▶ Continuing…`);
      try {
        await bridgeSendPipelineInput(pipelineSessionId, item.value);
      } catch (err) {
        logger.debug("sendPipelineInput error", err);
      }
    },
    [pipelineSessionId, pendingChoice, setAgentStep],
  );

  // Memoize choice items to prevent SelectInput from resetting on every render
  const choiceItems = useMemo(() => {
    if (!pendingChoice) return [];
    return pendingChoice.choices.map((c) => ({
      value: c.id,
      label: c.label,
    }));
  }, [pendingChoice]);

  // Handle free-text input for awaiting_input SSE events (Phase 2 design modification reflection)
  const handleFreeTextSubmit = useCallback(
    async (text: string) => {
      if (!pipelineSessionId || !awaitingFreeText) return;
      setAwaitingFreeText(null);
      setAgentStep("▶ Continuing…");
      appendPipelineText(`\n✍️  You: ${text}\n`);
      try {
        await bridgeSendPipelineInput(pipelineSessionId, text);
      } catch (err) {
        logger.debug("sendFreeTextInput error", err);
      }
    },
    [pipelineSessionId, awaitingFreeText, setAgentStep, appendPipelineText],
  );

  // -----------------------------------------------------------------
  // Normal agent mode (direct AI streaming)
  // -----------------------------------------------------------------

  const handleSubmit = useCallback(
    async (text: string) => {
	  if (agentBusy) return;
      if (text.startsWith("/clear")) {
        useStore.getState().clearMessages();
        stepCount.current = 0;
        setAgentStep(null);
        return;
      }

      const userMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: text,
        createdAt: new Date(),
        isStreaming: false,
      };
      addMessage(userMsg);
      setAgentRunning(true);

      stepCount.current++;
      setAgentStep(`Step ${stepCount.current}: Thinking…`);

      const coreMessages: CoreMessage[] = messages
        .filter((m) => m.role !== "system")
        .concat(userMsg)
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

      const trimmed = trimToContextWindow(coreMessages, 80000);

      const localKey = process.env.OPENROUTER_API_KEY;
      const useProxy = !localKey || process.env.PAKALON_USE_PROXY === "1";
      const mergedToolsRaw = { ...allTools, ...mcpToolsRef.current };
      const mergedTools = Object.fromEntries(
        Object.entries(mergedToolsRaw).filter(([, def]) => typeof (def as { execute?: unknown })?.execute === "function"),
      ) as ToolSet;
      const droppedTools = Object.keys(mergedToolsRaw).length - Object.keys(mergedTools).length;
      if (droppedTools > 0) {
        logger.warn("[AgentScreen] Ignoring tools without executable handlers", {
          droppedTools,
          totalTools: Object.keys(mergedToolsRaw).length,
        });
      }

      // T-CLI-14: Enrich system prompt with relevant Mem0 memories from bridge server.
      // Run in parallel with anything else — if bridge is down, silently skip.
      let memoryContext = "";
      try {
        const userId = useStore.getState().userId ?? "anonymous";
        const memResult = await bridgeMemorySearch({
          user_id: userId,
          query: text,
          top_k: 5,
        });
        if (memResult.memories && memResult.memories.length > 0) {
          memoryContext =
            "\n\n## Relevant Memories\n" +
            memResult.memories
              .map((m) => `- ${m.text}`)
              .join("\n");
        }
      } catch {
        // Bridge server not running or Mem0 unavailable — continue without memory context
      }

      const agentSystem = buildSystemWithContext(AGENT_SYSTEM + memoryContext, []);

      const toolEnabledAssistantLoop = permissionMode !== "orchestration" && Object.keys(mergedTools).length > 0;

      if (toolEnabledAssistantLoop) {
    setProxyToolLoopRunning(true);
    try {
      const summarizeToolValue = (value: unknown) => {
        const textValue = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        return textValue.length > 1200 ? `${textValue.slice(0, 1200)}\n...[truncated]` : textValue;
      };

      const result = await runProxyToolLoop({
        model: selectedModel ?? DEFAULT_FREE_MODEL_ID,
        messages: trimmed,
        apiKey: localKey || undefined,
        useProxy,
        authToken: token ?? undefined,
        privacyMode,
        thinkingEnabled,
        projectDir: effectiveProjectDir,
        system: agentSystem,
        tools: mergedTools,
        onToolCall: (toolName, input, note) => {
          setAgentStep(`Step ${stepCount.current}: ${toolName}`);
          addMessage({
            id: crypto.randomUUID(),
            role: "tool",
            content: `${note ? `${note}\n` : ""}${toolName} ${JSON.stringify(input)}`,
            createdAt: new Date(),
            isStreaming: false,
          });
        },
        onToolResult: (toolName, value) => {
          addMessage({
            id: crypto.randomUUID(),
            role: "tool",
            content: `${toolName} result\n${summarizeToolValue(value)}`,
            createdAt: new Date(),
            isStreaming: false,
          });
        },
      });

      addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.finalText,
        createdAt: new Date(),
        isStreaming: false,
      });
    } catch (err) {
      addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Agent error: ${formatAgentError(err)}`,
        createdAt: new Date(),
        isStreaming: false,
      });
    } finally {
      setProxyToolLoopRunning(false);
      setAgentRunning(false);
      setAgentStep(null);
    }
    return;
    }

    const streamingId = crypto.randomUUID();
    addMessage({
    id: streamingId,
    role: "assistant",
    content: "",
    createdAt: new Date(),
    isStreaming: true,
    });

    resetStreaming();

      await handleStream({
        model: selectedModel ?? DEFAULT_FREE_MODEL_ID,
        messages: trimmed,
        apiKey: localKey || undefined,
        authToken: useProxy ? (token ?? undefined) : undefined,
        useProxy,
        system: agentSystem,
        thinkingEnabled,
        tools: Object.keys(mergedTools).length > 0 ? mergedTools : undefined,
        onThinkChunk: (chunk) => {
          setThinkContent((prev: string) => prev + chunk);
          setAgentStep(`Step ${stepCount.current}: Reasoning…`);
        },
        onTextChunk: (chunk) => {
          appendStreamChunk(chunk);
          useStore.getState().appendToLastMessage(chunk);
        },
        onFinish: (_text, usage) => {
          finalizeStreamingMessage();
          resetStreaming();
          setAgentRunning(false);
          setAgentStep(null);
          logger.debug("Agent step done", usage);
        },
        onError: (err) => {
          finalizeStreamingMessage();
          resetStreaming();
          setAgentRunning(false);
          setAgentStep(null);
          useStore.getState().updateLastMessage({
            content: `Agent error: ${err.message}`,
            isStreaming: false,
          });
        },
      });
    },
    [agentBusy, effectiveProjectDir, privacyMode, permissionMode, token, selectedModel, messages, addMessage, finalizeStreamingMessage, appendStreamChunk, setAgentRunning, setThinkContent, resetStreaming, setAgentStep, thinkingEnabled, formatAgentError]
  );

  useEffect(() => {
    if (!bridgeMode && initialTask && !sentInitial.current) {
      sentInitial.current = true;
      handleSubmit(initialTask);
    }
  }, [initialTask, handleSubmit, bridgeMode]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      // Abort bridge stream if running
      abortRef.current?.abort();
      exit();
      return;
    }

    if (
      bridgeMode &&
      !awaitingFreeText &&
      key.ctrl &&
      (input === "o" || input === "O")
    ) {
      void openCurrentPenpotDesign(pendingChoice ? "hil-prompt" : "bridge-panel");
    }
  });

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box paddingX={1} gap={2}>
        <Text bold color="magenta">PAKALON AGENT</Text>
        {projectDir && <Text dimColor>{projectDir}</Text>}
        <Text
          color={
            permissionMode === "orchestration"
              ? "yellow"
              : permissionMode === "auto-accept"
                ? "#ff8c00"
                : permissionMode === "plan"
                  ? "#ff8c00"
                  : "white"
          }
        >
          mode: {permissionMode}
        </Text>
        {/* Phase progress indicator */}
        {currentPhase !== null && (
          <Text color="#ff8c00">
            Phase {currentPhase}/6
          </Text>
        )}
      </Box>

      {/* Current step / spinner */}
      {agentBusy && (
        <Box flexDirection="column" gap={1} paddingX={1}>
          <Box gap={1}>
            <Text color="#ff8c00">●</Text>
            <Text color="#ff8c00">{agentCurrentStep ?? "Agent running…"}</Text>
          </Box>
        </Box>
      )}

      {bridgeMode && penpotState?.fileId && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          marginX={1}
        >
          <Text color="cyan" bold>Penpot design</Text>
          <Text>{penpotState.fileUrl ?? penpotState.projectUrl ?? penpotState.baseUrl}</Text>
          <Text dimColor>
            file {penpotState.fileId}
            {penpotState.revision !== null ? ` • rev ${penpotState.revision}` : ""}
            {penpotState.status ? ` • ${penpotState.status}` : ""}
          </Text>
          {(penpotState.localSvgPath || penpotState.localJsonPath) && (
            <Text dimColor>
              {penpotState.localSvgPath ? `svg ${path.basename(penpotState.localSvgPath)}` : ""}
              {penpotState.localSvgPath && penpotState.localJsonPath ? " • " : ""}
              {penpotState.localJsonPath ? `json ${path.basename(penpotState.localJsonPath)}` : ""}
            </Text>
          )}
          <Text dimColor>
            {openingPenpot ? "Opening current design…" : "Press Ctrl+O to open the current Penpot design"}
          </Text>
        </Box>
      )}

      {/* Message list */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <MessageList messages={messages} assistantBusy={agentBusy} />
      </Box>

      {/* HIL Choice UI — rendered when a choice_request/approval_request is pending */}
      {pendingChoice && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginX={1}
        >
          <Text bold color="yellow">
            👋 {pendingChoice.question}
          </Text>
          <Text dimColor>{pendingChoice.message}</Text>
          {penpotState?.fileId && (
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor="cyan"
              paddingX={1}
              marginTop={1}
            >
              <Text color="cyan" bold>Current Penpot state</Text>
              <Text>{penpotState.fileUrl ?? penpotState.projectUrl ?? penpotState.baseUrl}</Text>
              <Text dimColor>
                file {penpotState.fileId}
                {penpotState.revision !== null ? ` • rev ${penpotState.revision}` : ""}
                {penpotState.status ? ` • ${penpotState.status}` : ""}
              </Text>
              {(penpotState.localSvgPath || penpotState.localJsonPath) && (
                <Text dimColor>
                  {penpotState.localSvgPath ? `svg ${path.basename(penpotState.localSvgPath)}` : ""}
                  {penpotState.localSvgPath && penpotState.localJsonPath ? " • " : ""}
                  {penpotState.localJsonPath ? `json ${path.basename(penpotState.localJsonPath)}` : ""}
                </Text>
              )}
              <Text dimColor>
                {openingPenpot
                  ? "Opening current design…"
                  : "Press Ctrl+O to open the current Penpot design before you choose"}
              </Text>
            </Box>
          )}
          <SelectInput
            items={choiceItems}
            onSelect={handleChoiceSelect}
          />
          <Text dimColor>Use ↑↓ arrows, Enter to select</Text>
        </Box>
      )}

      {/* Free-text input — shown when awaiting_input event received (e.g. Phase 2 design modification) */}
      {awaitingFreeText && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="#ff8c00"
          paddingX={1}
          marginX={1}
        >
          <Text bold color="#ff8c00">✍️  {awaitingFreeText}</Text>
          <InputBar onSubmit={handleFreeTextSubmit} isDisabled={false} />
        </Box>
      )}

      {/* Input bar — hidden during pipeline mode (input is only via HIL choices) */}
      {!bridgeMode && (
        <InputBar
          onSubmit={handleSubmit}
          isDisabled={agentBusy}
          mode="agent"
          historyItems={historyItems}
        />
      )}
      <StatusLine modelId={selectedModel} />
    </Box>
  );
};

export default AgentScreen;
