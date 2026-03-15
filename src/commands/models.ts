/**
 * /models command — inline (non-TUI) model listing and selection.
 * See ModelsScreen.tsx for the interactive TUI variant.
 * T-CLI-02: shows remaining_pct from API per model.
 */
import { getApiClient } from "@/api/client.js";
import { useStore } from "@/store/index.js";
import { debugLog } from "@/utils/logger.js";
import axios from "axios";

interface ModelItem {
  id?: string;
  model_id?: string;
  name: string;
  context_length?: number;
  context_window?: number;
  tier?: string;
  pricing_tier?: string;
  remaining_pct?: number;
}

function normalizeModel(model: ModelItem) {
  const tier: "free" | "paid" = (model.tier ?? (model.pricing_tier === "free" ? "free" : "paid")) === "free"
    ? "free"
    : "paid";
  return {
    id: model.id ?? model.model_id ?? "",
    name: model.name,
    contextLength: model.context_length ?? model.context_window ?? 0,
    tier,
    remainingPct: model.remaining_pct,
  };
}

/**
 * Backward-compatible utility used by tests and scripts.
 * Fetches the public OpenRouter model catalog directly.
 */
export async function fetchModels(): Promise<Array<{ id: string; name: string; context_length?: number }>> {
  const client = (axios as unknown as { default?: { get?: typeof axios.get }; get?: typeof axios.get });
  const get = client.get ?? client.default?.get;
  if (!get) return [];

  const res = await get<{ data?: Array<{ id: string; name: string; context_length?: number }>; models?: Array<{ id: string; name: string; context_length?: number }> }>(
    "https://openrouter.ai/api/v1/models",
    {
      headers: { Accept: "application/json" },
      timeout: 20_000,
    },
  );

  const payload = res.data as {
    data?: Array<{ id: string; name: string; context_length?: number }>;
    models?: Array<{ id: string; name: string; context_length?: number }>;
  };

  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  return [];
}

export async function cmdListModels(): Promise<void> {
  try {
    const api = getApiClient();
    const res = await api.get<{ models: ModelItem[] }>("/models?include_all=true");
    const models = (res.data.models ?? []).map(normalizeModel).filter((model) => Boolean(model.id));

    if (models.length === 0) {
      console.log("No models available. Try again shortly — model cache may be refreshing.");
      return;
    }

    const free = models.filter((m) => m.tier === "free");
    const paid = models.filter((m) => m.tier !== "free");

    const ctx = (n: number) =>
      n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;

    console.log("\n── Free Models ────────────────────────────────────────────────");
    for (const m of free) {
      const remaining =
        m.remainingPct !== undefined ? ` [${m.remainingPct}% remaining]` : "";
      console.log(`  ${m.id.padEnd(50)} ${ctx(m.contextLength).padStart(8)}${remaining}`);
    }

    if (paid.length > 0) {
      console.log("\n── Pro Models ─────────────────────────────────────────────────");
      for (const m of paid) {
        const remaining =
          m.remainingPct !== undefined ? ` [${m.remainingPct}% remaining]` : "";
        console.log(`  ${m.id.padEnd(50)} ${ctx(m.contextLength).padStart(8)}${remaining}  [PRO]`);
      }
    }

    console.log(`\nTotal: ${free.length} free, ${paid.length} pro\n`);
  } catch (err) {
    debugLog(`[models] Error listing models: ${String(err)}`);
    console.error("Failed to fetch models:", String(err));
    process.exit(1);
  }
}

export async function cmdSetModel(modelId: string): Promise<void> {
  try {
    const api = getApiClient();
    const res = await api.get<{ models: ModelItem[] }>("/models?include_all=true");
    const models = (res.data.models ?? []).map(normalizeModel).filter((model) => Boolean(model.id));
    const found = models.find((m) => m.id === modelId);

    if (!found) {
      console.error(`Model "${modelId}" not found. Run \`pakalon model list\` to see available models.`);
      process.exit(1);
    }

    useStore.getState().setSelectedModel(modelId);
    console.log(`✓ Model set to: ${modelId}`);
    debugLog(`[models] Model set to ${modelId}`);
  } catch (err) {
    console.error("Failed to set model:", String(err));
    process.exit(1);
  }
}

export async function cmdAutoModel(): Promise<void> {
  try {
    const api = getApiClient();
    const res = await api.get<{ id?: string; model_id?: string; name: string; context_length?: number; context_window?: number; tier?: string; pricing_tier?: string }>("/models/auto");
    const result = res.data;
    const normalized = normalizeModel(result);
    useStore.getState().setAutoModel(normalized);
    console.log(`✓ Auto-selected model: ${normalized.id}`);
  } catch (err) {
    console.error("Failed to auto-select model:", String(err));
    process.exit(1);
  }
}
