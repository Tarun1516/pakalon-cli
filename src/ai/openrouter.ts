/**
 * OpenRouter integration using Vercel AI SDK + @openrouter/ai-sdk-provider.
 *
 * Supports two routing modes:
 *   1. Direct — calls OpenRouter using a local apiKey (OPENROUTER_API_KEY)
 *   2. Proxy  — routes requests through the Pakalon backend (/ai/chat/stream)
 *              using the backend's OPENROUTER_MASTER_KEY. No per-user key needed.
 *
 * Proxy mode is activated when:
 *   - `useProxy: true` is passed explicitly, OR
 *   - PAKALON_USE_PROXY=1 env var is set, OR
 *   - apiKey is empty/undefined
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText, generateText, tool } from "ai";
import type { ModelMessage as CoreMessage, ToolSet } from "ai";

let _provider: ReturnType<typeof createOpenRouter> | null = null;

export function getOpenRouterProvider(apiKey: string) {
  if (!_provider) {
    _provider = createOpenRouter({ apiKey });
  }
  return _provider;
}

export function resetProvider() {
  _provider = null;
}

export interface StreamOptions {
  model: string;
  messages: CoreMessage[];
  apiKey?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** When true, enables extended reasoning via OpenRouter provider options (T-CLI-19) */
  thinkingEnabled?: boolean;
  /** When true, adds privacy headers (no prompt training / T163) */
  privacyMode?: boolean;
  /**
   * When true (or when PAKALON_USE_PROXY=1 / no apiKey), routes inference
   * through the Pakalon backend proxy instead of calling OpenRouter directly.
   */
  useProxy?: boolean;
  /** Backend JWT token — required for proxy mode */
  authToken?: string;
  /** Pakalon backend base URL (default: PAKALON_API_URL env) */
  proxyBaseUrl?: string;
  /**
   * Additional tools to inject into the AI inference (e.g. from MCP servers).
   * Only used in direct OpenRouter mode (ignored in proxy mode).
   */
  tools?: ToolSet;
  /**
   * Max agentic steps for tool calling. Default: 5 (direct mode only).
   */
  maxSteps?: number;
  /**
   * When true, inject Anthropic prompt-caching cache_control breakpoints.
   * Reduces inference cost by up to 90% on repeated long contexts (T-CLI-CACHE).
   * Only effective with anthropic/* models via OpenRouter.
   */
  promptCaching?: boolean;
  onChunk?: (chunk: string) => void;
  onFinish?: (fullText: string, usage: { promptTokens: number; completionTokens: number }) => void;
  onError?: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// T-CLI-CACHE: Prompt caching helpers — inject cache_control breakpoints
// for Anthropic models. Reduces inference cost by caching the system prompt
// and large stable context blocks.
// ---------------------------------------------------------------------------

/**
 * Inject Anthropic cache_control: { type: "ephemeral" } breakpoints into the
 * message array so OpenRouter (Anthropic backend) reuses the KV-cache.
 *
 * Strategy:
 * 1. Always mark the system prompt as cached (largest stable block).
 * 2. Mark the first user message (often has PAKALON.md + file context) as cached.
 * 3. Keep the last 2 turns un-cached (dynamic new content).
 *
 * This approach is invisible to non-Anthropic models — OpenRouter ignores
 * cache_control on providers that don't support it.
 */
function injectPromptCachingBreakpoints(
  messages: CoreMessage[],
  systemPrompt?: string
): { messages: CoreMessage[]; cacheSystemPrompt: object | undefined } {
  if (messages.length === 0) return { messages, cacheSystemPrompt: undefined };

  // Mark system prompt with cache_control
  const cacheSystemPrompt = systemPrompt
    ? { cache_control: { type: "ephemeral" } }
    : undefined;

  const out: CoreMessage[] = [];

  // Mark the first user message (stable context block) as cached
  let cachedFirst = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const role = (m as { role?: string }).role;
    const isLast2 = i >= messages.length - 2;

    if (role === "user" && !cachedFirst && !isLast2) {
      // Deep-clone and add cache_control to the last content part
      const content = typeof m.content === "string"
        ? [{ type: "text" as const, text: m.content, cache_control: { type: "ephemeral" } }]
        : Array.isArray(m.content)
          ? m.content.map((part, pi) =>
              pi === (m.content as unknown[]).length - 1
                ? { ...(part as object), cache_control: { type: "ephemeral" } }
                : part
            )
          : m.content;
      out.push({ ...m, content } as CoreMessage);
      cachedFirst = true;
    } else {
      out.push(m);
    }
  }

  return { messages: out, cacheSystemPrompt };
}

/** Return true if the model is an Anthropic model (caching supported). */
function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/") || model.includes("claude");
}

function isProxyMode(opts: StreamOptions): boolean {
  if (opts.useProxy) return true;
  if (process.env.PAKALON_USE_PROXY === "1") return true;
  if (!opts.apiKey) return true;
  return false;
}

/**
 * Stream via the Pakalon backend AI proxy endpoint.
 * The backend holds the master OpenRouter key — users supply only their JWT.
 */
