/**
 * Model slice — manages currently selected AI model.
 * T2-10: Auto-refresh available models from backend on mount + every 5 minutes.
 */
import type { StateCreator } from "zustand";
import { AxiosError } from "axios";

import { createApiClient, getApiClient } from "@/api/client.js";
import { DEFAULT_FREE_MODEL_ID } from "@/constants/models.js";

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  tier: "free" | "paid";
}

interface ApiModelRecord {
  id?: string;
  model_id?: string;
  name: string;
  context_length?: number;
  context_window?: number;
  tier?: "free" | "paid" | string;
  pricing_tier?: "free" | "pro" | string;
}

function normalizeModelRecord(model: ApiModelRecord): ModelInfo {
  const tier = model.tier ?? (model.pricing_tier === "free" ? "free" : "paid");
  return {
    id: model.id ?? model.model_id ?? "",
    name: model.name,
    contextLength: model.context_length ?? model.context_window ?? 0,
    tier: tier === "free" ? "free" : "paid",
  };
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
  modelsError: string | null;
  lastModelsFetchAt: number | null; // epoch ms
  // Actions
  setSelectedModel: (modelId: string) => void;
  setAvailableModels: (models: ModelInfo[]) => void;
  setAutoModel: (model: ModelInfo | null) => void;
  setLoadingModels: (loading: boolean) => void;
  setModelsError: (error: string | null) => void;
  setLastModelsFetchAt: (ts: number | null) => void;
  // T2-10: Fetch and refresh models from backend
  refreshModels: (apiBaseUrl?: string, authToken?: string, force?: boolean) => Promise<void>;
  // T-005: Check context window status before starting AI
  checkContextStatus: (modelId: string, apiBaseUrl?: string, authToken?: string) => Promise<ContextCheckResult>;
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
  modelsError: null,
  lastModelsFetchAt: null,

  setSelectedModel: (modelId) => set({ selectedModel: modelId }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setAutoModel: (model) => set({ autoModel: model }),
  setLoadingModels: (loading) => set({ isLoadingModels: loading }),
  setModelsError: (error) => set({ modelsError: error }),
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

    const client = apiBaseUrl ? createApiClient(apiBaseUrl) : getApiClient();
    set({ isLoadingModels: true, modelsError: null });

    try {
      const { data } = await client.get<{ models: ApiModelRecord[] }>("/models?include_all=true", {
        headers: authToken
          ? { Authorization: `Bearer ${authToken}` }
          : undefined,
      });

      const models: ModelInfo[] = (data.models ?? [])
        .map(normalizeModelRecord)
        .filter((model) => Boolean(model.id));

      set({
        availableModels: models,
        lastModelsFetchAt: Date.now(),
        isLoadingModels: false,
        modelsError: null,
      });

      // Auto-select the preferred free model if nothing is selected yet.
      if (!get().selectedModel && models.length > 0) {
        const preferredFree = models.find((model) => model.id === DEFAULT_FREE_MODEL_ID);
        const firstFree = models.find((model) => model.tier === "free") ?? models[0];
        const nextModel = preferredFree ?? firstFree;
        if (nextModel) {
          set({ selectedModel: nextModel.id });
        }
      }
    } catch (err) {
      // Non-fatal: keep existing models, just stop loading
      const message = err instanceof Error ? err.message : "Unable to load models.";
      set({ isLoadingModels: false, modelsError: message });
    }
  },

  /**
   * T-005: Check context window status for a specific model.
   * Returns { exhausted, remaining_pct, message } - throws on 429 (exhausted).
   * The backend returns 429 when context is exhausted.
   */
  checkContextStatus: async (modelId: string, apiBaseUrl?: string, authToken?: string) => {
    const client = apiBaseUrl ? createApiClient(apiBaseUrl) : getApiClient();

    try {
      const { data } = await client.get<ContextCheckResult>(`/models/${encodeURIComponent(modelId)}/context`, {
        headers: authToken
          ? { Authorization: `Bearer ${authToken}` }
          : undefined,
      });
      return {
        model_id: data.model_id ?? modelId,
        exhausted: data.exhausted ?? false,
        remaining_pct: data.remaining_pct ?? 100,
        message: data.message,
      };
    } catch (err) {
      const axiosError = err as AxiosError<{ detail?: string }>;
      if (axiosError.response?.status === 429) {
        return {
          model_id: modelId,
          exhausted: true,
          remaining_pct: 0,
          message: axiosError.response.data?.detail || `Context exhausted for ${modelId}. Use /model switch to continue.`,
        };
      }
      throw err;
    }
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
