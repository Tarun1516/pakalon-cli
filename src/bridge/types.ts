/**
 * Python bridge types — shared between manager and client.
 */

import type { PenpotProjectState } from "@/utils/penpot-state.js";

export interface BridgeRequest {
  id: string;
  type: "agent_run" | "memory_search" | "context_build" | "ping";
  payload: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentRunPayload {
  task: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  project_dir: string;
  token: string;
  /** When true, skips Mem0 storage and external telemetry in the bridge (T163) */
  privacy_mode?: boolean;
}

export interface AgentRunResult {
  response: string;
  steps: Array<{
    type: "thought" | "tool_call" | "tool_result" | "text";
    content: string;
    tool?: string;
  }>;
  tokens_used: number;
}

export interface MemorySearchPayload {
  query: string;
  user_id: string;
  top_k?: number;
}

export interface MemorySearchResult {
  memories: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
}

export const BRIDGE_PORT = 7432;
export const BRIDGE_BASE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

// -----------------------------------------------------------------
// Pipeline SSE event types (T092)
// -----------------------------------------------------------------

export interface TextDeltaEvent {
  type: "text_delta";
  content: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: "tool_result";
  tool: string;
  result: string;
}

export interface ChoiceRequestEvent {
  type: "choice_request" | "approval_request";
  message: string;
  question: string;
  choices: Array<{ id: string; label: string }>;
}

export interface PhaseCompleteEvent {
  type: "phase_complete";
  phase: number;
  files: string[];
}

export interface AwaitingInputEvent {
  type: "awaiting_input";
  prompt: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export interface KeepAliveEvent {
  type: "keepalive";
}

export interface StreamEndEvent {
  type: "stream_end";
}

/** D-04: Emitted when Penpot browser edits are synced back to disk */
export interface DesignUpdatedEvent {
  type: "design_updated";
  message: string;
  files_updated: string[];
}

export type PhaseSSEEvent =
  | TextDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ChoiceRequestEvent
  | PhaseCompleteEvent
  | AwaitingInputEvent
  | ErrorEvent
  | KeepAliveEvent
  | StreamEndEvent
  | DesignUpdatedEvent;

export interface PipelineStartRequest {
  phase: number;
  project_dir: string;
  user_prompt: string;
  user_id: string;
  user_plan: string;
  is_yolo: boolean;
  figma_url?: string;
  target_url?: string;
}

export interface PenpotProjectStateResponse {
  status: string;
  message?: string;
  has_design: boolean;
  project_state: PenpotProjectState | Record<string, unknown> | null;
}

/** Phase/subagent status for display */
export interface PhaseStatus {
  phase: number;
  subagent?: string;
  status: "pending" | "running" | "complete" | "error";
  filesWritten?: string[];
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
