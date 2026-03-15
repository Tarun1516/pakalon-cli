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

vi.mock("@/bridge/manager.js", () => ({
  startBridge: mockStartBridge,
  stopBridge: mockStopBridge,
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
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
  });

  it("starts bridge and returns bridge configuration", async () => {
    const { cmdPakalon } = await import("../../commands/pakalon.js");
    const result = await cmdPakalon({ prompt: "Build a todo app", mode: "yolo", dir: "/tmp" });
    expect(mockStartBridge).toHaveBeenCalledTimes(1);
    expect(result.bridgePort).toBe(7432);
    expect(result.projectDir).toBe("/tmp");
    expect(result.bridgeMode.userPrompt).toBe("Build a todo app");
  });

  it("uses yolo mode when specified", async () => {
    const { cmdPakalon } = await import("../../commands/pakalon.js");
    const result = await cmdPakalon({ prompt: "test", mode: "yolo" });
    expect(result.bridgeMode.isYolo).toBe(true);
  });

  it("exits with code 1 when bridge fails to start", async () => {
    mockStartBridge.mockRejectedValueOnce(new Error("Python not found"));
    const { cmdPakalon } = await import("../../commands/pakalon.js");
    await cmdPakalon({ prompt: "test" });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("uses process.cwd() as default dir", async () => {
    const { cmdPakalon } = await import("../../commands/pakalon.js");
    const result = await cmdPakalon({ prompt: "test" });
    expect(result.projectDir).toBe(process.cwd());
  });
});
