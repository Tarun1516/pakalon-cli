/**
 * Context manager — builds the message context window.
 * Respects the model's context_length limit by trimming old messages.
 */
import type { ModelMessage as CoreMessage } from "ai";
import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

// Rough token estimate: 1 token ≈ 4 chars
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: CoreMessage[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + estimateTokens(content) + 4; // overhead
  }, 0);
}

/**
 * Trim the messages array to fit within `maxTokens` budget,
 * always keeping the first (system) message and last `keepTail` user messages.
 */
export function trimToContextWindow(
  messages: CoreMessage[],
  maxTokens: number,
  keepTail = 4
): CoreMessage[] {
  if (estimateMessagesTokens(messages) <= maxTokens) return messages;

  // Always keep system message (index 0) and last keepTail messages
  const system = messages[0];
  if (!system) return messages;
  const rest = messages.slice(1);
  const tail = rest.slice(-keepTail);
  let budget = maxTokens - estimateMessagesTokens([system, ...tail]);

  const middle = rest.slice(0, -keepTail);
  const kept: CoreMessage[] = [];
  for (let i = middle.length - 1; i >= 0; i--) {
    const m = middle[i];
    if (!m) continue;
    const t = estimateMessagesTokens([m]);
    if (budget - t > 0) {
      kept.unshift(m);
      budget -= t;
    } else {
      break;
    }
  }

  return [system, ...kept, ...tail];
}

export interface FileContext {
  filePath: string;
  content: string;
  tokens: number;
}

/**
 * Read a file and return it as a context message string.
 */
export function buildFileContextBlock(filePath: string, maxBytes = 16384): FileContext | null {
  try {
    const abs = path.resolve(filePath);
    const content = fs.readFileSync(abs, "utf-8").slice(0, maxBytes);
    const ext = path.extname(abs).replace(".", "");
    const block = `\`\`\`${ext}\n// File: ${abs}\n${content}\n\`\`\``;
    return { filePath: abs, content: block, tokens: estimateTokens(block) };
  } catch (err) {
    logger.warn("Could not read file for context", { filePath, err: String(err) });
    return null;
  }
}

/**
 * Build a system message that includes file contexts.
 */
export function buildSystemWithContext(
  baseSystem: string,
  fileContexts: FileContext[]
): string {
  if (fileContexts.length === 0) return baseSystem;
  const blocks = fileContexts.map((f) => f.content).join("\n\n");
  return `${baseSystem}\n\n## Active File Context\n\n${blocks}`;
}

// ---------------------------------------------------------------------------
// Context Stats — real-time token usage reporting
// ---------------------------------------------------------------------------

export interface ContextStats {
  used: number;
  total: number;
  percent: number;
  remaining: number;
  messageCount: number;
}

/**
 * Compute current context window statistics.
 * Emits a `context_stats` event on the global event emitter so the TUI
 * can display a live token usage bar.
 */
export function getContextStats(
  messages: CoreMessage[],
  maxTokens: number
): ContextStats {
  const used = estimateMessagesTokens(messages);
  const percent = Math.min(100, Math.round((used / maxTokens) * 100));
  const stats: ContextStats = {
    used,
    total: maxTokens,
    percent,
    remaining: Math.max(0, maxTokens - used),
    messageCount: messages.length,
  };
  // Emit to global event target so UI components can subscribe
  contextEvents.emit("context_stats", stats);
  return stats;
}

/**
 * Simple typed event emitter for context events.
 * Usage: contextEvents.on("context_stats", (s) => renderBar(s))
 */
class ContextEventEmitter {
  private readonly _listeners = new Map<string, Array<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): () => void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(handler);
    // return unsubscribe
    return () => {
      const arr = this._listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  emit(event: string, payload: unknown): void {
    for (const h of this._listeners.get(event) ?? []) {
      try { h(payload); } catch { /* ignore handler errors */ }
    }
  }
}

export const contextEvents = new ContextEventEmitter();

// ---------------------------------------------------------------------------
// Context Compression — summarize middle messages when context > 80% full
// ---------------------------------------------------------------------------

const COMPRESSION_THRESHOLD = 0.80; // trigger at 80% full

export interface CompressionResult {
  messages: CoreMessage[];
  compressed: boolean;
  savedTokens: number;
  summaryMessageIndex?: number;
}

/**
 * Compress the context window by summarising the middle messages via an LLM call.
 * This keeps the system message and the latest `keepTail` messages intact.
 *
 * @param messages  Current message history
 * @param maxTokens Model context window size
 * @param summarizerFn Callback that receives a block of text and returns a summary.
 *                  Pass your AI stream/generate function here.
 * @param keepTail  Number of recent messages to always preserve (default 6)
 */
