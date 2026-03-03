/**
 * Status command — show account, plan, trial info.
 */
import { getApiClient } from "@/api/client.js";

export interface UsageInfo {
  plan: string;
  trial_days_used: number;
  trial_days_remaining: number;
  subscription_id: string | null;
  is_in_grace_period: boolean;
}

export async function cmdStatus(): Promise<UsageInfo> {
  const client = getApiClient();
  const res = await client.get<UsageInfo>("/usage");
  return res.data;
}

export function formatStatus(info: UsageInfo): string {
  const lines: string[] = [];
  lines.push(`Plan: ${info.plan.toUpperCase()}`);
  if (info.plan === "free") {
    lines.push(`Trial: ${info.trial_days_used} days used, ${info.trial_days_remaining} remaining`);
    if (info.is_in_grace_period) {
      lines.push("⚠ Trial expired — in grace period. Run `pakalon upgrade` to continue.");
    }
  } else {
    lines.push(`Subscription: ${info.subscription_id ?? "active"}`);
  }
  return lines.join("\n");
}
