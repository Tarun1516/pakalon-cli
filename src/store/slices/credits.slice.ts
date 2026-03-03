/**
 * credits.slice.ts — Zustand slice for global credits state.
 * Stores the current credit balance and exposes actions to
 * refresh it from the backend.
 */
import type { StateCreator } from "zustand";
import { fetchCreditBalance, type CreditBalance } from "@/api/credits.js";

/** Context window tracking for current session */
export interface ContextUsage {
  modelId: string;
  totalTokens: number;
  usedTokens: number;
  remainingTokens: number;
  remainingPct: number;
  lastUpdated: number;
}

export interface CreditsState {
  /** Full credit balance object (null = not yet loaded or unavailable). */
  creditBalance: CreditBalance | null;
  /** True while fetching credits from backend. */
  creditsLoading: boolean;
  /** Current context window usage for the active model */
  contextUsage: ContextUsage | null;
  // ── Actions ──
  fetchCredits: () => Promise<void>;
  setCreditsBalance: (balance: CreditBalance | null) => void;
  setContextUsage: (usage: ContextUsage) => void;
  updateContextUsage: (modelId: string, usedTokens: number, totalTokens: number) => void;
}

export const createCreditsSlice: StateCreator<
  CreditsState,
  [],
  [],
  CreditsState
> = (set) => ({
  creditBalance: null,
  creditsLoading: false,
  contextUsage: null,

  fetchCredits: async () => {
    set({ creditsLoading: true });
    const balance = await fetchCreditBalance();
    set({ creditBalance: balance, creditsLoading: false });
  },

  setCreditsBalance: (balance) => {
    set({ creditBalance: balance });
  },

  setContextUsage: (usage) => set({ contextUsage: usage }),

  updateContextUsage: (modelId, usedTokens, totalTokens) =>
    set(() => {
      const remaining = Math.max(0, totalTokens - usedTokens);
      const remainingPct = totalTokens > 0 ? Math.round((remaining / totalTokens) * 100) : 100;
      return {
        contextUsage: {
          modelId,
          totalTokens,
          usedTokens,
          remainingTokens: remaining,
          remainingPct,
          lastUpdated: Date.now(),
        },
      };
    }),
});
