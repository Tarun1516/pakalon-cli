/**
 * API client — Axios-based HTTP client for Pakalon backend.
 */
import axios, { AxiosInstance, AxiosError } from "axios";
import { loadCredentials } from "@/auth/storage.js";
import { createRetryInterceptor } from "@/utils/retry.js";

const DEFAULT_BASE_URL =
  process.env.PAKALON_API_URL ?? "http://127.0.0.1:8000";

export function createApiClient(baseURL: string = DEFAULT_BASE_URL): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 30_000,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `pakalon-cli/${process.env.npm_package_version ?? "0.1.0"}`,
    },
  });

  // Attach Bearer token from stored credentials
  instance.interceptors.request.use((config) => {
    const creds = loadCredentials();
    if (creds?.token) {
      config.headers.Authorization = `Bearer ${creds.token}`;
    }
    return config;
  });

  // Exponential backoff retry (T0-4): 429, 5xx, network errors
  const retryInterceptor = createRetryInterceptor({
    maxAttempts: 4,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    retryStatusCodes: [429, 500, 502, 503, 504],
  });
  instance.interceptors.response.use(undefined, retryInterceptor.onRejected);

  // Normalize errors
  instance.interceptors.response.use(
    (res) => res,
    (err: AxiosError) => {
      const status = err.response?.status;
      const detail =
        (err.response?.data as any)?.detail ?? err.message;

      if (!err.response) {
        const networkMessage = `${err.code ?? ""} ${detail}`.toLowerCase();
        if (
          networkMessage.includes("econnrefused") ||
          networkMessage.includes("enotfound") ||
          networkMessage.includes("etimedout") ||
          networkMessage.includes("network error") ||
          networkMessage.includes("socket hang up")
        ) {
          throw new Error(
            `Could not connect to the Pakalon backend at ${baseURL}. Make sure the backend server is running and reachable.`
          );
        }
      }

      if (status === 401) {
        const err = new Error(`Authentication failed: ${detail}`);
        (err as any).statusCode = 401;
        throw err;
      }
      if (status === 403) {
        throw new Error(`Access denied: ${detail}`);
      }
      if (status === 410) {
        throw new Error(`Gone: ${detail}`);
      }
      if (status && status >= 500) {
        throw new Error(`Server error (${status}): ${detail}`);
      }

      throw err;
    }
  );

  return instance;
}

// Singleton for convenience
let _client: AxiosInstance | null = null;

export function getApiClient(): AxiosInstance {
  if (!_client) {
    _client = createApiClient();
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Session context utilisation — debounced PATCH (Epic A-06)
// ---------------------------------------------------------------------------

let _contextPatchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced update of context_pct_used for the current session.
 * Coalesces rapid updates (e.g. after every AI step) into one HTTP call
 * sent 2 seconds after the last invocation.
 */
export function syncContextPct(sessionId: string, pct: number): void {
  if (_contextPatchTimer) clearTimeout(_contextPatchTimer);
  _contextPatchTimer = setTimeout(async () => {
    try {
      await getApiClient().patch(`/sessions/${sessionId}`, {
        context_pct_used: Math.round(pct * 100) / 100,
      });
    } catch {
      // Non-critical — silently ignore network errors for context sync
    }
    _contextPatchTimer = null;
  }, 2_000);
}
