/**
 * TokenBudgetWarning.tsx — Ink UI component that shows warnings as context fills up.
 * T3-15: Warn at 75%, 90%, and 95% context window usage.
 */

import React from "react";
import { Box, Text } from "ink";

export interface TokenBudgetWarningProps {
  /** Tokens already used in this session. */
  tokensUsed: number;
  /** Maximum context window for the current model. */
  contextLimit: number;
  /** Optional: USD spend so far (for budget-limit display). */
  spendUsd?: number;
  /** Optional: max USD spend budget. */
  maxBudgetUsd?: number;
}

interface WarningLevel {
  threshold: number;   // fraction (0–1)
  color: string;
  label: string;
  message: string;
}

const WARNING_LEVELS: WarningLevel[] = [
  {
    threshold: 0.95,
    color: "red",
    label: "CRITICAL",
    message: "Context nearly full! Use /compact or /new to continue.",
  },
  {
    threshold: 0.90,
    color: "red",
    label: "WARNING",
    message: "Context 90% full. Consider /compact to free space.",
  },
  {
    threshold: 0.75,
    color: "yellow",
    label: "NOTICE",
    message: "Context 75% full.",
  },
];

function getWarningLevel(used: number, limit: number): WarningLevel | null {
  if (limit <= 0) return null;
  const ratio = used / limit;

  for (const level of WARNING_LEVELS) {
    if (ratio >= level.threshold) return level;
  }
  return null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * Renders nothing when context usage is below 75%.
 * Shows a colored warning bar when threshold is exceeded.
 */
const TokenBudgetWarning: React.FC<TokenBudgetWarningProps> = ({
  tokensUsed,
  contextLimit,
  spendUsd,
  maxBudgetUsd,
}) => {
  const contextWarning = getWarningLevel(tokensUsed, contextLimit);
  const budgetWarning =
    maxBudgetUsd !== undefined && spendUsd !== undefined && maxBudgetUsd > 0
      ? spendUsd / maxBudgetUsd >= 0.90
      : false;

  if (!contextWarning && !budgetWarning) return null;

  const pct = contextLimit > 0 ? Math.round((tokensUsed / contextLimit) * 100) : 0;

  return (
    <Box flexDirection="column" marginTop={0} marginBottom={0}>
      {contextWarning && (
        <Box>
          <Text color={contextWarning.color as any} bold>
            [{contextWarning.label}]
          </Text>
          <Text> </Text>
          <Text color={contextWarning.color as any}>
            {contextWarning.message}{" "}
            ({formatTokens(tokensUsed)}/{formatTokens(contextLimit)} · {pct}%)
          </Text>
        </Box>
      )}
      {budgetWarning && maxBudgetUsd !== undefined && spendUsd !== undefined && (
        <Box>
          <Text color="red" bold>
            [BUDGET]
          </Text>
          <Text> </Text>
          <Text color="red">
            Spend budget {Math.round((spendUsd / maxBudgetUsd) * 100)}% used (${spendUsd.toFixed(4)} / ${maxBudgetUsd.toFixed(2)}).
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default TokenBudgetWarning;

// ─────────────────────────────────────────────────────────────────────────────
// Utility: check thresholds imperatively (for non-React contexts)
// ─────────────────────────────────────────────────────────────────────────────

export function checkTokenBudget(
  tokensUsed: number,
  contextLimit: number
): { exceeded: boolean; level: "ok" | "notice" | "warning" | "critical"; pct: number } {
  const pct = contextLimit > 0 ? tokensUsed / contextLimit : 0;

  let level: "ok" | "notice" | "warning" | "critical" = "ok";
  if (pct >= 0.95) level = "critical";
  else if (pct >= 0.90) level = "warning";
  else if (pct >= 0.75) level = "notice";

  return { exceeded: pct >= 1.0, level, pct };
}
