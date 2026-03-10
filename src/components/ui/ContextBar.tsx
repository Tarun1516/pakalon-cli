/**
 * ContextBar — prominent context-window progress bar shown under the header.
 *
 * Design: Golden separator line with progress indicator blocks
 * ───────────────────────────────────────────────────────────────
 * context window [████████░░░░░░░░] 45% used • 128k left
 */
import React from "react";
import { Box, Text } from "ink";
import { useModel, useSession } from "@/store/index.js";
import { PAKALON_GOLD, TEXT_SECONDARY, STATUS_WARNING, STATUS_ERROR } from "@/constants/colors.js";
import { getShellWidth } from "@/utils/shell-layout.js";

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

/** Decorative segmented bar matching the mockup. */
function buildBar(width = 8): string {
  return "▮".repeat(width);
}

/** Format a token count to a compact string: 1234 → "1.2k", 100000 → "100k" */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

const ContextBar: React.FC<ContextBarProps> = ({
  tokenCount,
  contextLimit,
  remainingPct,
  isStreaming = false,
}) => {
  const { selectedModel, availableModels } = useModel();
  const { remainingPct: sessionRemainingPct } = useSession();
  const terminalWidth = process.stdout.columns ?? 120;
  const shellWidth = getShellWidth(terminalWidth);
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

  // Bar color based on usage - golden at low, warning at medium, error at high
  const barColor =
    usedPct >= 80 ? STATUS_ERROR : usedPct >= 60 ? STATUS_WARNING : PAKALON_GOLD;

  const bar = buildBar(terminalWidth < 60 ? 8 : 10);
  const displayTokenCount = tokenCount ?? 0;

  const tokenLabel = effectiveContextLimit
    ? `${fmtTokens(displayTokenCount)}/${fmtTokens(effectiveContextLimit)}`
    : `${fmtTokens(displayTokenCount)}/?`;

  return (
    <Box width="100%" justifyContent="center" marginBottom={1}>
      <Box width={shellWidth} gap={1} flexWrap="wrap" paddingX={1}>
        <Text color={PAKALON_GOLD}>Context window</Text>
        <Text color={PAKALON_GOLD}>{bar}</Text>
        <Text color={barColor} bold>{usedPct}%</Text>
        <Text color={TEXT_SECONDARY}>
          <Text color={PAKALON_GOLD}>{tokenLabel}</Text> token used
        </Text>
        {isStreaming && <Text color={PAKALON_GOLD}>live</Text>}
      </Box>
    </Box>
  );
};

export default ContextBar;


