/**
 * retry.ts — Exponential backoff + jitter for API calls.
 * T0-4: All LLM and external API calls retry on transient failures (429, 5xx).
 */

export interface RetryOptions {
  /** Maximum number of attempts (default: 5) */
  maxAttempts?: number;
  /** Base delay in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 30_000) */
  maxDelayMs?: number;
  /** Status codes to retry on (default: [429, 500, 502, 503, 504]) */
  retryStatusCodes?: number[];
  /** Called on each retry with attempt number, delay, and error */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

const DEFAULT_RETRY_CODES = [429, 500, 502, 503, 504];

/**
 * Sleep for ms milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute delay with full jitter: random value in [0, base * 2^attempt].
 */
function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  return Math.floor(Math.random() * capped);
}

/**
 * Wrap an async function with exponential-backoff retry logic.
 *
 * @example
 * const data = await withRetry(() => fetch('https://...'), { maxAttempts: 5 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    retryStatusCodes = DEFAULT_RETRY_CODES,
    onRetry,
  } = options;

  let lastError: Error = new Error("Unknown error");

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Determine if this error is retryable
      const status: number | undefined =
        err?.response?.status ??
        err?.status ??
        (typeof err?.code === "number" ? err.code : undefined);

      const isRetryable =
        (status !== undefined && retryStatusCodes.includes(status)) ||
        err?.code === "ECONNRESET" ||
        err?.code === "ETIMEDOUT" ||
        err?.code === "ENOTFOUND" ||
        err?.message?.includes("network") ||
        err?.message?.includes("timeout");

      if (!isRetryable || attempt === maxAttempts - 1) {
        throw lastError;
      }

      // Respect Retry-After header if present (429 responses)
      let delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
      const retryAfter = err?.response?.headers?.["retry-after"];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) {
          delayMs = Math.min(parsed * 1000, maxDelayMs);
        }
      }

      onRetry?.(attempt + 1, delayMs, lastError);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Retry-aware wrapper for the Axios API client.
 * Integrates with the pakalon API client automatically.
 */
export function createRetryInterceptor(options: Omit<RetryOptions, "onRetry"> = {}) {
  return {
    onRejected: async (error: any) => {
      const config = error?.config;
      if (!config) throw error;

      // Track retry count in config
      config._retryCount = (config._retryCount ?? 0) + 1;
      const maxAttempts = options.maxAttempts ?? 5;

      if (config._retryCount >= maxAttempts) throw error;

      const status = error?.response?.status;
      const retryOn = options.retryStatusCodes ?? DEFAULT_RETRY_CODES;

      if (!retryOn.includes(status) && !["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(error?.code)) {
        throw error;
      }

      // Compute delay
      let delayMs = computeDelay(config._retryCount - 1, options.baseDelayMs ?? 1000, options.maxDelayMs ?? 30_000);
      const retryAfter = error?.response?.headers?.["retry-after"];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) delayMs = Math.min(parsed * 1000, options.maxDelayMs ?? 30_000);
      }

      if (status === 429) {
        // eslint-disable-next-line no-console
        process.stderr.write(`[pakalon] Rate limited (429). Retrying in ${Math.round(delayMs / 1000)}s (attempt ${config._retryCount}/${maxAttempts})...\n`);
      }

      await sleep(delayMs);
      // Re-use the same axios instance that threw
      return config._axiosInstance?.(config) ?? Promise.reject(error);
    },
  };
}