export async function compressContext(
  messages: CoreMessage[],
  maxTokens: number,
  summarizerFn: (text: string) => Promise<string>,
  keepTail = 6
): Promise<CompressionResult> {
  const stats = getContextStats(messages, maxTokens);
  if (stats.percent < COMPRESSION_THRESHOLD * 100) {
    return { messages, compressed: false, savedTokens: 0 };
  }

  const system = messages[0];
  if (!system || messages.length < keepTail + 2) {
    // Not enough messages to compress
    return { messages, compressed: false, savedTokens: 0 };
  }

  const tail = messages.slice(-keepTail);
  const middle = messages.slice(1, -keepTail);

  if (middle.length === 0) {
    return { messages, compressed: false, savedTokens: 0 };
  }

  // Build a text representation of the middle block for the summarizer
  const middleText = middle
    .map((m) => {
      const role = (m as { role?: string }).role ?? "unknown";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content}`;
    })
    .join("\n\n");

  let summary: string;
  try {
    summary = await summarizerFn(
      `Summarise this conversation history concisely, preserving decisions, code changes, and key facts:\n\n${middleText}`
    );
  } catch (err) {
    logger.warn("Context compression summarizer failed", { err: String(err) });
    // Fall back to simple trimming
    const trimmed = trimToContextWindow(messages, maxTokens, keepTail);
    return {
      messages: trimmed,
      compressed: true,
      savedTokens: stats.used - estimateMessagesTokens(trimmed),
    };
  }

  const summaryMessage: CoreMessage = {
    role: "assistant",
    content: `[Context Summary — ${middle.length} messages compressed]\n\n${summary}`,
  } as CoreMessage;

  const compressed = [system, summaryMessage, ...tail];
  const newTokens = estimateMessagesTokens(compressed);
  const savedTokens = stats.used - newTokens;

  logger.info("Context compressed", {
    before: stats.used,
    after: newTokens,
    savedTokens,
    messagesRemoved: middle.length,
  });

  contextEvents.emit("context_stats", getContextStats(compressed, maxTokens));

  return {
    messages: compressed,
    compressed: true,
    savedTokens,
    summaryMessageIndex: 1,
  };
}

// ---------------------------------------------------------------------------
// PAKALON.md Memory File Loading (T-A35)
// ---------------------------------------------------------------------------

/**
 * Load PAKALON.md memory files at session start.
 * Looks for:
 * - .pakalon/PAKALON.md (project scope)
 * - ~/.config/pakalon/PAKALON.md (personal scope)
 */
export function loadMemoryFiles(projectDir?: string): string[] {
  const memories: string[] = [];
  
  // Project-scoped memory
  const projectMemory = projectDir
    ? path.join(projectDir, ".pakalon", "PAKALON.md")
    : path.join(process.cwd(), ".pakalon", "PAKALON.md");
  
  if (fs.existsSync(projectMemory)) {
    try {
      const content = fs.readFileSync(projectMemory, "utf-8");
      memories.push(`[Project Memory]\n\n${content}`);
      logger.debug("[Context] Loaded project memory", { path: projectMemory });
    } catch (err) {
      logger.warn("[Context] Failed to load project memory", { path: projectMemory, error: String(err) });
    }
  }
  
  // Personal-scoped memory
  const personalMemory = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".config",
    "pakalon",
    "PAKALON.md"
  );
  
  if (fs.existsSync(personalMemory)) {
    try {
      const content = fs.readFileSync(personalMemory, "utf-8");
      memories.push(`[Personal Memory]\n\n${content}`);
      logger.debug("[Context] Loaded personal memory", { path: personalMemory });
    } catch (err) {
      logger.warn("[Context] Failed to load personal memory", { path: personalMemory, error: String(err) });
    }
  }
  
  return memories;
}

/**
 * Inject memory files into system prompt
 */
export function injectMemoryIntoSystem(baseSystem: string, projectDir?: string): string {
  const memories = loadMemoryFiles(projectDir);
  
  if (memories.length === 0) return baseSystem;
  
  return `${baseSystem}\n\n## Memory Files\n\n${memories.join("\n\n---\n\n")}`;
}

// ---------------------------------------------------------------------------
// PAKALON.md Auto-Write-Back — T-A35b
// ---------------------------------------------------------------------------

export interface MemoryWriteOptions {
  /** "project" saves to <projectDir>/.pakalon/PAKALON.md (default) */
  scope?: "project" | "personal";
  /** Append to existing file instead of replacing it */
  append?: boolean;
}

/**
 * Save a session summary back to PAKALON.md (auto-memory write-back).
 *
 * Called at session end with AI-generated summary so the memory persists
 * across sessions (T-A35b). Creates the directory if missing.
 *
 * @param summary   Markdown summary text to write
 * @param projectDir Project root directory
 * @param options   Scope and write mode
 */
export function saveMemoryFile(
  summary: string,
  projectDir?: string,
  options: MemoryWriteOptions = {}
): void {
  const { scope = "project", append = false } = options;

  let memoryPath: string;
  if (scope === "personal") {
    const configDir = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? "",
      ".config",
      "pakalon"
    );
    memoryPath = path.join(configDir, "PAKALON.md");
  } else {
    const dot = projectDir
      ? path.join(projectDir, ".pakalon")
      : path.join(process.cwd(), ".pakalon");
    memoryPath = path.join(dot, "PAKALON.md");
  }

  try {
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });

    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const header = `\n\n---\n<!-- Updated: ${timestamp} -->\n`;

    if (append && fs.existsSync(memoryPath)) {
      fs.appendFileSync(memoryPath, `${header}\n${summary}\n`, "utf-8");
    } else {
      const content = `# Pakalon Memory\n${header}\n${summary}\n`;
      fs.writeFileSync(memoryPath, content, "utf-8");
    }
    logger.debug("[Context] Saved memory file", { path: memoryPath, scope, append });
  } catch (err) {
    logger.warn("[Context] Failed to save memory file", { path: memoryPath, error: String(err) });
  }
}

