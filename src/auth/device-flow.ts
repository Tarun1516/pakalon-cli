/**
 * Device code authentication flow — CLI side.
 *
 * Flow:
 *  1. CLI calls POST /auth/devices → gets device_id + 6-digit code
 *  2. CLI displays code to user with pakalon.com/login?code=XXXXXX URL
 *  3. CLI polls GET /auth/devices/{id}/token until status=approved
 *  4. On approval, CLI receives JWT and stores it via storage.ts
 */
import { createApiClient } from "@/api/client.js";
import { getMachineIds } from "@/auth/machine-id.js";
import {
  saveCredentials,
  clearCredentials,
  StoredCredentials,
} from "@/auth/storage.js";

export interface DeviceCodeResult {
  deviceId: string;
  code: string;
  expiresIn: number; // seconds
  loginUrl: string;
}

export interface AuthResult {
  token: string;
  userId: string;
  plan: string;
}

const POLL_INTERVAL_MS = 3_000; // 3 seconds
const MAX_POLLS = 120; // 6 minutes total

/**
 * Step 1 — Request a device code from the server.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResult> {
  const client = createApiClient();
  const { machineId, macMachineId, devDeviceId } = await getMachineIds();

  const response = await client.post<{
    device_id: string;
    code: string;
    expires_in: number;
  }>("/auth/devices", {
    device_id: devDeviceId,
    machine_id: machineId,
    mac_machine_id: macMachineId,
  });

  const { device_id, code, expires_in } = response.data;
  const webBaseUrl = process.env.PAKALON_WEB_URL ?? "http://localhost:3000";
  const loginUrl = `${webBaseUrl}/${device_id}/auth`;

  return {
    deviceId: device_id,
    code,
    expiresIn: expires_in,
    loginUrl,
  };
}

/**
 * Step 2 — Poll for token approval.
 *
 * Resolves with AuthResult when approved.
 * Rejects with Error if expired or max retries exceeded.
 */
export async function pollForToken(
  deviceId: string,
  onPoll?: (attempt: number) => void
): Promise<AuthResult> {
  const client = createApiClient();

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));

    onPoll?.(attempt);

    try {
      const response = await client.get<{
        status: string;
        token?: string;
        user_id?: string;
        plan?: string;
      }>(`/auth/devices/${deviceId}/token`);

      const { status, token, user_id, plan } = response.data;

      if (status === "approved" && token && user_id) {
        return { token, userId: user_id, plan: plan ?? "free" };
      }

      if (status === "expired") {
        throw new Error("Device code expired. Please run `pakalon` again to retry.");
      }

      // status === "pending" — keep polling
    } catch (err: any) {
      if (err?.response?.status === 410) {
        throw new Error("Device code expired.");
      }
      if (err?.message?.includes("expired")) throw err;
      // Network errors are retried
    }
  }

  throw new Error("Timed out waiting for authentication. Please try again.");
}

/**
 * Full auth flow — request code, wait for approval, save credentials.
 */
export async function runDeviceAuth(
  onCode: (result: DeviceCodeResult) => void,
  onProgress?: (attempt: number) => void
): Promise<AuthResult> {
  const codeResult = await requestDeviceCode();
  onCode(codeResult);

  const authResult = await pollForToken(codeResult.deviceId, onProgress);

  const creds: StoredCredentials = {
    token: authResult.token,
    userId: authResult.userId,
    plan: authResult.plan,
    storedAt: new Date().toISOString(),
  };
  saveCredentials(creds);

  return authResult;
}

/**
 * Logout — clear stored credentials.
 */
export function logout(): void {
  clearCredentials();
}
