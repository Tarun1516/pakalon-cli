/**
 * print-mode.ts — Non-interactive one-shot mode (pakalon -p "query").
 *
 * Analogous to `claude -p`: reads input from argument or stdin, streams
 * response to stdout without mounting the Ink TUI, then exits.
 *
 * Supports:
 *   --output-format text            (default) — plain text to stdout
 *   --output-format json            — { role: 'assistant', content: '...' }
 *   --output-format stream-json     — NDJSON: one JSON object per chunk
 *
 * System prompt flags:
 *   --system-prompt <text>          replace the default system prompt
 *   --system-prompt-file <path>     read system prompt from a file
 *   --append-system-prompt <text>   append after the default system prompt
 *   --append-system-prompt-file <path>
 */

import fs from "fs";
import { loadCredentials } from "@/auth/storage.js";
import { handleStream } from "@/ai/stream.js";
import { DEFAULT_FREE_MODEL_ID } from "@/constants/models.js";
import { estimateTokens } from "@/utils/cost-estimate.js";
import logger from "@/utils/logger.js";
import type { ModelMessage as CoreMessage } from "ai";

export type OutputFormat = "text" | "json" | "stream-json";

export interface PrintModeOptions {
  message: string;
  model?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  outputFormat?: OutputFormat;
  /** When true model thinking is shown in stderr (doesn't pollute stdout) */
  showThinking?: boolean;
  privacyMode?: boolean;
}

const BASE_SYSTEM = "You are Pakalon, an expert AI coding assistant running in a terminal. Be concise and precise.";

/** Read stdin to EOF. Returns empty string if stdin is a TTY. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trimEnd()));
    process.stdin.on("error", () => resolve(""));
  });
}

/**
 * Build the effective system prompt from flag combinations.
 * Priority: --system-prompt / --system-prompt-file replaces default.
 *           --append-system-prompt / --append-system-prompt-file appends.
 */
export function buildSystemPrompt(opts: Pick<PrintModeOptions, "systemPrompt" | "systemPromptFile" | "appendSystemPrompt" | "appendSystemPromptFile">): string {
  let base = BASE_SYSTEM;

  if (opts.systemPromptFile) {
    try {
      base = fs.readFileSync(opts.systemPromptFile, "utf8").trim();
    } catch (e) {
      logger.warn(`Could not read --system-prompt-file: ${opts.systemPromptFile}`);
    }
  } else if (opts.systemPrompt) {
    base = opts.systemPrompt.trim();
  }

  if (opts.appendSystemPromptFile) {
    try {
      const appendText = fs.readFileSync(opts.appendSystemPromptFile, "utf8").trim();
      base = `${base}\n\n${appendText}`;
    } catch (e) {
      logger.warn(`Could not read --append-system-prompt-file: ${opts.appendSystemPromptFile}`);
    }
  } else if (opts.appendSystemPrompt) {
    base = `${base}\n\n${opts.appendSystemPrompt.trim()}`;
  }

  return base;
}

/**
 * Run print mode — streams a single AI response to stdout and exits.
 */
export async function runPrintMode(opts: PrintModeOptions): Promise<void> {
  const fmt: OutputFormat = opts.outputFormat ?? "text";
  const creds = loadCredentials();

  if (!creds?.token) {
    process.stderr.write("Error: not authenticated. Run `pakalon login` first.\n");
    process.exit(1);
  }

  // Build message list
  const systemPrompt = buildSystemPrompt(opts);
  const messages: CoreMessage[] = [{ role: "user", content: opts.message }];

  let fullResponse = "";
  let chunkIndex = 0;

  await handleStream({
    model: opts.model ?? DEFAULT_FREE_MODEL_ID,
    messages,
    system: systemPrompt,
    privacyMode: opts.privacyMode ?? false,
    authToken: creds.token,
    useProxy: true,
    proxyBaseUrl: process.env.PAKALON_API_URL ?? "http://127.0.0.1:8000",
    onThinkChunk: (chunk) => {
      if (opts.showThinking) process.stderr.write(chunk);
    },
    onTextChunk: (chunk) => {
      fullResponse += chunk;
      if (fmt === "stream-json") {
        process.stdout.write(
          JSON.stringify({ type: "text_delta", index: chunkIndex++, content: chunk }) + "\n"
        );
      } else if (fmt === "text") {
        process.stdout.write(chunk);
      }
      // For "json" format we buffer and write once at the end
    },
    onFinish: (full, usage) => {
      if (fmt === "json") {
        process.stdout.write(
          JSON.stringify({
            role: "assistant",
            content: full,
            usage: {
              input_tokens: usage.promptTokens,
              output_tokens: usage.completionTokens,
            },
          }) + "\n"
        );
      } else if (fmt === "stream-json") {
        process.stdout.write(
          JSON.stringify({
            type: "message_stop",
            usage: {
              input_tokens: usage.promptTokens,
              output_tokens: usage.completionTokens,
            },
          }) + "\n"
        );
      } else {
        // text — ensure trailing newline
        if (!full.endsWith("\n")) process.stdout.write("\n");
      }
    },
    onError: (err) => {
      process.stderr.write(`\nError: ${err.message}\n`);
      process.exit(1);
    },
  });
}