/**
 * Generate a session summary string from the conversation messages.
 * Uses the last assistant message as the primary summary source, augmented
 * with key decisions extracted from the conversation.
 *
 * @param messages   Full conversation message array
 * @param maxLength  Maximum length of the summary (default: 2000 chars)
 */
export function buildSessionMemorySummary(
  messages: CoreMessage[],
  maxLength = 2000
): string {
  if (messages.length === 0) return "";

  // Extract all assistant messages for key info
  const assistantMsgs = messages.filter(
    (m) => (m as { role?: string }).role === "assistant"
  );
  const userMsgs = messages.filter(
    (m) => (m as { role?: string }).role === "user"
  );

  const lines: string[] = [
    `## Session Summary (${new Date().toISOString().slice(0, 10)})`,
    "",
    `**Messages:** ${messages.length} (${userMsgs.length} user, ${assistantMsgs.length} assistant)`,
    "",
    "### Key Decisions & Changes",
  ];

  // Extract decisions from assistant messages (look for bullet points and headings)
  const decisionPats = [
    /^\s*[-*•]\s+.{10,}/gm,      // bullet points
    /^#{1,3}\s+.+/gm,             // headings
    /\b(created|wrote|updated|fixed|installed|configured|added|removed)\b.{5,60}/gi, // action verbs
  ];

  const decisions = new Set<string>();
  for (const m of assistantMsgs.slice(-10)) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    for (const pat of decisionPats) {
      const matches = text.match(pat) ?? [];
      for (const match of matches.slice(0, 3)) {
        decisions.add(match.trim().slice(0, 100));
      }
    }
  }

  if (decisions.size > 0) {
    for (const d of Array.from(decisions).slice(0, 15)) {
      lines.push(`- ${d}`);
    }
  } else {
    lines.push("- Session completed (no explicit decisions recorded)");
  }

  // Add last user message as context for next session
  const lastUser = userMsgs[userMsgs.length - 1];
  if (lastUser) {
    const text = typeof lastUser.content === "string"
      ? lastUser.content.slice(0, 200)
      : JSON.stringify(lastUser.content).slice(0, 200);
    lines.push("", "### Last User Request", text);
  }

  return lines.join("\n").slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Auto-Compact on Context Window Fill (T-A34)
// ---------------------------------------------------------------------------

const AUTO_COMPACT_THRESHOLD = 0.85; // trigger at 85% full
let _autoCompactEnabled = true;
let _lastAutoCompactTime = 0;
const AUTO_COMPACT_COOLDOWN_MS = 60000; // minimum 1 minute between auto-compactions

/**
 * Enable or disable auto-compact
 */
export function setAutoCompactEnabled(enabled: boolean): void {
  _autoCompactEnabled = enabled;
}

/**
 * Check if auto-compact should run and execute if needed.
 * Returns true if compaction was performed.
 */
export async function checkAndAutoCompact(
  messages: CoreMessage[],
  maxTokens: number,
  summarizerFn: (text: string) => Promise<string>
): Promise<CompressionResult> {
  if (!_autoCompactEnabled) {
    return { messages, compressed: false, savedTokens: 0 };
  }
  
  const now = Date.now();
  if (now - _lastAutoCompactTime < AUTO_COMPACT_COOLDOWN_MS) {
    return { messages, compressed: false, savedTokens: 0 };
  }
  
  const stats = getContextStats(messages, maxTokens);
  
  if (stats.percent < AUTO_COMPACT_THRESHOLD * 100) {
    return { messages, compressed: false, savedTokens: 0 };
  }
  
  logger.info("[Context] Auto-compacting context", { percent: stats.percent });
  
  const result = await compressContext(messages, maxTokens, summarizerFn);
  
  if (result.compressed) {
    _lastAutoCompactTime = Date.now();
  }
  
  return result;
}

