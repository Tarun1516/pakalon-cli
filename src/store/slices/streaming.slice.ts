/**
 * Streaming slice — manages AI response streaming state.
 */
import type { StateCreator } from "zustand";

export interface StreamingState {
  streamBuffer: string;
  isStreaming: boolean;
  isThinking: boolean;
  thinkContent: string; // <think>...</think> content (for models that emit it)
  streamTokenCount: number;
  // Actions
  appendStreamChunk: (chunk: string) => void;
  setThinkContent: (updater: string | ((prev: string) => string)) => void;
  setThinking: (thinking: boolean) => void;
  appendThinkChunk: (chunk: string) => void;
  reset: () => void;
  resetStream: () => void;
  incrementTokenCount: (count: number) => void;
}

export const createStreamingSlice: StateCreator<
  StreamingState,
  [],
  [],
  StreamingState
> = (set) => ({
  streamBuffer: "",
  isStreaming: false,
  isThinking: false,
  thinkContent: "",
  streamTokenCount: 0,

  appendStreamChunk: (chunk: string) =>
    set((state: StreamingState) => ({ streamBuffer: state.streamBuffer + chunk, isStreaming: true })),

  setThinkContent: (updater: string | ((prev: string) => string)) =>
    set((state: StreamingState) => ({
      thinkContent: typeof updater === "function" ? updater(state.thinkContent) : updater,
      isThinking: true,
    })),

  setThinking: (thinking: boolean) => set({ isThinking: thinking }),

  appendThinkChunk: (chunk: string) =>
    set((state: StreamingState) => ({ thinkContent: state.thinkContent + chunk })),

  reset: () =>
    set({ streamBuffer: "", isStreaming: false, isThinking: false, thinkContent: "", streamTokenCount: 0 }),

  resetStream: () =>
    set({ streamBuffer: "", isStreaming: false, isThinking: false, thinkContent: "", streamTokenCount: 0 }),

  incrementTokenCount: (count: number) =>
    set((state: StreamingState) => ({ streamTokenCount: state.streamTokenCount + count })),
});
