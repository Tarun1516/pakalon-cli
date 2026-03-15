import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { orchestrateTool } from "../tools.js";
import { useStore } from "../../store/index.js";

function toolExecute<TInput extends Record<string, unknown>>(toolDef: unknown, input: TInput): Promise<any> {
  const execute = (toolDef as { execute?: (args: TInput) => Promise<unknown> }).execute;
  if (!execute) {
    throw new Error("Tool definition is missing execute()");
  }
  return execute(input);
}

describe("orchestrate tool", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useStore.getState().setPermissionMode("auto-accept");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    useStore.getState().setPermissionMode("normal");
  });

  it("blocks orchestration mode (Q&A only)", async () => {
    useStore.getState().setPermissionMode("orchestration");

    const result = await toolExecute(orchestrateTool, {
      tools: [{ tool_name: "list_dir", params: { path: "." } }],
    });

    expect(result.blocked).toBe(true);
    expect(String(result.error)).toContain("Q&A only");
  });

  it("blocks allowMutation in plan mode", async () => {
    useStore.getState().setPermissionMode("plan");

    const result = await toolExecute(orchestrateTool, {
      tools: [{ tool_name: "run_command", params: { command: "echo hi" } }],
      allowMutation: true,
    });

    expect(result.blocked).toBe(true);
    expect(String(result.error)).toContain("allowMutation=true");
  });

  it("posts to bridge and returns orchestrator response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        results: [{ index: 0, tool_name: "list_dir", success: true, data: { entries: ["src/"] } }],
      }),
    });
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await toolExecute(orchestrateTool, {
      tools: [{ tool_name: "list_dir", params: { path: "." } }],
      parallel: false,
      allowMutation: false,
      projectDir: "d:/pakalon/pakalon-cli",
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/agent/orchestrate");
    const body = JSON.parse(String(req.body));
    expect(body).toMatchObject({
      parallel: false,
      allow_mutation: false,
      project_dir: "d:/pakalon/pakalon-cli",
    });
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it("returns an HTTP status error when bridge fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await toolExecute(orchestrateTool, {
      tools: [{ tool_name: "list_dir", params: { path: "." } }],
    });

    expect(result.status).toBe(500);
    expect(String(result.error)).toContain("HTTP 500");
  });
});
