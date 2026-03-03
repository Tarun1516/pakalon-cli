/**
 * /models command — inline (non-TUI) model listing and selection.
 * See ModelsScreen.tsx for the interactive TUI variant.
 * T-CLI-02: shows remaining_pct from API per model.
 */
import { getApiClient } from "@/api/client.js";
import { useStore } from "@/store/index.js";
import { debugLog } from "@/utils/logger.js";

interface ModelItem {
  model_id: string;
  name: string;
  context_window: number;
  pricing_tier: string;
  remaining_pct?: number;
}

export async function cmdListModels(): Promise<void> {
  try {
    const api = getApiClient();
    const res = await api.get<{ models: ModelItem[] }>("/models");
    const models = res.data.models ?? [];

    if (models.length === 0) {
      console.log("No models available. Try again shortly — model cache may be refreshing.");
      return;
    }

    const free = models.filter((m) => m.pricing_tier === "free");
    const pro = models.filter((m) => m.pricing_tier === "pro");

    const ctx = (n: number) =>
      n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;

    console.log("\n── Free Models ────────────────────────────────────────────────");
    for (const m of free) {
      const remaining =
        m.remaining_pct !== undefined ? ` [${m.remaining_pct}% remaining]` : "";
      console.log(`  ${m.model_id.padEnd(50)} ${ctx(m.context_window).padStart(8)}${remaining}`);
    }

    if (pro.length > 0) {
      console.log("\n── Pro Models ─────────────────────────────────────────────────");
      for (const m of pro) {
        const remaining =
          m.remaining_pct !== undefined ? ` [${m.remaining_pct}% remaining]` : "";
        console.log(`  ${m.model_id.padEnd(50)} ${ctx(m.context_window).padStart(8)}${remaining}  [PRO]`);
      }
    }

    console.log(`\nTotal: ${free.length} free, ${pro.length} pro\n`);
  } catch (err) {
    debugLog(`[models] Error listing models: ${String(err)}`);
    console.error("Failed to fetch models:", String(err));
    process.exit(1);
  }
}

export async function cmdSetModel(modelId: string): Promise<void> {
  try {
    const api = getApiClient();
    const res = await api.get<{ models: ModelItem[] }>("/models");
    const models = res.data.models ?? [];
    const found = models.find((m) => m.model_id === modelId);

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
    const res = await api.get<{ model_id: string; name: string }>("/models/auto");
    const result = res.data;
    useStore.getState().setAutoModel({ id: result.model_id, name: result.name, contextLength: 0, tier: "free" });
    console.log(`✓ Auto-selected model: ${result.model_id}`);
  } catch (err) {
    console.error("Failed to auto-select model:", String(err));
    process.exit(1);
  }
}
