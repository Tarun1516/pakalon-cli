/**
 * /model command — list or switch the active AI model.
 */
import { getApiClient } from "@/api/client.js";
import { useStore } from "@/store/index.js";

export interface ModelInfo {
  model_id: string;
  name: string;
  tier: string;
  context_length: number;
  remaining_pct?: number | null;   // T-CLI-15: added by backend /models endpoint
}

export async function cmdListModels(): Promise<ModelInfo[]> {
  const client = getApiClient();
  const res = await client.get<{ models: ModelInfo[] }>("/models");
  return res.data.models ?? [];
}

export async function cmdSetModel(modelId: string): Promise<void> {
  const models = await cmdListModels();
  const found = models.find((m) => m.model_id === modelId || m.name.toLowerCase().includes(modelId.toLowerCase()));
  if (!found) {
    throw new Error(`Model not found: ${modelId}. Run with 'list' to see available models.`);
  }
  useStore.getState().setSelectedModel(found.model_id);
}

export async function cmdAutoModel(): Promise<ModelInfo | null> {
  const client = getApiClient();
  try {
    const res = await client.get<ModelInfo>("/models/auto");
    const model = res.data;
    useStore.getState().setAutoModel({
      id: model.model_id,
      name: model.name,
      contextLength: model.context_length,
      tier: (model.tier === "free" || model.tier === "paid") ? model.tier : "free",
    });
    return model;
  } catch {
    return null;
  }
}

/**
 * T-CLI-15: Format models list with remaining context %.
 */
export function formatModelsTable(models: ModelInfo[]): string {
  if (models.length === 0) return "No models available.";

  const lines: string[] = [
    "  Model ID".padEnd(36) + "Tier".padEnd(8) + "Ctx Len".padEnd(10) + "Remaining",
    "  " + "─".repeat(70),
  ];

  for (const m of models) {
    const id = m.model_id.slice(0, 32).padEnd(34);
    const tier = (m.tier ?? "").padEnd(6);
    const ctx = String(m.context_length ?? "").padEnd(8);
    const pct =
      m.remaining_pct != null
        ? `${Math.round(m.remaining_pct)}%`
        : "N/A";
    const pctColored =
      m.remaining_pct != null && m.remaining_pct < 20
        ? `\x1b[31m${pct}\x1b[0m`     // red if < 20%
        : m.remaining_pct != null && m.remaining_pct < 50
        ? `\x1b[33m${pct}\x1b[0m`     // yellow if < 50%
        : `\x1b[32m${pct}\x1b[0m`;   // green

    lines.push(`  ${id}  ${tier}  ${ctx}  ${pctColored}`);
  }

  return lines.join("\n");
}
