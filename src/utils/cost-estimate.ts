/**
 * cost-estimate.ts — Token cost estimation for model responses.
 * T3-13: Show estimated cost before/after each AI call.
 *
 * Uses approximate pricing data; actual billing is through the Pakalon backend.
 */

export interface ModelPricing {
  modelId: string;
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
}

/** Static pricing table (approximate; updated periodically). */
export const MODEL_PRICING: ModelPricing[] = [
  { modelId: "openai/gpt-4o",             inputPer1M: 2.50,  outputPer1M: 10.00 },
  { modelId: "openai/gpt-4o-mini",        inputPer1M: 0.15,  outputPer1M: 0.60  },
  { modelId: "openai/gpt-4-turbo",        inputPer1M: 10.00, outputPer1M: 30.00 },
  { modelId: "openai/o1",                 inputPer1M: 15.00, outputPer1M: 60.00 },
  { modelId: "openai/o1-mini",            inputPer1M: 3.00,  outputPer1M: 12.00 },
  { modelId: "anthropic/claude-3-5-sonnet-20241022", inputPer1M: 3.00,  outputPer1M: 15.00 },
  { modelId: "anthropic/claude-3-5-haiku-20241022",  inputPer1M: 0.80,  outputPer1M: 4.00  },
  { modelId: "anthropic/claude-3-opus-20240229",     inputPer1M: 15.00, outputPer1M: 75.00 },
  { modelId: "google/gemini-1.5-pro",     inputPer1M: 1.25,  outputPer1M: 5.00  },
  { modelId: "google/gemini-1.5-flash",   inputPer1M: 0.075, outputPer1M: 0.30  },
  { modelId: "meta-llama/llama-3.1-70b-instruct",    inputPer1M: 0.52,  outputPer1M: 0.75  },
  { modelId: "meta-llama/llama-3.1-8b-instruct",     inputPer1M: 0.065, outputPer1M: 0.065 },
  { modelId: "mistralai/mistral-large",   inputPer1M: 2.00,  outputPer1M: 6.00  },
  { modelId: "qwen/qwen-2-72b-instruct",  inputPer1M: 0.90,  outputPer1M: 0.90  },
];

/** Fallback pricing for unknown models (conservative estimate). */
const FALLBACK_PRICING: ModelPricing = {
  modelId: "unknown",
  inputPer1M: 2.00,
  outputPer1M: 8.00,
};

export function getPricing(modelId: string): ModelPricing {
  return MODEL_PRICING.find((p) => modelId.startsWith(p.modelId)) ?? FALLBACK_PRICING;
}

/** Calculate cost in USD for a given token usage. */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): { inputCost: number; outputCost: number; totalCost: number } {
  const pricing = getPricing(modelId);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

/** Format a cost as a human-readable string. */
export function formatCost(usd: number): string {
  if (usd < 0.0001) return "< $0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Estimate token count from text (rough: ~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Full formatted cost line for a chat turn. */
export function formatTurnCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): string {
  const { inputCost, outputCost, totalCost } = calculateCost(modelId, inputTokens, outputTokens);
  return `${formatCost(totalCost)} (${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out @ ${formatCost(inputCost + outputCost)})`;
}

/** Running session cost tracker. */
export class SessionCostTracker {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  private turns = 0;

  record(modelId: string, inputTokens: number, outputTokens: number): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    const { totalCost } = calculateCost(modelId, inputTokens, outputTokens);
    this.totalCostUsd += totalCost;
    this.turns++;
  }

  summary(): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    turns: number;
    formatted: string;
  } {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCostUsd: this.totalCostUsd,
      turns: this.turns,
      formatted: `Session: ${this.turns} turn(s), ${formatCost(this.totalCostUsd)} total (${this.totalInputTokens.toLocaleString()} in · ${this.totalOutputTokens.toLocaleString()} out)`,
    };
  }

  reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCostUsd = 0;
    this.turns = 0;
  }
}
