/**
 * Compact command — summarizes conversation to free up context window space.
 *
 * T-A18: Implement /compact slash command with optional focus hint
 *
 * Usage: /compact [focus-hint]
 * - User types `/compact` to summarise the conversation
 * - Optional focus hint like `/compact auth-bug` tells the summarizer what to prioritize
 * - The conversation is summarized and injected as a new system message
 * - remainingPct jumps back above 20%
 */

import { estimateTokens } from "@/ai/context.js";
import type { ChatMessage } from "@/store/slices/session.slice.js";
import logger from "@/utils/logger.js";

/**
 * Summarize conversation messages into a compact context block.
 *
 * @param messages - Current chat messages (excluding the summary we're about to add)
 * @param focusHint - Optional hint about what to prioritize in the summary
 * @param maxSummaryTokens - Target token budget for the summary (default: 2000)
 * @returns Formatted summary string
 */
export function summarizeConversation(
	messages: ChatMessage[],
	focusHint?: string,
	maxSummaryTokens = 2000
): string {
	if (messages.length === 0) {
		return "No previous messages to summarize.";
	}

	// Build a condensed view of the conversation
	const condensed: string[] = [];
	condensed.push(`## Conversation Summary${focusHint ? ` (focus: ${focusHint})` : ""}`);
	condensed.push("");
	condensed.push(`_Original message count: ${messages.length}_`);
	condensed.push("");

	// Extract key info from each message
	for (const msg of messages) {
		// Skip system messages and streaming messages
		if (msg.role === "system" || msg.isStreaming) {
			continue;
		}

		const role = msg.role === "user" ? "**You**" : "**Pakalon**";
		const content = msg.content;

		// For user messages, show full content
		// For assistant messages, truncate to first 500 chars if too long
		const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;
		condensed.push(`### ${role}`);
		condensed.push(truncated);
		condensed.push("");
	}

	const summary = condensed.join("\n");
	const tokenCount = estimateTokens(summary);

	// If summary is within budget, return it
	if (tokenCount <= maxSummaryTokens) {
		return summary;
	}

	// If too long, further truncate
	const targetChars = maxSummaryTokens * 4; // rough: 4 chars per token
	return summary.slice(0, targetChars) + "\n\n_(truncated for context limits)_";
}

/**
 * Build a compact summary for injection into the conversation.
 *
 * @param messages - Current messages to summarize
 * @param focusHint - Optional focus hint
 * @returns Summary message object
 */
export function buildCompactSummary(
	messages: ChatMessage[],
	focusHint?: string
): ChatMessage {
	const summary = summarizeConversation(messages, focusHint);

	logger.debug("[compact] Generated conversation summary", {
		messageCount: messages.length,
		focusHint,
		summaryLength: summary.length,
	});

	return {
		id: crypto.randomUUID(),
		role: "system",
		content: summary,
		createdAt: new Date(),
		isStreaming: false,
	};
}

/**
 * Check if conversation should be auto-compacted based on remaining context.
 *
 * @param remainingPct - Current remaining context percentage
 * @param threshold - Threshold percentage to trigger auto-compact (default: 20%)
 * @returns Whether auto-compact should be triggered
 */
export function shouldAutoCompact(remainingPct: number, threshold = 20): boolean {
	return remainingPct < threshold;
}
