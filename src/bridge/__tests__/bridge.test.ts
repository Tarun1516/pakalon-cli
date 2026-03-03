/**
 * bridge.test.ts — Unit tests for Python bridge client and manager.
 * T093: bridgePing, bridgeAgentRun, bridgeMemorySearch, startBridge/stopBridge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ------------------------------------------------------------------
// Mock axios before importing bridge modules
// ------------------------------------------------------------------
vi.mock("axios", () => {
  const axiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
  };
  const mockAxios = {
    default: {
      create: vi.fn(() => axiosInstance),
    },
    create: vi.fn(() => axiosInstance),
  };
  return { ...mockAxios };
});

// ------------------------------------------------------------------
// Mocks for child_process and fs
// ------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
  })),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

describe("bridge client", () => {
  let axiosMock: any;

  beforeEach(async () => {
    vi.resetModules();
    // Get the mocked axios instance
    const axios = await import("axios");
    axiosMock = (axios.default as any).create();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("bridgePing returns true when health check succeeds", async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { status: "ok" } });
    const { bridgePing } = await import("../../bridge/client.js");
    const result = await bridgePing();
    expect(result).toBe(true);
  });

  it("bridgePing returns false when health check fails", async () => {
    axiosMock.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { bridgePing } = await import("../../bridge/client.js");
    const result = await bridgePing();
    expect(result).toBe(false);
  });

  it("bridgeAgentRun sends correct payload and returns result", async () => {
    const mockResult = { phase: 1, status: "complete", output: {} };
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: mockResult },
    });
    const { bridgeAgentRun } = await import("../../bridge/client.js");
    const result = await bridgeAgentRun({ task: "test", model: "claude-3-5-haiku", messages: [], project_dir: "/tmp", token: "test-token" });
    expect(result).toEqual(mockResult);
    expect(axiosMock.post).toHaveBeenCalledWith(
      "/agent/run",
      expect.objectContaining({ type: "agent_run" }),
    );
  });

  it("bridgeAgentRun throws on bridge error response", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { success: false, error: "Phase 1 failed" },
    });
    const { bridgeAgentRun } = await import("../../bridge/client.js");
    await expect(
      bridgeAgentRun({ task: "test", model: "claude-3-5-haiku", messages: [], project_dir: "/tmp", token: "test-token" }),
    ).rejects.toThrow("Phase 1 failed");
  });

  it("bridgeMemorySearch returns search results", async () => {
    const mockResults = { results: [{ id: "1", content: "test memory", score: 0.9 }] };
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: mockResults },
    });
    const { bridgeMemorySearch } = await import("../../bridge/client.js");
    const result = await bridgeMemorySearch({ query: "test query", user_id: "user1" });
    expect(result).toEqual(mockResults);
  });

  it("bridgeMemorySearch throws on error response", async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { success: false, error: "Memory store unavailable" },
    });
    const { bridgeMemorySearch } = await import("../../bridge/client.js");
    await expect(
      bridgeMemorySearch({ query: "q", user_id: "u" }),
    ).rejects.toThrow("Memory store unavailable");
  });
});

describe("bridge manager", () => {
  it("stopBridge does not throw when bridge is not running", async () => {
    vi.resetModules();
    const { stopBridge } = await import("../../bridge/manager.js");
    await expect(stopBridge()).resolves.not.toThrow();
  });
});
