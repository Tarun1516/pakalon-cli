/**
 * BuildScreen — T-CLI-03, T-CLI-04, T-CLI-11
 * Full pipeline TUI: streams SSE events from the Python bridge,
 * handles choice_request (Q&A) and approval_request (wireframe approval)
 * interactive prompts using ink-select-input.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "@/components/ui/Spinner.js";
import StatusLine from "@/components/ui/StatusLine.js";
import { useAuth, useStore } from "@/store/index.js";
import { BRIDGE_BASE_URL } from "@/bridge/types.js";
import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChoiceItem {
  id: string;
  label: string;
}

interface ChoiceRequest {
  type: "choice_request";
  question_index: number;
  total_questions: number;
  question: string;
  choices: ChoiceItem[];
  can_end: boolean;
  end_label?: string;
}

interface ApprovalRequest {
  type: "approval_request";
  message: string;
  question: string;
  choices: ChoiceItem[];
}

type InteractiveRequest = ChoiceRequest | ApprovalRequest;

interface PipelineEvent {
  type: string;
  content?: string;
  phase?: number;
  files?: string[];
  message?: string;
  question_index?: number;
  total_questions?: number;
  question?: string;
  choices?: ChoiceItem[];
  can_end?: boolean;
  end_label?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BuildScreenProps {
  projectDir?: string;
  userPrompt?: string;
  phase?: number;
  isYolo?: boolean;
  figmaUrl?: string;
  targetUrl?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const BuildScreen: React.FC<BuildScreenProps> = ({
  projectDir = ".",
  userPrompt = "",
  phase = 1,
  isYolo = false,
  figmaUrl,
  targetUrl = "http://localhost:3000",
}) => {
  const { exit } = useApp();
  const { userId, plan } = useAuth();
  const privacyMode = useStore((s) => s.privacyMode);

  const [logs, setLogs] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState<string>(`Phase ${phase}: Starting...`);
  const [isRunning, setIsRunning] = useState(true);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Interactive prompt state
  const [interactiveReq, setInteractiveReq] = useState<InteractiveRequest | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController>(new AbortController());

  const addLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-80), line]);
  }, []);

  // Send user response back to bridge for HIL input
  const sendResponse = useCallback(async (answer: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      await fetch(`${BRIDGE_BASE_URL}/pipeline/input/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
    } catch (err) {
      logger.error("Failed to send pipeline input", err);
    }
    setInteractiveReq(null);
  }, []);

  // Handle SelectInput item selection
  const handleSelect = useCallback(
    (item: { value: string; label: string }) => {
      sendResponse(item.value);
    },
    [sendResponse],
  );

  // Main SSE streaming effect
  useEffect(() => {
    let sse: EventSource | null = null;

    async function startPipeline() {
      try {
        // 1. Create session
        const startRes = await fetch(`${BRIDGE_BASE_URL}/pipeline/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phase,
            project_dir: projectDir,
            user_prompt: userPrompt,
            user_id: userId ?? "anonymous",
            user_plan: plan ?? "free",
            is_yolo: isYolo,
            privacy_mode: privacyMode ? "1" : "0",
            figma_url: figmaUrl ?? null,
            target_url: targetUrl,
          }),
          signal: abortRef.current.signal,
        });
        const startData = await startRes.json();
        const sessionId: string = startData?.data?.session_id;
        if (!sessionId) throw new Error("No session_id returned from bridge");
        sessionIdRef.current = sessionId;
        addLog(`🚀 Phase ${phase} started (session: ${sessionId.slice(0, 8)}...)`);

        // 2. Open SSE stream
        const params = new URLSearchParams({
          phase: String(phase),
          project_dir: projectDir,
          user_prompt: userPrompt,
          user_id: userId ?? "anonymous",
          user_plan: plan ?? "free",
          is_yolo: String(isYolo),
          privacy_mode: privacyMode ? "1" : "0",
          target_url: targetUrl,
          ...(figmaUrl ? { figma_url: figmaUrl } : {}),
        });
        const sseUrl = `${BRIDGE_BASE_URL}/pipeline/stream/${sessionId}?${params}`;

        // Use eventsource for SSE
        const EventSourceImpl =
          (global as any).EventSource ??
          (await import("eventsource") as { default?: typeof EventSource; EventSource?: typeof EventSource }).default ??
          (await import("eventsource") as { default?: typeof EventSource; EventSource?: typeof EventSource }).EventSource;

        sse = new EventSourceImpl(sseUrl) as EventSource;

        sse.onmessage = (e: MessageEvent) => {
          try {
            const evt: PipelineEvent = JSON.parse(e.data);
            handlePipelineEvent(evt);
          } catch {
            addLog(e.data);
          }
        };

        sse.onerror = (_e: Event) => {
          if (!isDone) {
            setError("SSE connection lost");
            setIsRunning(false);
          }
          sse?.close();
        };
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          const msg = err?.message ?? String(err);
          setError(msg);
          addLog(`❌ Error: ${msg}`);
        }
        setIsRunning(false);
      }
    }

    function handlePipelineEvent(evt: PipelineEvent) {
      switch (evt.type) {
        case "text_delta":
          if (evt.content) {
            const line = evt.content.replace(/\n$/, "");
            if (line) addLog(line);
            setCurrentStep(line.slice(0, 60));
          }
          break;

        case "choice_request":
          // T-CLI-03: HIL Q&A
          setInteractiveReq({
            type: "choice_request",
            question_index: evt.question_index ?? 0,
            total_questions: evt.total_questions ?? 10,
            question: evt.question ?? "",
            choices: evt.choices ?? [],
            can_end: evt.can_end ?? false,
            end_label: evt.end_label,
          });
          setCurrentStep(`Question ${(evt.question_index ?? 0) + 1}/${evt.total_questions ?? "?"}`);
          break;

        case "approval_request":
          // T-CLI-11: wireframe approval
          setInteractiveReq({
            type: "approval_request",
            message: evt.message ?? "",
            question: evt.question ?? "Approve?",
            choices: evt.choices ?? [
              { id: "accept", label: "✅ Accept" },
              { id: "skip", label: "⏭  Skip" },
            ],
          });
          setCurrentStep("Awaiting your approval…");
          break;

        case "phase_complete":
          addLog(`✅ Phase ${evt.phase} complete — ${(evt.files ?? []).length} files`);
          setCurrentStep(`Phase ${evt.phase} complete!`);
          setIsRunning(false);
          setIsDone(true);
          break;

        case "stream_end":
          setIsRunning(false);
          setIsDone(true);
          break;

        case "error":
          setError(evt.message ?? "Unknown pipeline error");
          addLog(`❌ ${evt.message ?? "Error"}`);
          setIsRunning(false);
          break;

        case "keepalive":
          // ignore
          break;

        default:
          logger.debug("Unknown pipeline event", evt);
      }
    }

    startPipeline();

    return () => {
      abortRef.current.abort();
      sse?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      abortRef.current.abort();
      exit();
    }
    if (key.escape && isDone) {
      exit();
    }
  });

  // Build SelectInput items from choice / approval request
  const selectItems = interactiveReq
    ? [
        ...(interactiveReq.choices ?? []).map((c) => ({
          value: c.id,
          label: c.label,
        })),
        ...(interactiveReq.type === "choice_request" && interactiveReq.can_end
          ? [{ value: "End phase", label: interactiveReq.end_label ?? "⏭  End Q&A and proceed" }]
          : []),
      ]
    : [];

  const visibleLogs = logs.slice(-20);

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box paddingX={1} gap={2}>
        <Text bold color="magenta">
          PAKALON BUILD
        </Text>
        <Text dimColor>Phase {phase}</Text>
        {projectDir !== "." && <Text dimColor>{projectDir}</Text>}
      </Box>

      {/* Progress indicator */}
      {isRunning && !interactiveReq && (
        <Box gap={1} paddingX={1}>
          <Spinner />
          <Text color="cyan">{currentStep}</Text>
        </Box>
      )}

      {/* Scrolling logs */}
      <Box flexGrow={1} flexDirection="column" paddingX={1} overflow="hidden">
        {visibleLogs.map((line, i) => (
          <Text key={i} dimColor={i < visibleLogs.length - 3} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>

      {/* Interactive prompt: choice_request (Q&A, T-CLI-03) */}
      {interactiveReq && interactiveReq.type === "choice_request" && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold color="cyan">
            Question {interactiveReq.question_index + 1}/{interactiveReq.total_questions}
          </Text>
          <Text bold>{interactiveReq.question}</Text>
          <Box marginTop={1}>
            <SelectInput items={selectItems} onSelect={handleSelect} />
          </Box>
        </Box>
      )}

      {/* Interactive prompt: approval_request (wireframe, T-CLI-11) */}
      {interactiveReq && interactiveReq.type === "approval_request" && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
          <Text bold color="yellow">
            Design Review
          </Text>
          {interactiveReq.message && <Text dimColor>{interactiveReq.message}</Text>}
          <Text bold>{interactiveReq.question}</Text>
          <Box marginTop={1}>
            <SelectInput items={selectItems} onSelect={handleSelect} />
          </Box>
        </Box>
      )}

      {/* Completion / error state */}
      {isDone && !error && (
        <Box paddingX={1}>
          <Text bold color="green">
            ✅ Phase {phase} completed successfully. Press Esc or Ctrl-C to exit.
          </Text>
        </Box>
      )}
      {error && (
        <Box paddingX={1}>
          <Text bold color="red">
            ❌ {error}
          </Text>
        </Box>
      )}

      <StatusLine />
    </Box>
  );
};

export default BuildScreen;
