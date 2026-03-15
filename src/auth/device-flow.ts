/**
 * Device code authentication flow — CLI side.
 *
 * Flow:
 *  1. CLI calls POST /auth/devices → gets device_id + 6-character code
 *  2. CLI displays the backend-generated code and verification URL
 *  3. CLI polls GET /auth/devices/{id}/token until status=approved
 *  4. On approval, CLI receives JWT and stores it via storage.ts
 */
import { createApiClient } from "@/api/client.js";
import { getMachineIds } from "@/auth/machine-id.js";
import {
  saveCredentials,
  clearCredentials,
  loadCredentials,
  StoredCredentials,
} from "@/auth/storage.js";
import { execFile } from "child_process";

export interface DeviceCodeResult {
  deviceId: string;
  code: string;
  expiresIn: number; // seconds
  loginUrl: string;
  launchExperience: "video" | "text";
  isFirstMachineRun: boolean;
}

export interface AuthResult {
  token: string;
  userId: string;
  plan: string;
  githubLogin?: string;
  displayName?: string;
  trialDaysRemaining?: number | null;
  billingDaysRemaining?: number | null;
}

const POLL_INTERVAL_MS = 3_000; // 3 seconds
const MAX_POLLS = 120; // 6 minutes total
const DEFAULT_WEB_BASE_URL = process.env.PAKALON_WEB_URL ?? "http://localhost:3000";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildDeviceAuthPath(deviceId: string): string {
  return `/${deviceId}/auth/`;
}

function buildDeviceAuthUrl(origin: string, deviceId: string): string {
  return `${stripTrailingSlash(origin)}${buildDeviceAuthPath(deviceId)}`;
}

function isLocalOrigin(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function openUrlInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null) => error ? reject(error) : resolve();
    if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", url], (error) => done(error));
      return;
    }
    if (process.platform === "darwin") {
      execFile("open", [url], (error) => done(error));
      return;
    }
    execFile("xdg-open", [url], (error) => done(error));
  });
}

async function isReachableWebOrigin(origin: string, deviceId: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);

  try {
    const response = await fetch(buildDeviceAuthUrl(origin, deviceId), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });

    return response.status < 500 && response.status !== 404;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveLoginUrl(deviceId: string, verificationUrl?: string): Promise<string> {
  const explicitWebBaseUrl = process.env.PAKALON_WEB_URL?.trim();
  if (explicitWebBaseUrl) {
    return buildDeviceAuthUrl(explicitWebBaseUrl, deviceId);
  }

  const fallbackUrl = buildDeviceAuthUrl(DEFAULT_WEB_BASE_URL, deviceId);

  if (verificationUrl && !isLocalOrigin(verificationUrl)) {
    return verificationUrl.endsWith("/") ? verificationUrl : `${verificationUrl}/`;
  }

  const verificationOrigin = verificationUrl ? new URL(verificationUrl).origin : null;
  const candidates = Array.from(
    new Set(
      [
        DEFAULT_WEB_BASE_URL,
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        verificationOrigin,
      ].filter((value): value is string => Boolean(value))
    )
  );

  for (const candidate of candidates) {
    if (await isReachableWebOrigin(candidate, deviceId)) {
      return buildDeviceAuthUrl(candidate, deviceId);
    }
  }

  if (verificationUrl && !isLocalOrigin(verificationUrl)) {
    return verificationUrl.endsWith("/") ? verificationUrl : `${verificationUrl}/`;
  }

  return fallbackUrl;
}

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
    verification_url?: string;
    launch_experience?: "video" | "text";
    is_first_machine_run?: boolean;
  }>("/auth/devices", {
    device_id: devDeviceId,
    machine_id: machineId,
    mac_machine_id: macMachineId,
  });

  const {
    device_id,
    code,
    expires_in,
    verification_url,
    launch_experience,
    is_first_machine_run,
  } = response.data;
  const loginUrl = await resolveLoginUrl(device_id, verification_url);

  return {
    deviceId: device_id,
    code,
    expiresIn: expires_in,
    loginUrl,
    launchExperience: launch_experience ?? "text",
    isFirstMachineRun: is_first_machine_run ?? false,
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
        github_login?: string;
        display_name?: string;
        trial_days_remaining?: number | null;
        billing_days_remaining?: number | null;
      }>(`/auth/devices/${deviceId}/token`);

      const {
        status,
        token,
        user_id,
        plan,
        github_login,
        display_name,
        trial_days_remaining,
        billing_days_remaining,
      } = response.data;

      if (status === "approved" && token && user_id) {
        return {
          token,
          userId: user_id,
          plan: plan ?? "free",
          githubLogin: github_login,
          displayName: display_name,
          trialDaysRemaining: trial_days_remaining ?? null,
          billingDaysRemaining: billing_days_remaining ?? null,
        };
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
    githubLogin: authResult.githubLogin,
    displayName: authResult.displayName,
    trialDaysRemaining: authResult.trialDaysRemaining ?? null,
    billingDaysRemaining: authResult.billingDaysRemaining ?? null,
    storedAt: new Date().toISOString(),
  };
  saveCredentials(creds);

  return authResult;
}

/**
 * Logout — clear stored credentials.
 */
export async function logout(): Promise<{
  backendLogoutAttempted: boolean;
  backendLogoutSucceeded: boolean;
  webLogoutAttempted: boolean;
  webLogoutUrl: string;
}> {
  const creds = loadCredentials();
  let backendLogoutAttempted = false;
  let backendLogoutSucceeded = false;

  if (creds?.token) {
    backendLogoutAttempted = true;
    try {
      const client = createApiClient();
      await client.post(
        "/auth/logout",
        {},
        {
          headers: {
            Authorization: `Bearer ${creds.token}`,
          },
          timeout: 5000,
        }
      );
      backendLogoutSucceeded = true;
    } catch {
      backendLogoutSucceeded = false;
    }
  }

  clearCredentials();

  const webLogoutUrl = `${stripTrailingSlash(process.env.PAKALON_WEB_URL ?? DEFAULT_WEB_BASE_URL)}/logout?source=cli`;
  try {
    await openUrlInBrowser(webLogoutUrl);
    return {
      backendLogoutAttempted,
      backendLogoutSucceeded,
      webLogoutAttempted: true,
      webLogoutUrl,
    };
  } catch {
    return {
      backendLogoutAttempted,
      backendLogoutSucceeded,
      webLogoutAttempted: false,
      webLogoutUrl,
    };
  }
}