async function streamViaProxy(opts: StreamOptions): Promise<void> {
  const baseUrl = opts.proxyBaseUrl ?? process.env.PAKALON_API_URL ?? "http://localhost:8000";
  const url = `${baseUrl}/ai/chat/stream`;
  const token = opts.authToken ?? process.env.PAKALON_TOKEN ?? "";

  const body = {
    model: opts.model,
    messages: opts.messages,
    system: opts.system,
    max_tokens: opts.thinkingEnabled ? 16000 : (opts.maxTokens ?? 4096),
    temperature: opts.thinkingEnabled ? 1.0 : (opts.temperature ?? 0.7),
    thinking_enabled: opts.thinkingEnabled ?? false,
    privacy_mode: opts.privacyMode ?? false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { detail?: string };
      if (json.detail) detail = json.detail;
    } catch { /* ignore */ }
    opts.onError?.(new Error(detail));
    return;
  }

  if (!res.body) {
    opts.onError?.(new Error("No response body from proxy"));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const raw = decoder.decode(value, { stream: true });
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        try {
          const event = JSON.parse(payload) as {
            type?: string;
            chunk?: string;
            text?: string;
            prompt_tokens?: number;
            completion_tokens?: number;
          };

          if (event.type === "text_delta" || event.chunk) {
            const chunk = event.chunk ?? event.text ?? "";
            fullText += chunk;
            opts.onChunk?.(chunk);
          } else if (event.type === "usage") {
            promptTokens = event.prompt_tokens ?? 0;
            completionTokens = event.completion_tokens ?? 0;
          }
        } catch { /* ignore malformed SSE lines */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  opts.onFinish?.(fullText, { promptTokens, completionTokens });
}

export async function streamCompletion(opts: StreamOptions): Promise<void> {
  if (isProxyMode(opts)) {
    return streamViaProxy(opts);
  }

  const provider = getOpenRouterProvider(opts.apiKey!);
  const modelInstance = provider(opts.model);

  // Privacy mode: suppress prompt training & telemetry
  const privacyHeaders = opts.privacyMode
    ? { "X-OpenRouter-No-Prompt-Training": "true", "X-Privacy-Mode": "1" }
    : {};

  // T-CLI-CACHE: Inject prompt-caching breakpoints for Anthropic models
  const enableCache = (opts.promptCaching ?? true) && isAnthropicModel(opts.model);
  let finalMessages = opts.messages;
  let cacheSystemExtra: object | undefined;
  if (enableCache) {
    const cached = injectPromptCachingBreakpoints(opts.messages, opts.system);
    finalMessages = cached.messages;
    cacheSystemExtra = cached.cacheSystemPrompt;
  }

  try {
    const result = await streamText({
      model: modelInstance,
      messages: finalMessages,
      system: opts.system,
      maxOutputTokens: opts.thinkingEnabled ? 16000 : (opts.maxTokens ?? 4096),
      temperature: opts.thinkingEnabled ? 1.0 : (opts.temperature ?? 0.7),
      ...(opts.tools ? { tools: opts.tools, maxSteps: opts.maxSteps ?? 5 } : {}),
      ...(opts.thinkingEnabled
        ? {
            providerOptions: {
              openrouter: {
                // T-CLI-9: Claude models require `thinking.budget_tokens` pattern;
                // all other models use OpenRouter's generic `reasoning.effort` param.
                ...(opts.model.includes("claude") || opts.model.includes("anthropic")
                  ? { thinking: { type: "enabled", budget_tokens: 10000 } }
                  : { reasoning: { effort: "high" } }),
                extraHeaders: privacyHeaders,
                // T-CLI-CACHE: Anthropic prompt caching via beta header
                ...(enableCache ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
                ...(cacheSystemExtra ?? {}),
              },
            },
          }
        : {
            providerOptions: {
              openrouter: {
                extraHeaders: {
                  ...privacyHeaders,
                  // T-CLI-CACHE: send Anthropic prompt-caching beta header
                  ...(enableCache ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
                },
                ...(cacheSystemExtra ?? {}),
              },
            },
          }),
    });

    let full = "";
    for await (const chunk of result.textStream) {
      full += chunk;
      opts.onChunk?.(chunk);
    }

    const usage = await result.usage;
    opts.onFinish?.(full, {
      promptTokens: usage?.inputTokens ?? 0,
      completionTokens: usage?.outputTokens ?? 0,
    });
  } catch (err) {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

export async function generateCompletion(opts: Omit<StreamOptions, "onChunk" | "onFinish" | "onError">): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  // Proxy mode: one-shot via /ai/chat (non-streaming)
  if (isProxyMode(opts)) {
    const baseUrl = opts.proxyBaseUrl ?? process.env.PAKALON_API_URL ?? "http://localhost:8000";
    const token = opts.authToken ?? process.env.PAKALON_TOKEN ?? "";
    const res = await fetch(`${baseUrl}/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        system: opts.system,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.7,
        privacy_mode: opts.privacyMode ?? false,
      }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))) as { detail?: string };
      throw new Error(json.detail ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { content: string; prompt_tokens: number; completion_tokens: number };
    return { text: data.content, promptTokens: data.prompt_tokens, completionTokens: data.completion_tokens };
  }

  const provider = getOpenRouterProvider(opts.apiKey!);
  const modelInstance = provider(opts.model);

  const result = await generateText({
    model: modelInstance,
    messages: opts.messages,
    system: opts.system,
    maxOutputTokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.7,
  });

  return {
    text: result.text,
    promptTokens: result.usage?.inputTokens ?? 0,
    completionTokens: result.usage?.outputTokens ?? 0,
  };
}
