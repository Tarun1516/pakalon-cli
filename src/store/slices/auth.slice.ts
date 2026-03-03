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
  trialDaysRemaining: number | null;
  /** True after the user has successfully logged in at least once on this machine */
  hasEverLoggedIn: boolean;
  // Actions
  login: (creds: StoredCredentials) => void;
  logout: () => void;
  restoreSession: () => boolean;
  setPlan: (plan: "free" | "pro" | "enterprise") => void;
  setTrialDaysRemaining: (days: number) => void;
  markLaunched: () => void;
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
  trialDaysRemaining: null,
  hasEverLoggedIn: false,

  login: (creds) => {
    saveCredentials(creds);
    set({
      token: creds.token,
      userId: creds.userId,
      plan: (creds.plan as AuthState["plan"]) ?? "free",
      isLoggedIn: true,
      githubLogin: creds.githubLogin ?? null,
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
      trialDaysRemaining: null,
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
    });
    return true;
  },

  setPlan: (plan) => set({ plan }),
  setTrialDaysRemaining: (days) => set({ trialDaysRemaining: days }),
  markLaunched: () => set({ hasEverLoggedIn: true }),
});
