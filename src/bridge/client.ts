/**
 * Python bridge client — HTTP client for the local bridge server.
 */
import axios from "axios";
import type { BridgeRequest, BridgeResponse, AgentRunPayload, AgentRunResult, MemorySearchPayload, MemorySearchResult, PhaseSSEEvent, PipelineStartRequest, BridgeError as _BridgeError } from "./types.js";
import { BRIDGE_BASE_URL, BridgeError } from "./types.js";
import logger from "@/utils/logger.js";

const bridgeAxios = axios.create({
  baseURL: BRIDGE_BASE_URL,
  timeout: 120_000,
  headers: { "Content-Type": "application/json" },
});

export async function bridgePing(): Promise<boolean> {
  try {
    const res = await bridgeAxios.get<{ status: string }>("/health", { timeout: 2000 });
    return res.data.status === "ok";
  } catch {
    return false;
  }
}

export async function bridgeAgentRun(payload: AgentRunPayload): Promise<AgentRunResult> {
  const req: BridgeRequest = {
    id: crypto.randomUUID(),
    type: "agent_run",
    payload: payload as unknown as Record<string, unknown>,
  };
  logger.debug("Bridge agent run", { id: req.id });
  const res = await bridgeAxios.post<BridgeResponse>("/agent/run", req);
  if (!res.data.success) {
    throw new Error(res.data.error ?? "Bridge agent run failed");
  }
  return res.data.data as AgentRunResult;
}

export async function bridgeMemorySearch(payload: MemorySearchPayload): Promise<MemorySearchResult> {
  const req: BridgeRequest = {
    id: crypto.randomUUID(),
    type: "memory_search",
    payload: payload as unknown as Record<string, unknown>,
  };
  const res = await bridgeAxios.post<BridgeResponse>("/memory/search", req);
  if (!res.data.success) {
    throw new Error(res.data.error ?? "Memory search failed");
  }
  return res.data.data as MemorySearchResult;
}

// -----------------------------------------------------------------
// Pipeline SSE streaming (T091)
// -----------------------------------------------------------------

/**
 * Start a pipeline session and return a session ID.
 */
export async function bridgeStartPipeline(req: PipelineStartRequest): Promise<string> {
  const res = await bridgeAxios.post<BridgeResponse>("/pipeline/start", req);
  if (!res.data.success) {
    throw new BridgeError(res.data.error ?? "Failed to start pipeline");
  }
  const data = res.data.data as { session_id: string };
  return data.session_id;
}

/**
 * Stream SSE events from a running pipeline session.
 * onEvent is called for each parsed event.
 * Returns when stream_end is received or onAbort is called.
 */
export async function bridgeStreamPipeline(
  sessionId: string,
  params: {
    phase: number;
    project_dir: string;
    user_prompt: string;
    user_id: string;
    user_plan: string;
    is_yolo: boolean;
    privacy_mode?: boolean;
    figma_url?: string;
    target_url?: string;
  },
  onEvent: (event: PhaseSSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const urlParams = new URLSearchParams({
    phase: String(params.phase),
    project_dir: params.project_dir,
    user_prompt: params.user_prompt,
    user_id: params.user_id,
    user_plan: params.user_plan,
    is_yolo: String(params.is_yolo),
  });
  if (params.figma_url) urlParams.set("figma_url", params.figma_url);
  if (params.target_url) urlParams.set("target_url", params.target_url);

  const url = `${BRIDGE_BASE_URL}/pipeline/stream/${sessionId}?${urlParams.toString()}`;

  const headers: Record<string, string> = {};
  if (params.privacy_mode) {
    headers["X-Privacy-Mode"] = "1";
  }

  const response = await fetch(url, { signal, headers });
  if (!response.ok || !response.body) {
    throw new BridgeError(`Pipeline stream failed: ${response.status}`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          const event = JSON.parse(raw) as PhaseSSEEvent;
          onEvent(event);
          if (event.type === "stream_end") return;
        } catch {
          logger.debug("SSE parse error", raw);
        }
      }
    }
  }
}

/**
 * Send a HIL answer to a running pipeline session.
 */
export async function bridgeSendPipelineInput(sessionId: string, answer: string): Promise<void> {
  const res = await bridgeAxios.post<BridgeResponse>(
    `/pipeline/input/${sessionId}`,
    { answer },
  );
  if (!res.data.success) {
    throw new BridgeError(res.data.error ?? "Failed to send pipeline input");
  }
}
