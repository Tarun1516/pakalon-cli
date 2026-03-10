/**
 * Auth slice — manages authentication state in Zustand.
 */
import type { StateCreator } from "zustand";
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  isAuthenticated,
  type StoredCredentials,
} from "@/auth/storage.js";

export interface AuthState {
  token: string | null;
  userId: string | null;
  plan: "free" | "pro" | "enterprise";
  isLoggedIn: boolean;
  githubLogin: string | null;
  displayName: string | null;
  trialDaysRemaining: number | null;
  billingDaysRemaining: number | null;
  /** True after the user has successfully logged in at least once on this machine */
  hasEverLoggedIn: boolean;
  // Actions
  login: (creds: StoredCredentials) => void;
  logout: () => void;
  restoreSession: () => boolean;
  setPlan: (plan: "free" | "pro" | "enterprise") => void;
  setTrialDaysRemaining: (days: number) => void;
  setBillingDaysRemaining: (days: number | null) => void;
  markLaunched: () => void;
  syncProfile: (profile: {
    plan?: "free" | "pro" | "enterprise";
    githubLogin?: string | null;
    displayName?: string | null;
    trialDaysRemaining?: number | null;
    billingDaysRemaining?: number | null;
  }) => void;
}

export const createAuthSlice: StateCreator<
  AuthState,
  [],
  [],
  AuthState
> = (set) => ({
  token: null,
  userId: null,
  plan: "free",
  isLoggedIn: false,
  githubLogin: null,
  displayName: null,
  trialDaysRemaining: null,
  billingDaysRemaining: null,
  hasEverLoggedIn: false,

  login: (creds) => {
    saveCredentials(creds);
    set({
      token: creds.token,
      userId: creds.userId,
      plan: (creds.plan as AuthState["plan"]) ?? "free",
      isLoggedIn: true,
      githubLogin: creds.githubLogin ?? null,
      displayName: creds.displayName ?? null,
      trialDaysRemaining: creds.trialDaysRemaining ?? null,
      billingDaysRemaining: creds.billingDaysRemaining ?? null,
      hasEverLoggedIn: true,
    });
  },

  logout: () => {
    clearCredentials();
    set({
      token: null,
      userId: null,
      plan: "free",
      isLoggedIn: false,
      githubLogin: null,
      displayName: null,
      trialDaysRemaining: null,
      billingDaysRemaining: null,
    });
  },

  restoreSession: () => {
    if (!isAuthenticated()) return false;
    const creds = loadCredentials();
    if (!creds) return false;
    set({
      token: creds.token,
      userId: creds.userId,
      plan: (creds.plan as AuthState["plan"]) ?? "free",
      isLoggedIn: true,
      githubLogin: creds.githubLogin ?? null,
      displayName: creds.displayName ?? null,
      trialDaysRemaining: creds.trialDaysRemaining ?? null,
      billingDaysRemaining: creds.billingDaysRemaining ?? null,
    });
    return true;
  },

  setPlan: (plan) => set({ plan }),
  setTrialDaysRemaining: (days) => set({ trialDaysRemaining: days }),
  setBillingDaysRemaining: (days) => set({ billingDaysRemaining: days }),
  markLaunched: () => set({ hasEverLoggedIn: true }),
  syncProfile: (profile) => {
    set((state) => {
      const nextState = {
        plan: profile.plan ?? state.plan,
        githubLogin: profile.githubLogin ?? state.githubLogin,
        displayName: profile.displayName ?? state.displayName,
        trialDaysRemaining: profile.trialDaysRemaining ?? state.trialDaysRemaining,
        billingDaysRemaining: profile.billingDaysRemaining ?? state.billingDaysRemaining,
      };

      const stored = loadCredentials();
      if (stored) {
        saveCredentials({
          ...stored,
          plan: nextState.plan,
          githubLogin: nextState.githubLogin ?? undefined,
          displayName: nextState.displayName ?? undefined,
          trialDaysRemaining: nextState.trialDaysRemaining,
          billingDaysRemaining: nextState.billingDaysRemaining,
        });
      }

      return nextState;
    });
  },
});
