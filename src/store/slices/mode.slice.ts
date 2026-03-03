/**
 * Mode slice — manages CLI interaction mode, verbose, and privacy flags.
 */
import type { StateCreator } from "zustand";

export type InteractionMode = "chat" | "agent" | "headless";

/**
 * Permission mode controls how aggressively Pakalon acts autonomously.
 * Cycles via Tab key: plan → edit → auto-accept → bypass → plan
 *
 * - plan:        Read-only; no file writes without explicit approval (safest)
 * - edit:        Suggests edits; user must approve each write
 * - auto-accept: Auto-applies all edits without prompting
 * - bypass:      Bypasses all safety gates (not recommended)
 */
export type PermissionMode = "plan" | "edit" | "auto-accept" | "bypass";
const PERMISSION_CYCLE: PermissionMode[] = ["plan", "edit", "auto-accept", "bypass"];

/** Parameters for the 6-phase bridge pipeline launched via /build */
export interface BridgeModeParams {
  userPrompt: string;
  userId: string;
  userPlan: string;
  isYolo: boolean;
  privacyMode?: boolean;
  figmaUrl?: string;
  targetUrl?: string;
}

export interface ModeState {
  mode: InteractionMode;
  /** Permission mode for file edits — cycled with Tab key (T-CLI-18) */
  permissionMode: PermissionMode;
  /** Thinking mode — sends reasoning capacity tokens to the model (T-CLI-19) */
  thinkingEnabled: boolean;
  isAgentRunning: boolean;
  agentCurrentStep: string | null;
  agentProgress: number; // 0-100
  /** Verbose mode — shows internal reasoning / tool-call panel (T164) */
  verbose: boolean;
  /** Privacy mode — suppresses Mem0 storage and external telemetry (T163) */
  privacyMode: boolean;
  /**
   * P1 — Auto Context Compaction.
   * When enabled, context is automatically semantically compressed (via the LLM summarizer)
   * when token usage exceeds `autoCompactThreshold` fraction of the context window.
   */
  autoCompact: boolean;
  /** Fraction of context window (0–1) that triggers auto-compaction. Default 0.90. */
  autoCompactThreshold: number;
  /**
   * When set, switches to AgentScreen in bridge pipeline mode (phases 1-6).
   * Cleared after pipeline completes.
   */
  pendingBridgeMode: BridgeModeParams | null;
  // Actions
  setMode: (mode: InteractionMode) => void;
  /** Cycle through plan → edit → auto-accept → bypass (bound to Tab) */
  cyclePermissionMode: () => void;
  setPermissionMode: (mode: PermissionMode) => void;
  /** Toggle extended thinking on/off (bound to Shift+Tab) */
  toggleThinking: () => void;
  setAgentRunning: (running: boolean) => void;
  setAgentStep: (step: string | null) => void;
  setAgentProgress: (progress: number) => void;
  /** Toggle verbose panel on/off (bound to Ctrl+O in InputBar) */
  toggleVerbose: () => void;
  setPrivacyMode: (enabled: boolean) => void;
  /** Toggle automatic context compaction (P1) */
  toggleAutoCompact: () => void;
  setAutoCompact: (enabled: boolean) => void;
  setAutoCompactThreshold: (threshold: number) => void;
  /** Launch the 6-phase build pipeline via the Python bridge */
  launchBridgePipeline: (params: BridgeModeParams) => void;
  clearBridgeMode: () => void;
}

export const createModeSlice: StateCreator<
  ModeState,
  [],
  [],
  ModeState
> = (set) => ({
  mode: "chat",
  permissionMode: "plan",
  thinkingEnabled: false,
  isAgentRunning: false,
  agentCurrentStep: null,
  agentProgress: 0,
  verbose: false,
  privacyMode: false,
  autoCompact: true,
  autoCompactThreshold: 0.90,
  pendingBridgeMode: null,

  setMode: (mode) => set({ mode }),
  cyclePermissionMode: () =>
    set((s) => {
      const idx = PERMISSION_CYCLE.indexOf(s.permissionMode);
      const next = PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length];
      return { permissionMode: next };
    }),
  setPermissionMode: (mode) => set({ permissionMode: mode }),
  toggleThinking: () => set((s) => ({ thinkingEnabled: !s.thinkingEnabled })),
  setAgentRunning: (running) => set({ isAgentRunning: running }),
  setAgentStep: (step) => set({ agentCurrentStep: step }),
  setAgentProgress: (progress) => set({ agentProgress: progress }),
  toggleVerbose: () => set((s) => ({ verbose: !s.verbose })),
  setPrivacyMode: (enabled) => set({ privacyMode: enabled }),
  toggleAutoCompact: () => set((s) => ({ autoCompact: !s.autoCompact })),
  setAutoCompact: (enabled) => set({ autoCompact: enabled }),
  setAutoCompactThreshold: (threshold) => set({ autoCompactThreshold: Math.max(0.5, Math.min(0.99, threshold)) }),
  launchBridgePipeline: (params) => set({ pendingBridgeMode: params, mode: "agent" }),
  clearBridgeMode: () => set({ pendingBridgeMode: null }),
});