// ---------------------------------------------------------------------------
// /compact Command (T-A33)
// ---------------------------------------------------------------------------

export interface CompactOptions {
  /** Focus hints for summarization (e.g., "focus on database schema changes") */
  focus?: string;
  /** Force compact even if below threshold */
  force?: boolean;
}

/**
 * Manual context compaction via /compact command
 */
export async function compactContext(
  messages: CoreMessage[],
  maxTokens: number,
  summarizerFn: (text: string) => Promise<string>,
  options: CompactOptions = {}
): Promise<CompressionResult> {
  const stats = getContextStats(messages, maxTokens);
  
  // If not forced and below threshold, just return
  if (!options.force && stats.percent < COMPRESSION_THRESHOLD * 100) {
    return { 
      messages, 
      compressed: false, 
      savedTokens: 0,
      summaryMessageIndex: undefined 
    };
  }
  
  const tail = 6; // preserve last 6 messages
  
  // Build custom summarization prompt with focus hints
  const focusHint = options.focus 
    ? `User requested focus: ${options.focus}\n\n`
    : "";
  
  const system = messages[0];
  const tailMessages = messages.slice(-tail);
  const middleMessages = messages.slice(1, -tail);
  
  if (middleMessages.length === 0) {
    return { 
      messages, 
      compressed: false, 
      savedTokens: 0,
      summaryMessageIndex: undefined 
    };
  }
  
  const middleText = middleMessages
    .map((m) => {
      const role = (m as { role?: string }).role ?? "unknown";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content}`;
    })
    .join("\n\n");
  
  let summary: string;
  try {
    summary = await summarizerFn(
      `${focusHint}Summarise this conversation history concisely, preserving decisions, code changes, and key facts. Focus on maintaining useful context for future messages:\n\n${middleText}`
    );
  } catch (err) {
    logger.warn("[Context] /compact summarization failed", { error: String(err) });
    return { 
      messages: trimToContextWindow(messages, maxTokens, tail),
      compressed: true,
      savedTokens: 0,
      summaryMessageIndex: undefined
    };
  }
  
  const summaryMessage: CoreMessage = {
    role: "assistant",
    content: `[Context Summary — ${middleMessages.length} messages compressed]\n\n${summary}`,
  } as CoreMessage;
  
  const compressed = system 
    ? [system, summaryMessage, ...tailMessages]
    : [summaryMessage, ...tailMessages];
  
  const newStats = getContextStats(compressed, maxTokens);
  const savedTokens = stats.used - newStats.used;
  
  logger.info("[Context] Manual compact completed", {
    before: stats.used,
    after: newStats.used,
    saved: savedTokens,
  });
  
  contextEvents.emit("context_stats", newStats);
  
  return {
    messages: compressed,
    compressed: true,
    savedTokens,
    summaryMessageIndex: 1,
  };
}

// ---------------------------------------------------------------------------
// /context Command (T-A36)
// ---------------------------------------------------------------------------

/**
 * Get detailed context window information for /context command
 */
export interface ContextInfo {
  stats: ContextStats;
  messageCount: number;
  systemPromptTokens: number;
  memoryTokens: number;
  loadedSkills: string[];
  skillsExcluded: boolean;
  truncationWarnings: string[];
}

/**
 * Get current context information
 */
export function getContextInfo(
  messages: CoreMessage[],
  maxTokens: number,
  loadedSkills: string[] = [],
  totalSkillTokens = 0
): ContextInfo {
  const stats = getContextStats(messages, maxTokens);
  
  // Calculate system prompt tokens
  const systemPromptTokens = messages[0]
    ? estimateTokens(typeof messages[0].content === "string" ? messages[0].content : JSON.stringify(messages[0].content))
    : 0;
  
  // Calculate memory tokens
  const memories = loadMemoryFiles();
  const memoryTokens = memories.reduce((sum, m) => sum + estimateTokens(m), 0);
  
  // Check if skills were excluded due to budget
  const skillsExcluded = totalSkillTokens > 0 && (systemPromptTokens + memoryTokens + totalSkillTokens) > maxTokens * 0.3;
  
  // Generate warnings
  const warnings: string[] = [];
  if (stats.percent > 80) {
    warnings.push("Context window > 80% full. Consider using /compact");
  }
  if (stats.percent > 95) {
    warnings.push("CRITICAL: Context window nearly full. /compact recommended.");
  }
  if (skillsExcluded) {
    warnings.push("Some skills were excluded due to token budget limits.");
  }
  
  return {
    stats,
    messageCount: messages.length,
    systemPromptTokens,
    memoryTokens,
    loadedSkills,
    skillsExcluded,
    truncationWarnings: warnings,
  };
}
