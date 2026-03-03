/**
 * Stream handler — wraps streamCompletion and updates the Zustand store in real-time.
 * Parses <think>...</think> tags to separate reasoning from response.
 */
import { streamCompletion } from "./openrouter.js";
import type { ModelMessage as CoreMessage, tool, ToolSet } from "ai";
import logger from "@/utils/logger.js";

interface StreamHandlerOptions {
  model: string;
  messages: CoreMessage[];
  apiKey?: string;
  system?: string;
  /** When true, adds X-Privacy-Mode: 1 / X-OpenRouter-No-Prompt-Training: true headers (T163) */
  privacyMode?: boolean;
  /** When true, enables extended reasoning mode via OpenRouter (T-CLI-19) */
  thinkingEnabled?: boolean;
  /** When true, enables Anthropic prompt caching (cache_control breakpoints on first two tokens) */
  promptCaching?: boolean;
  /** When true (or when PAKALON_USE_PROXY=1 / no apiKey), route via backend proxy */
  useProxy?: boolean;
  /** JWT token for backend proxy authentication */
  authToken?: string;
  /** Pakalon backend base URL for proxy mode */
  proxyBaseUrl?: string;
  /**
   * MCP / agent tools to inject into the AI inference (direct mode only).
   * Loaded via `loadMcpTools()` from `@/mcp/tools.js`.
   */
  tools?: ToolSet;
  onThinkChunk?: (chunk: string) => void;
  onTextChunk?: (chunk: string) => void;
  onFinish?: (fullText: string, usage: { promptTokens: number; completionTokens: number }) => void;
  onError?: (err: Error) => void;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

export async function handleStream(opts: StreamHandlerOptions): Promise<void> {
  let buffer = "";
  let inThink = false;
  let thinkBuffer = "";
  let responseBuffer = "";

  const flush = (text: string, force = false) => {
    if (!text && !force) return;
    if (inThink) {
      opts.onThinkChunk?.(text);
      thinkBuffer += text;
    } else {
      opts.onTextChunk?.(text);
      responseBuffer += text;
    }
  };

  const processBuffer = () => {
    while (buffer.length > 0) {
      if (!inThink) {
        const openIdx = buffer.indexOf(THINK_OPEN);
        if (openIdx === -1) {
          // No think tag in buffer — flush all except potential partial tag
          const safe = buffer.length > THINK_OPEN.length
            ? buffer.slice(0, buffer.length - THINK_OPEN.length)
            : "";
          if (safe) {
            flush(safe);
            buffer = buffer.slice(safe.length);
          } else {
            break;
          }
        } else {
          // Flush up to the open tag
          if (openIdx > 0) {
            flush(buffer.slice(0, openIdx));
          }
          buffer = buffer.slice(openIdx + THINK_OPEN.length);
          inThink = true;
        }
      } else {
        const closeIdx = buffer.indexOf(THINK_CLOSE);
        if (closeIdx === -1) {
          // Still in think — flush safe portion
          const safe = buffer.length > THINK_CLOSE.length
            ? buffer.slice(0, buffer.length - THINK_CLOSE.length)
            : "";
          if (safe) {
            flush(safe);
            buffer = buffer.slice(safe.length);
          } else {
            break;
          }
        } else {
          flush(buffer.slice(0, closeIdx));
          buffer = buffer.slice(closeIdx + THINK_CLOSE.length);
          inThink = false;
        }
      }
    }
  };

  await streamCompletion({
    model: opts.model,
    messages: opts.messages,
    apiKey: opts.apiKey,
    system: opts.system,
    thinkingEnabled: opts.thinkingEnabled,
    privacyMode: opts.privacyMode,
    promptCaching: opts.promptCaching,
    useProxy: opts.useProxy,
    authToken: opts.authToken,
    proxyBaseUrl: opts.proxyBaseUrl,
    tools: opts.tools,
    onChunk: (chunk) => {
      buffer += chunk;
      processBuffer();
    },
    onFinish: (full, usage) => {
      // Flush any remaining buffer
      if (buffer) {
        flush(buffer, true);
        buffer = "";
      }
      logger.debug("Stream finished", { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens });
      opts.onFinish?.(responseBuffer, usage);
    },
    onError: (err) => {
      logger.error("Stream error", { message: err.message });
      opts.onError?.(err);
    },
  });
}
