/**
 * HeaderBar — top-of-screen UI bar shown in every authenticated session.
 *
 * Layout (single row):
 *   [PAKALON logo static]  @username  [plan]  model: <id>  ctx: ███░░ 72%  compact@80%  credits: 1.2k
 *
 * The logo is the PAKALON ASCII text rendered inline (not animated).
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useAuth, useModel, useStore, useCredits } from "@/store/index.js";
import {
  getCompactionConfig,
  getCompactionStats,
  isCompactionNeeded,
} from "@/ai/auto-compaction.js";

// Inline PAKALON ASCII logo — single-line compact variant
const LOGO_LINES = [
  " ██████╗  █████╗ ██╗  ██╗ █████╗ ██╗      ██████╗ ███╗   ██╗",
  " ██╔══██╗██╔══██╗██║ ██╔╝██╔══██╗██║     ██╔═══██╗████╗  ██║",
  " ██████╔╝███████║█████╔╝ ███████║██║     ██║   ██║██╔██╗ ██║",
  " ██╔═══╝ ██╔══██║██╔═██╗ ██╔══██║██║     ██║   ██║██║╚██╗██║",
  " ██║     ██║  ██║██║  ██╗██║  ██║███████╗╚██████╔╝██║ ╚████║",
  " ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝",
];

/** Compact context-window progress bar, 10 chars wide */
function buildBar(remainingPct: number): string {
  const filledPct = Math.max(0, Math.min(100, 100 - remainingPct));
  const filled = Math.round((filledPct / 100) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function barColor(remainingPct: number): string {
  if (remainingPct <= 10) return "red";
  if (remainingPct <= 30) return "yellow";
  return "green";
}

function fmtCredits(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Inline auto-compaction status badge.
 *
 * Shows: `compact@80%` normally, turns orange/yellow when close,
 * turns red + "!" when compaction is needed, and shows "✓ compacted" briefly
 * after a compaction cycle fires.
 */
function CompactionStatusBadge({ usedTokens, totalTokens }: { usedTokens: number; totalTokens: number }) {
  const [flashMsg, setFlashMsg] = useState<string | null>(null);

  const cfg = getCompactionConfig();
  const stats = getCompactionStats();

  // Show "✓ compacted" toast for 5 s after a compaction fires
  useEffect(() => {
    if (!stats.lastCompactionTime) return;
    const elapsed = Date.now() - stats.lastCompactionTime.getTime();
    if (elapsed < 5_000) {
      setFlashMsg(`✓ compacted ×${stats.compactionCount}`);
      const t = setTimeout(() => setFlashMsg(null), 5_000 - elapsed);
      return () => clearTimeout(t);
    }
  }, [stats.lastCompactionTime, stats.compactionCount]);

  if (flashMsg) {
    return (
      <Box gap={1}>
        <Text color="greenBright" bold>{flashMsg}</Text>
      </Box>
    );
  }

  if (totalTokens === 0) return null;

  const usedPct = Math.round((usedTokens / totalTokens) * 100);
  const threshold = cfg.thresholdPercent;
  const needed = isCompactionNeeded(usedTokens, totalTokens);

  // Colour ramp: green → yellow (within 10 pts of threshold) → red (at/over threshold)
  let badgeColor: string;
  let icon: string;
  if (needed) {
    badgeColor = "red";
    icon = "⚡";
  } else if (usedPct >= threshold - 10) {
    badgeColor = "yellow";
    icon = "⚠";
  } else {
    badgeColor = "cyan";
    icon = "⊙";
  }

  return (
    <Box gap={0}>
      <Text dimColor>compact</Text>
      <Text color={badgeColor} bold>{icon}{threshold}%</Text>
      {needed && <Text color="red" bold> COMPACTING</Text>}
    </Box>
  );
}

interface HeaderBarProps {
  /** Show the logo above the info bar (default true) */
  showLogo?: boolean;
}

const HeaderBar: React.FC<HeaderBarProps> = ({ showLogo = true }) => {
  const { githubLogin, plan, trialDaysRemaining } = useAuth();
  const { selectedModel } = useModel();
  const remainingPct = useStore((s) => s.remainingPct) ?? 100;
  const { creditBalance } = useCredits();

  const creditsDisplay = creditBalance?.credits_remaining ?? null;

  // Derive token counts from remainingPct for compaction badge
  // remainingPct: % of context window remaining → usedPct = 100 - remainingPct
  // We don't always have the absolute numbers; use relative percentage
  const usedPct = Math.max(0, 100 - remainingPct);
  // Pass synthetic token counts (out of 100) so isCompactionNeeded works purely on percentage
  const syntheticUsed = usedPct;
  const syntheticTotal = 100;

  const modelShort = selectedModel
    ? selectedModel.length > 36
      ? `…${selectedModel.slice(-33)}`
      : selectedModel
    : "none";

  const planColor = plan === "pro" ? "yellow" : plan === "enterprise" ? "magenta" : "white";
  const planLabel = plan.toUpperCase();

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={0}>
      {/* ASCII Logo */}
      {showLogo && (
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
          {LOGO_LINES.map((line, i) => (
            <Text key={i} color="cyan" bold>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {/* Info row */}
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        {/* User */}
        {githubLogin && (
          <Box gap={1}>
            <Text dimColor>user</Text>
            <Text color="greenBright" bold>@{githubLogin}</Text>
          </Box>
        )}

        {/* Plan badge */}
        <Box gap={1}>
          <Text color={planColor} bold>[{planLabel}]</Text>
          {plan === "free" && trialDaysRemaining !== null && (
            <Text color={trialDaysRemaining <= 5 ? "red" : "yellow"}>
              {trialDaysRemaining}d left
            </Text>
          )}
        </Box>

        {/* Divider */}
        <Text dimColor>│</Text>

        {/* Model */}
        <Box gap={1}>
          <Text dimColor>model</Text>
          <Text color="yellowBright" bold>{modelShort}</Text>
        </Box>

        {/* Divider */}
        <Text dimColor>│</Text>

        {/* Context window */}
        <Box gap={1}>
          <Text dimColor>ctx</Text>
          <Text color={barColor(remainingPct)}>{buildBar(remainingPct)}</Text>
          <Text color={barColor(remainingPct)}>{remainingPct}%</Text>
        </Box>

        {/* Divider */}
        <Text dimColor>│</Text>

        {/* Credits */}
        <Box gap={1}>
          <Text dimColor>credits</Text>
          <Text color="cyan">{fmtCredits(creditsDisplay)}</Text>
        </Box>

        {/* Divider */}
        <Text dimColor>│</Text>

        {/* Auto-compaction status badge */}
        <CompactionStatusBadge usedTokens={syntheticUsed} totalTokens={syntheticTotal} />
      </Box>
    </Box>
  );
};

export default HeaderBar;
