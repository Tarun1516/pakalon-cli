/**
 * ContextBar — prominent context-window progress bar shown under the header.
 */
import React from "react";
import { Box, Text } from "ink";
import * as path from "path";
import { useModel, useSession } from "@/store/index.js";

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
  const { selectedModel, availableModels } = useModel();
  const { remainingPct: sessionRemainingPct } = useSession();
  const dir = projectDir ? path.basename(projectDir) : process.cwd().split(path.sep).pop() ?? "~";
  const modelContextLimit = availableModels.find((model) => model.id === selectedModel)?.contextLength;
  const effectiveRemainingPct = remainingPct ?? sessionRemainingPct ?? undefined;
  const effectiveContextLimit = contextLimit ?? modelContextLimit;

  // Compute used% — API remaining_pct takes precedence over local estimate
  const usedPct: number =
    effectiveRemainingPct !== undefined
      ? Math.max(0, Math.min(100, 100 - effectiveRemainingPct))
      : tokenCount && effectiveContextLimit
        ? Math.min(100, Math.round((tokenCount / effectiveContextLimit) * 100))
        : 0;

  const barColor =
    usedPct >= 80 ? "red" : usedPct >= 60 ? "yellow" : "green";

  const bar = buildBar(usedPct, 26);

  // Token counts label: "83.2k / 128k"
  const tokenLabel =
    tokenCount && effectiveContextLimit
      ? `${fmtTokens(tokenCount)} / ${fmtTokens(effectiveContextLimit)}`
      : tokenCount
        ? `${fmtTokens(tokenCount)} tokens`
        : null;

  // Remaining label: "47.8k left" (or from API's remainingPct)
  const remaining =
    effectiveRemainingPct !== undefined
      ? `${Math.round(effectiveRemainingPct)}% left`
      : tokenCount && effectiveContextLimit
        ? `${fmtTokens(Math.max(0, effectiveContextLimit - tokenCount))} left`
        : null;

  return (
    <Box gap={2} paddingX={1} marginTop={0} marginBottom={0}>
      <Text color="whiteBright" bold>context window</Text>
      <Text color="white">{bar}</Text>
      <Text color={barColor} bold={usedPct >= 80}>{usedPct}% used</Text>
      {remaining && <Text dimColor>{remaining}</Text>}
      {tokenLabel && <Text dimColor>{tokenLabel}</Text>}
      <Text dimColor>{dir}</Text>
      {activeFile && <Text dimColor>{path.basename(activeFile)}</Text>}
      {isStreaming && <Text color="cyan">live</Text>}
    </Box>
  );
};

export default ContextBar;


