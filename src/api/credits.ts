/**
 * credits.ts — Credits API module
 * Wraps /credits/balance and /credits/history endpoints.
 */
import { getApiClient } from "@/api/client.js";

export interface CreditBalance {
  user_id: string;
  plan: string;
  credits_total: number;
  credits_used: number;
  credits_remaining: number;
  period_start: string;
  period_end: string;
}

export interface CreditHistoryEntry {
  period_start: string;
  period_end: string;
  plan: string;
  credits_total: number;
  credits_used: number;
  credits_remaining: number;
}

/**
 * Fetch the current credit balance from the backend.
 * Returns null if the request fails (e.g. offline / 401).
 */
export async function fetchCreditBalance(): Promise<CreditBalance | null> {
  try {
    const client = getApiClient();
    const { data } = await client.get<CreditBalance>("/credits/balance");
    return data;
  } catch {
    return null;
  }
}

/**
 * Fetch up to 12 months of credit usage history.
 */
export async function fetchCreditHistory(): Promise<CreditHistoryEntry[]> {
  try {
    const client = getApiClient();
    const { data } = await client.get<CreditHistoryEntry[]>("/credits/history");
    return data;
  } catch {
    return [];
  }
}

export interface StartupCheckResult {
  can_interact: boolean;
  credits_remaining: number;
  plan: string;
  reason?: string;
}

/**
 * Check whether the user can interact with the app at startup.
 * Returns { can_interact: true } if credits are available, or
 * { can_interact: false, reason: "..." } when blocked.
 * Returns null on network / auth error (assume can_interact = true to avoid false-blocking).
 */
export async function checkStartupCredits(): Promise<StartupCheckResult | null> {
  try {
    const client = getApiClient();
    const { data } = await client.get<StartupCheckResult>("/credits/startup-check");
    return data;
  } catch {
    return null; // non-blocking on error
  }
}
