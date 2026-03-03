/**
 * Upgrade command — open billing checkout URL.
 */
import { getApiClient } from "@/api/client.js";

export async function cmdUpgrade(successUrl?: string): Promise<string> {
  const client = getApiClient();
  const res = await client.post<{ checkout_url: string }>("/billing/checkout", {
    success_url: successUrl ?? "https://pakalon.com/upgraded",
  });
  return res.data.checkout_url;
}

export async function cmdCancelSubscription(): Promise<void> {
  const client = getApiClient();
  await client.delete("/billing/cancel");
}
