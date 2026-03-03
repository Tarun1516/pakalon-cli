/**
 * Auto Context Compaction Agent
 *
 * This module provides automatic background context compaction to prevent
 * context exhaustion errors during long sessions.
 *
 * Features:
 * - Background agent that monitors context usage
 * - Automatic compaction when approaching limit
 * - Smart summarization of old messages
 * - Configurable thresholds and strategies
 */
import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

// Configuration
export interface CompactionConfig {
  /** Threshold percentage to trigger compaction (0-100) */
  thresholdPercent: number;
  /** Target percentage after compaction */
  targetPercent: number;
  /** Minimum messages to always keep */
  minMessages: number;
  /** Enable background agent */
  enabled: boolean;
  /** Check interval in ms */
  checkIntervalMs: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  thresholdPercent: 80,  // Trigger at 80% context usage
  targetPercent: 60,     // Compact down to 60%
  minMessages: 5,         // Keep at least 5 messages
  enabled: true,
  checkIntervalMs: 30000, // Check every 30 seconds
};

// State
let _config: CompactionConfig = { ...DEFAULT_COMPACTION_CONFIG };
let _compactionAgent: ReturnType<typeof setInterval> | null = null;
let _lastCompactionTime: Date | null = null;
let _compactionCount = 0;

/**
 * Update compaction configuration
 */
export function configureCompaction(config: Partial<CompactionConfig>): void {
  _config = { ..._config, ...config };
  logger.info("[Compaction] Configuration updated", _config);
}

/**
 * Get current compaction configuration
 */
export function getCompactionConfig(): CompactionConfig {
  return { ..._config };
}

/**
 * Get compaction statistics
 */
export function getCompactionStats(): {
  config: CompactionConfig;
  lastCompactionTime: Date | null;
  compactionCount: number;
} {
  return {
    config: _config,
    lastCompactionTime: _lastCompactionTime,
    compactionCount: _compactionCount,
  };
}

/**
 * Check if compaction is needed based on current usage
 */
export function isCompactionNeeded(usedTokens: number, totalTokens: number): boolean {
  if (!_config.enabled || totalTokens === 0) return false;

  const percent = (usedTokens / totalTokens) * 100;
  return percent >= _config.thresholdPercent;
}

/**
 * Calculate how many tokens to remove to reach target
 */
export function calculateCompaction(
  usedTokens: number,
  totalTokens: number,
  messageCount: number
): {
  shouldCompact: boolean;
  targetTokens: number;
  tokensToRemove: number;
  messagesToSummarize: number;
} {
  const currentPercent = (usedTokens / totalTokens) * 100;
  const targetTokens = Math.floor(totalTokens * (_config.targetPercent / 100));

  if (currentPercent < _config.thresholdPercent) {
    return {
      shouldCompact: false,
      targetTokens,
      tokensToRemove: 0,
      messagesToSummarize: 0,
    };
  }

  const tokensToRemove = Math.max(0, usedTokens - targetTokens);

  // Estimate how many messages to summarize based on average message size
  const avgMessageTokens = messageCount > 1 ? Math.floor(usedTokens / (messageCount - 1)) : usedTokens;
  const messagesToSummarize = Math.max(1, Math.min(
    Math.ceil(tokensToRemove / avgMessageTokens),
    messageCount - _config.minMessages
  ));

  return {
    shouldCompact: true,
    targetTokens,
    tokensToRemove,
    messagesToSummarize,
  };
}

/**
 * Generate a summary of old messages
 */
export function summarizeMessages(
  messages: Array<{ role: string; content: string }>,
  count: number
): string {
  if (count === 0 || messages.length === 0) return "";

  const toSummarize = messages.slice(0, count);
  const summaryParts = toSummarize.map((m, i) => {
    const preview = m.content.slice(0, 200);
    return `[${i + 1}] ${m.role}: ${preview}${m.content.length > 200 ? "..." : ""}`;
  });

  return `## Summarized ${count} Messages\n\n${summaryParts.join("\n")}`;
}

/**
 * Start the background compaction agent
 */
export function startCompactionAgent(
  getContextStats: () => { used: number; total: number; messageCount: number },
  compactFn: (targetPercent: number) => void
): void {
  if (_compactionAgent) {
    logger.warn("[Compaction] Agent already running");
    return;
  }

  _compactionAgent = setInterval(() => {
    try {
      const stats = getContextStats();
      const { shouldCompact, targetPercent } = calculateCompaction(
        stats.used,
        stats.total,
        stats.messageCount
      );

      if (shouldCompact) {
        logger.info("[Compaction] Triggering automatic compaction", {
          used: stats.used,
          total: stats.total,
          percent: Math.round((stats.used / stats.total) * 100),
          targetPercent,
        });

        compactFn(targetPercent);
        _lastCompactionTime = new Date();
        _compactionCount++;
      }
    } catch (error) {
      logger.error("[Compaction] Agent error", { error: String(error) });
    }
  }, _config.checkIntervalMs);

  logger.info("[Compaction] Agent started", { interval: _config.checkIntervalMs });
}

/**
 * Stop the background compaction agent
 */
export function stopCompactionAgent(): void {
  if (_compactionAgent) {
    clearInterval(_compactionAgent);
    _compactionAgent = null;
    logger.info("[Compaction] Agent stopped");
  }
}

/**
 * Reset compaction statistics
 */
export function resetCompactionStats(): void {
  _lastCompactionTime = null;
  _compactionCount = 0;
  logger.info("[Compaction] Statistics reset");
}

/**
 * Compact context by removing oldest messages
 */
export interface CompactionResult {
  originalCount: number;
  newCount: number;
  removedCount: number;
  summary: string | null;
}

/**
 * Create a compaction summary for removed messages
 */
export function createCompactionSummary(
  removedMessages: Array<{ role: string; content: string }>
): string {
  if (removedMessages.length === 0) return "";

  const lines = [
    `## Previous Conversation Summary (${removedMessages.length} messages)`,
    "",
    "The following messages were summarized to preserve context:",
    "",
  ];

  for (const msg of removedMessages) {
    const preview = msg.content.slice(0, 150).replace(/\n/g, " ");
    lines.push(`- **${msg.role}**: ${preview}${msg.content.length > 150 ? "..." : ""}`);
  }

  return lines.join("\n");
}
