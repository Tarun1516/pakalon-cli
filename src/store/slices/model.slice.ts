/**
 * Model slice — manages currently selected AI model.
 * T2-10: Auto-refresh available models from backend on mount + every 5 minutes.
 */
import type { StateCreator } from "zustand";

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  tier: "free" | "paid";
}

/** Context check result from backend */
export interface ContextCheckResult {
  model_id: string;
  remaining_pct: number;
  exhausted: boolean;
  message?: string;
}

export interface ModelState {
  selectedModel: string | null;
  availableModels: ModelInfo[];
  autoModel: ModelInfo | null;
  isLoadingModels: boolean;
  lastModelsFetchAt: number | null; // epoch ms
  // Actions
  setSelectedModel: (modelId: string) => void;
  setAvailableModels: (models: ModelInfo[]) => void;
  setAutoModel: (model: ModelInfo | null) => void;
  setLoadingModels: (loading: boolean) => void;
  setLastModelsFetchAt: (ts: number | null) => void;
  // T2-10: Fetch and refresh models from backend
  refreshModels: (apiBaseUrl?: string, authToken?: string) => Promise<void>;
  // T-005: Check context window status before starting AI
  checkContextExhaustion: (modelId: string, apiBaseUrl?: string, authToken?: string) => Promise<ContextCheckResult>;
}

// Auto-refresh interval: 5 minutes
const MODEL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export const createModelSlice: StateCreator<
  ModelState,
  [],
  [],
  ModelState
> = (set, get) => ({
  selectedModel: null,
  availableModels: [],
  autoModel: null,
  isLoadingModels: false,
  lastModelsFetchAt: null,

  setSelectedModel: (modelId) => set({ selectedModel: modelId }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setAutoModel: (model) => set({ autoModel: model }),
  setLoadingModels: (loading) => set({ isLoadingModels: loading }),
  setLastModelsFetchAt: (ts) => set({ lastModelsFetchAt: ts }),

  /**
   * T2-10: Fetch models from the Pakalon backend and update the store.
   * Skips the request if models were fetched less than MODEL_REFRESH_INTERVAL_MS ago.
   *
   * @param apiBaseUrl  Override for the API base URL (default: PAKALON_API_URL env or https://api.pakalon.com)
   * @param authToken   Bearer token for authenticated requests
   * @param force       Skip cache check and always refetch
   */
  refreshModels: async (apiBaseUrl?: string, authToken?: string, force = false) => {
    const now = Date.now();
    const last = get().lastModelsFetchAt;

    // Debounce: skip if fetched recently
    if (!force && last !== null && now - last < MODEL_REFRESH_INTERVAL_MS) {
      return;
    }

    const baseUrl = apiBaseUrl ?? process.env.PAKALON_API_URL ?? "http://localhost:8000";
    set({ isLoadingModels: true });

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
      }

      const res = await fetch(`${baseUrl}/models`, { headers });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }

      const data = await res.json() as {
        models: Array<{ model_id: string; name: string; context_window: number; pricing_tier: string }>
      };

      const models: ModelInfo[] = (data.models ?? []).map((m) => ({
        id: m.model_id,
        name: m.name,
        contextLength: m.context_window,
        tier: m.pricing_tier === "pro" ? "paid" : "free",
      }));

      set({
        availableModels: models,
        lastModelsFetchAt: Date.now(),
        isLoadingModels: false,
      });

      // Auto-select first free model if nothing is selected yet
      if (!get().selectedModel && models.length > 0) {
        const firstFree = models.find((m) => m.tier === "free") ?? models[0];
        if (firstFree) {
          set({ selectedModel: firstFree.id });
        }
      }
    } catch (err) {
      // Non-fatal: keep existing models, just stop loading
      set({ isLoadingModels: false });
      // Don't reset lastModelsFetchAt — avoid hammering on repeated errors
      if (process.env.NODE_ENV !== "production") {
        console.warn("[model-slice] refreshModels failed:", err);
      }
    }
  },

  /**
   * T-005: Check context window status for a specific model.
   * Returns { exhausted, remaining_pct, message } - throws on 429 (exhausted).
   * The backend returns 429 when context is exhausted.
   */
  checkContextStatus: async (modelId: string, apiBaseUrl?: string, authToken?: string) => {
    const baseUrl = apiBaseUrl ?? process.env.PAKALON_API_URL ?? "http://localhost:8000";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const res = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}/context`, {
      headers,
    });

    // 429 means context exhausted - this is expected, not an error
    if (res.status === 429) {
      const detail = await res.text();
      // Extract message from response or use default
      return {
        exhausted: true,
        remaining_pct: 0,
        message: detail || `Context exhausted for ${modelId}. Use /model switch to continue.`,
      };
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as ContextCheckResult;
    return {
      exhausted: data.exhausted ?? false,
      remaining_pct: data.remaining_pct ?? 100,
      message: data.message,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// T2-10: Background auto-refresh helper (call once on app mount)
// ─────────────────────────────────────────────────────────────────────────────

let _autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a background interval that refreshes models every MODEL_REFRESH_INTERVAL_MS.
 * Call from App root or ChatScreen on mount. Safe to call multiple times (idempotent).
 *
 * @param getToken  Callback that returns the current auth token (may change over time)
 * @param getStore  Callback that returns the current refreshModels function
 */
export function startModelAutoRefresh(
  getToken: () => string | null,
  getStore: () => { refreshModels: ModelState["refreshModels"] },
  apiBaseUrl?: string
): () => void {
  if (_autoRefreshTimer !== null) return () => stopModelAutoRefresh();

  // Immediate first fetch
  const { refreshModels } = getStore();
  refreshModels(apiBaseUrl, getToken() ?? undefined).catch(() => {});

  _autoRefreshTimer = setInterval(() => {
    const { refreshModels: refresh } = getStore();
    refresh(apiBaseUrl, getToken() ?? undefined).catch(() => {});
  }, MODEL_REFRESH_INTERVAL_MS);

  return () => stopModelAutoRefresh();
}

export function stopModelAutoRefresh(): void {
  if (_autoRefreshTimer !== null) {
    clearInterval(_autoRefreshTimer);
    _autoRefreshTimer = null;
  }
}
