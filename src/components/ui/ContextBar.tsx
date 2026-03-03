/**
 * ContextBar — live context window usage + credits display.
 * Shows project directory, a visual progress bar, token counts, streaming state,
 * and remaining AI credits for the current billing period.
 * T-CLI-01: updates live whenever getContextStats() fires via contextEvents.
 */
import React from "react";
import { Box, Text } from "ink";
import * as path from "path";

interface ContextBarProps {
  projectDir?: string;
  activeFile?: string;
  tokenCount?: number;
  contextLimit?: number;
  /** Remaining context % from API (0-100). Takes precedence over local calculation. */
  remainingPct?: number;
  /** True while the AI is actively streaming a response */
  isStreaming?: boolean;
  /** Credits remaining in the current billing period (undefined = not loaded / free tier) */
  creditsRemaining?: number;
  /** Total credits allocated this period */
  creditsTotal?: number;
}

/** Build a compact ASCII progress bar of fixed width */
function buildBar(pct: number, width = 12): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty));
}

/** Format a token count to a compact string: 1234 → "1.2k", 100000 → "100k" */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

const ContextBar: React.FC<ContextBarProps> = ({
  projectDir,
  activeFile,
  tokenCount,
  contextLimit,
  remainingPct,
  isStreaming = false,
  creditsRemaining,
  creditsTotal,
}) => {
  const dir = projectDir ? path.basename(projectDir) : process.cwd().split(path.sep).pop() ?? "~";

  // Compute used% — API remaining_pct takes precedence over local estimate
  const usedPct: number =
    remainingPct !== undefined
      ? Math.max(0, Math.min(100, 100 - remainingPct))
      : tokenCount && contextLimit
        ? Math.min(100, Math.round((tokenCount / contextLimit) * 100))
        : 0;

  const barColor =
    usedPct >= 80 ? "red" : usedPct >= 60 ? "yellow" : "green";

  const bar = buildBar(usedPct);

  // Token counts label: "83.2k / 128k"
  const tokenLabel =
    tokenCount && contextLimit
      ? `${fmtTokens(tokenCount)} / ${fmtTokens(contextLimit)}`
      : tokenCount
        ? `${fmtTokens(tokenCount)} tokens`
        : null;

  // Remaining label: "47.8k left" (or from API's remainingPct)
  const remaining =
    remainingPct !== undefined
      ? `${Math.round(remainingPct)}% left`
      : tokenCount && contextLimit
        ? `${fmtTokens(Math.max(0, contextLimit - tokenCount))} left`
        : null;

  // Credits label: shown only when plan uses credits
  const showCredits =
    creditsTotal !== undefined && creditsTotal > 0 && creditsRemaining !== undefined;
  const creditsPct = showCredits
    ? Math.round(((creditsRemaining ?? 0) / (creditsTotal ?? 1)) * 100)
    : 0;
  const creditsColor =
    creditsPct <= 10 ? "red" : creditsPct <= 25 ? "yellow" : "cyan";

  return (
    <Box gap={1} paddingX={1}>
      {/* Directory */}
      <Text color="cyan">📁 {dir}</Text>

      {/* Active file */}
      {activeFile && (
        <Text dimColor>{path.basename(activeFile)}</Text>
      )}

      {/* Visual progress bar */}
      <Text color={barColor}>{bar}</Text>

      {/* Used% label */}
      <Text color={barColor} bold={usedPct >= 80}>
        {usedPct}%
      </Text>

      {/* Token counts */}
      {tokenLabel && (
        <Text dimColor>{tokenLabel}</Text>
      )}

      {/* Remaining */}
      {remaining && (
        <Text color={usedPct >= 80 ? "red" : usedPct >= 60 ? "yellow" : "gray"}>
          ({remaining})
        </Text>
      )}

      {/* Credits display */}
      {showCredits && (
        <Text color={creditsColor}>
          ⚡ {creditsRemaining}/{creditsTotal} cr
        </Text>
      )}

      {/* Streaming indicator */}
      {isStreaming && (
        <Text color="magenta" dimColor>⟳ streaming</Text>
      )}
    </Box>
  );
};

export default ContextBar;


