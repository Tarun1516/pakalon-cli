import { afterEach, describe, expect, it, vi } from "vitest";

import { handleStream } from "../stream.js";

const originalFetch = global.fetch;

function makeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

describe("handleStream", () => {
  it("parses backend proxy chunk and done events", async () => {
    const onTextChunk = vi.fn();
    const onFinish = vi.fn();
    const onError = vi.fn();

    global.fetch = vi.fn().mockResolvedValue(
      makeSseResponse([
        ': keepalive\n',
        'data: {"type":"chunk","content":"Hel"}\n',
        'data: {"type":"chunk","content":"lo"}\n\n',
        'data: {"type":"done","prompt_tokens":11,"completion_tokens":7}\n\n',
      ])
    ) as typeof fetch;

    await handleStream({
      model: "openrouter/auto",
      messages: [{ role: "user", content: "Hi" }],
      useProxy: true,
      authToken: "test-token",
      proxyBaseUrl: "http://localhost:8000",
      onTextChunk,
      onFinish,
      onError,
    });

    expect(onTextChunk.mock.calls.map(([chunk]) => chunk).join("")).toBe("Hello");
    expect(onFinish).toHaveBeenCalledWith("Hello", {
      promptTokens: 11,
      completionTokens: 7,
    });
    expect(onError).not.toHaveBeenCalled();
  });
});