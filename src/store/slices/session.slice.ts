/**
 * Session slice — active chat session state.
 */
import type { StateCreator } from "zustand";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: unknown;
  createdAt: Date;
  isStreaming?: boolean;
}

export interface SessionState {
  sessionId: string | null;
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  remainingPct: number | null;
  // Actions
  setSessionId: (id: string) => void;
  setRemainingPct: (pct: number | null) => void;
  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (patch: Partial<ChatMessage> | string) => void;
  appendToLastMessage: (chunk: string) => void;
  updateMessageById: (id: string, patch: Partial<ChatMessage> | string) => void;
  appendToMessage: (id: string, chunk: string) => void;
  finalizeStreamingMessage: () => void;
  clearMessages: () => void;
  clearSession: () => void;
  setLoading: (loading: boolean) => void;
  setStreaming: (streaming: boolean) => void;
}

export const createSessionSlice: StateCreator<
  SessionState,
  [],
  [],
  SessionState
> = (set) => ({
  sessionId: null,
  messages: [],
  isLoading: false,
  isStreaming: false,
  remainingPct: null,

  setSessionId: (id: string) => set({ sessionId: id }),
  setRemainingPct: (pct: number | null) => set({ remainingPct: pct }),

  addMessage: (msg: ChatMessage) =>
    set((state: SessionState) => ({ messages: [...state.messages, msg] })),

  updateLastMessage: (patch: Partial<ChatMessage> | string) =>
    set((state: SessionState) => {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last) {
        if (typeof patch === "string") {
          msgs[msgs.length - 1] = { ...last, content: patch };
        } else {
          msgs[msgs.length - 1] = { ...last, ...patch };
        }
      }
      return { messages: msgs };
    }),

  appendToLastMessage: (chunk: string) =>
    set((state: SessionState) => {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last?.isStreaming) {
        msgs[msgs.length - 1] = { ...last, content: last.content + chunk };
      }
      return { messages: msgs };
    }),

  updateMessageById: (id: string, patch: Partial<ChatMessage> | string) =>
    set((state: SessionState) => ({
      messages: state.messages.map((message) => {
        if (message.id !== id) return message;
        if (typeof patch === "string") {
          return { ...message, content: patch };
        }
        return { ...message, ...patch };
      }),
    })),

  appendToMessage: (id: string, chunk: string) =>
    set((state: SessionState) => ({
      messages: state.messages.map((message) =>
        message.id === id && message.isStreaming
          ? { ...message, content: message.content + chunk }
          : message
      ),
    })),

  finalizeStreamingMessage: () =>
    set((state: SessionState) => ({
      messages: state.messages.map((m: ChatMessage) =>
        m.isStreaming ? { ...m, isStreaming: false } : m
      ),
      isStreaming: false,
    })),

  clearMessages: () => set({ messages: [] }),

  clearSession: () => set({ sessionId: null, messages: [], isStreaming: false }),

  setLoading: (loading: boolean) => set({ isLoading: loading }),
  setStreaming: (streaming: boolean) => set({ isStreaming: streaming }),
});
