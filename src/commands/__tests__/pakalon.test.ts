/**
 * pakalon.test.ts — Unit tests for /pakalon agentic command.
 * T124: cmdPakalon, getPakalonOpeningMessage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ------------------------------------------------------------------
// Mocks
// ------------------------------------------------------------------
vi.mock("@/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  debugLog: vi.fn(),
}));

const mockStartBridge = vi.fn().mockResolvedValue(7432);
const mockStopBridge = vi.fn().mockResolvedValue(undefined);
const mockBridgeAgentRun = vi.fn().mockResolvedValue({ phase: 1, status: "complete", output: {} });

vi.mock("@/bridge/manager.js", () => ({
  startBridge: mockStartBridge,
  stopBridge: mockStopBridge,
}));

vi.mock("@/bridge/client.js", () => ({
  bridgeAgentRun: mockBridgeAgentRun,
}));

// Prevent process.exit from killing test runner
const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------
describe("getPakalonOpeningMessage", () => {
  it("includes the user prompt in the message", async () => {
    const { getPakalonOpeningMessage } = await import("../../commands/pakalon.js");
    const msg = getPakalonOpeningMessage("Build a SaaS product", "hil");
    expect(msg).toContain("Build a SaaS product");
  });

  it("includes mode in the message", async () => {
    const { getPakalonOpeningMessage } = await import("../../commands/pakalon.js");
    const msg = getPakalonOpeningMessage("anything", "yolo");
    expect(msg).toContain("YOLO");
  });

  it("mentions Phase 1", async () => {
    const { getPakalonOpeningMessage } = await import("../../commands/pakalon.js");
    const msg = getPakalonOpeningMessage("build X", "hil");
    expect(msg).toContain("Phase 1");
  });
});

describe("cmdPakalon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartBridge.mockResolvedValue(7432);
    mockBridgeAgentRun.mockResolvedValue({ phase: 1, status: "complete" });
  });

  it("starts bridge and calls bridgeAgentRun with correct phase", async () => {
    const { cmdPakalon } = await import("../../commands/pakalon.js");
    await cmdPakalon({ prompt: "Build a todo app", mode: "yolo", dir: "/tmp" });
    expect(mockStartBridge).toHaveBeenCalledTimes(1);
    expect(mockBridgeAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 1, prompt: "Build a todo app" }),
    );
  });

  it("uses yolo mode when specified", async () => {
    const { cmdPakalon } = await import("../../commands/pakalon.js");
    await cmdPakalon({ prompt: "test", mode: "yolo" });
    expect(mockBridgeAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "yolo" }),
    );
  });

  it("exits with code 1 when bridge fails to start", async () => {
    mockStartBridge.mockRejectedValueOnce(new Error("Python not found"));
    const { cmdPakalon } = await import("../../commands/pakalon.js");
    await cmdPakalon({ prompt: "test" });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when bridgeAgentRun throws", async () => {
    mockBridgeAgentRun.mockRejectedValueOnce(new Error("Phase 1 timeout"));
    const { cmdPakalon } = await import("../../commands/pakalon.js");
    await cmdPakalon({ prompt: "test" });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("uses process.cwd() as default dir", async () => {
    const { cmdPakalon } = await import("../../commands/pakalon.js");
    await cmdPakalon({ prompt: "test" });
    expect(mockBridgeAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: process.cwd() }),
    );
  });
});
