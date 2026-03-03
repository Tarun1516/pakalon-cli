/**
 * AgentScreen — agent mode TUI showing step-by-step tool execution progress.
 * Supports both:
 *   1. Normal agent mode (direct AI streaming via Vercel AI SDK)
 *   2. Bridge pipeline mode (SSE events from Python bridge for phases 1–6)
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "@/components/ui/Spinner.js";
import MessageList from "@/components/ui/MessageList.js";
import InputBar from "@/components/ui/InputBar.js";
import StatusLine from "@/components/ui/StatusLine.js";
import { useAuth, useSession, useModel, useMode, useStreaming, useStore } from "@/store/index.js";
import { handleStream } from "@/ai/stream.js";
import { allTools } from "@/ai/tools.js";
import { loadMcpTools } from "@/mcp/tools.js";
import { trimToContextWindow, buildSystemWithContext } from "@/ai/context.js";
import type { tool, ToolSet } from "ai";
import {
  bridgeStartPipeline,
  bridgeStreamPipeline,
  bridgeSendPipelineInput,
  bridgeMemorySearch,
} from "@/bridge/client.js";
import type { ChoiceRequestEvent, PhaseSSEEvent } from "@/bridge/types.js";
import logger from "@/utils/logger.js";
import type { ModelMessage as CoreMessage } from "ai";

const AGENT_SYSTEM = `You are Pakalon, an agentic AI coding assistant running in a terminal.
You operate autonomously to complete tasks. You have tools available:
- readFile: read file contents
- writeFile: write files
- listDir: list directory contents
- bash: execute shell commands

Work step by step. After each tool call, reflect and decide the next action.
When the task is complete, summarize what you did.`;

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
  const { agentCurrentStep, setAgentStep, thinkingEnabled } = useMode();
  const { isStreaming, appendStreamChunk, setThinkContent, reset: resetStreaming } = useStreaming();
  const sentInitial = useRef(false);
  const stepCount = useRef(0);
  const mcpToolsRef = useRef<ToolSet>({});

  // Load MCP tools on mount
  useEffect(() => {
    loadMcpTools(projectDir)
      .then(({ tools, toolCount }) => {
        mcpToolsRef.current = tools;
        if (toolCount > 0) logger.debug(`[AgentScreen] Loaded ${toolCount} MCP tool(s)`);
      })
      .catch((err) => logger.warn("[AgentScreen] MCP load failed", { err: String(err) }));
  }, [projectDir]);

  // Bridge pipeline state
  const [currentPhase, setCurrentPhase] = useState<number | null>(null);
  const [pipelineSessionId, setPipelineSessionId] = useState<string | null>(null);
  const [pendingChoice, setPendingChoice] = useState<ChoiceRequestEvent | null>(null);
  const [awaitingFreeText, setAwaitingFreeText] = useState<string | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
          setAgentStep(null);
          break;

        case "design_updated":
          // D-04: Penpot browser edits synced back to disk
          appendPipelineText(
            `\n🎨 Design updated from browser — ${(event as any).files_updated?.length ?? 0} file(s) refreshed.\n`
          );
          setAgentStep(null);
          break;

        default:
          break;
      }
    },
    [appendPipelineText, setAgentStep],
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
        setAgentStep(null);
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "\n🎉 All 6 phases complete! Your application has been built.\n",
          createdAt: new Date(),
          isStreaming: false,
        });
      } catch (err) {
        setPipelineRunning(false);
        setAgentStep(null);
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
  }, [bridgeMode]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (isStreaming) return;
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

      stepCount.current++;
      setAgentStep(`Step ${stepCount.current}: Thinking…`);

      const streamingId = crypto.randomUUID();
      addMessage({
        id: streamingId,
        role: "assistant",
        content: "",
        createdAt: new Date(),
        isStreaming: true,
      });

      resetStreaming();

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
      const mergedTools = { ...allTools, ...mcpToolsRef.current };

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

      await handleStream({
        model: selectedModel ?? "openai/gpt-4o-mini",
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
          setAgentStep(null);
          logger.debug("Agent step done", usage);
        },
        onError: (err) => {
          finalizeStreamingMessage();
          resetStreaming();
          setAgentStep(null);
          useStore.getState().updateLastMessage({
            content: `Agent error: ${err.message}`,
            isStreaming: false,
          });
        },
      });
    },
    [isStreaming, token, selectedModel, messages, addMessage, finalizeStreamingMessage, appendStreamChunk, setThinkContent, resetStreaming, setAgentStep, thinkingEnabled]
  );

  useEffect(() => {
    if (!bridgeMode && initialTask && !sentInitial.current) {
      sentInitial.current = true;
      handleSubmit(initialTask);
    }
  }, [initialTask, handleSubmit, bridgeMode]);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      // Abort bridge stream if running
      abortRef.current?.abort();
      exit();
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
        {/* Phase progress indicator */}
        {currentPhase !== null && (
          <Text color="cyan">
            Phase {currentPhase}/6
          </Text>
        )}
      </Box>

      {/* Current step / spinner */}
      {agentCurrentStep && (
        <Box gap={1} paddingX={1}>
          <Spinner />
          <Text color="cyan">{agentCurrentStep}</Text>
        </Box>
      )}

      {/* Message list */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <MessageList messages={messages} />
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
          <SelectInput
            items={pendingChoice.choices.map((c) => ({
              value: c.id,
              label: c.label,
            }))}
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
          borderColor="cyan"
          paddingX={1}
          marginX={1}
        >
          <Text bold color="cyan">✍️  {awaitingFreeText}</Text>
          <InputBar onSubmit={handleFreeTextSubmit} isDisabled={false} />
        </Box>
      )}

      {/* Input bar — hidden during pipeline mode (input is only via HIL choices) */}
      {!bridgeMode && (
        <InputBar
          onSubmit={handleSubmit}
          isDisabled={isStreaming}
          mode="agent"
        />
      )}
      <StatusLine modelId={selectedModel} />
    </Box>
  );
};

export default AgentScreen;
