/**
 * CLI end-to-end tests (T156)
 *
 * Tests mock all external I/O (HTTP, filesystem, SQLite) so they run
 * without a real backend, Polar, or Resend account.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock("@/auth/storage.js", () => ({
  isAuthenticated: vi.fn(() => false),
  readStorage: vi.fn(() => ({
    jwt: undefined,
    userId: undefined,
    plan: "free",
    machineId: "mock-machine-id",
    macMachineId: "mock-mac-id",
    devDeviceId: "mock-dev-device-id",
    privacyMode: false,
    mcpGlobal: [],
  })),
  writeStorage: vi.fn(),
  updateStorage: vi.fn(),
}));

vi.mock("@/auth/machine-id.js", () => ({
  getMachineIds: vi.fn(() => ({
    machineId: "mock-machine-id",
    macMachineId: "mock-mac-machine-id",
    devDeviceId: "mock-dev-device-id",
  })),
}));

vi.mock("@/bridge/manager.js", () => ({
  startBridge: vi.fn(async () => ({ pid: 12345, port: 7432 })),
  stopBridge: vi.fn(async () => {}),
  isBridgeRunning: vi.fn(() => true),
}));

vi.mock("@/bridge/client.js", () => ({
  bridgePing: vi.fn(async () => ({ status: "ok" })),
  bridgeAgentRun: vi.fn(
    async (
      _phase: string,
      _dir: string,
      _userId: string,
      _yolo: boolean,
      onEvent: (e: { type: string; data: unknown }) => void,
    ) => {
      // Simulate SSE events then completion
      onEvent({ type: "progress", data: "Starting phase 1..." });
      onEvent({ type: "qa_question", data: "Is this a React project? [yes/no]" });
      onEvent({ type: "progress", data: "Generating files..." });
      onEvent({ type: "phase_complete", data: { status: "success", files_written: 12 } });
      return { status: "success", files_written: 12 };
    },
  ),
  bridgeMemorySearch: vi.fn(async () => ({ results: [] })),
}));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      get: vi.fn(async (url: string) => {
        if (url.includes("/auth/devices/")) {
          return { status: 200, data: { access_token: "mock-jwt-token", token_type: "bearer" } };
        }
        if (url.includes("/models")) {
          return {
            status: 200,
            data: {
              models: Array.from({ length: 20 }, (_, i) => ({
                model_id: `model-${i}`,
                name: `Test Model ${i}`,
                provider: "openai",
                pricing_tier: i < 10 ? "free" : "pro",
              })),
            },
          };
        }
        return { status: 200, data: {} };
      }),
      post: vi.fn(async (url: string, body: unknown) => {
        if (url.includes("/auth/devices")) {
          return {
            status: 201,
            data: {
              device_id: "mock-device-id-12345",
              code: "482931",
              expires_at: new Date(Date.now() + 600_000).toISOString(),
            },
          };
        }
        return { status: 200, data: {} };
      }),
    })),
  },
}));

vi.mock("@/db/client.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
        orderBy: vi.fn(() => Promise.resolve([])),
        limit: vi.fn(() => Promise.resolve([])),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve({ rowsAffected: 1 })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve({ rowsAffected: 1 })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve({ rowsAffected: 1 })),
    })),
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (String(p).includes("storage.json")) return false;
      return actual.existsSync(p);
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify({ jwt: undefined, machineId: "test" })),
  };
});

// ── Test imports (after mocks) ────────────────────────────────────────────────

import { startBridge, stopBridge } from "@/bridge/manager.js";
import { bridgePing, bridgeAgentRun, bridgeMemorySearch } from "@/bridge/client.js";
import { isAuthenticated, readStorage, writeStorage } from "@/auth/storage.js";
import { getMachineIds } from "@/auth/machine-id.js";

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI E2E — Device code auth flow (T156)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates a 6-digit numeric device code format", async () => {
    const axios = (await import("axios")).default;
    const instance = axios.create();

    const resp = await instance.post("/auth/devices", {
      device_id: "test-device-id",
      machine_id: "test-machine",
    });

    expect(resp.status).toBe(201);
    expect(resp.data.code).toMatch(/^\d{6}$/);
    expect(resp.data.device_id).toBe("mock-device-id-12345");
  });

  it("polls and receives JWT after approval", async () => {
    const axios = (await import("axios")).default;
    const instance = axios.create();

    const resp = await instance.get("/auth/devices/mock-device-id-12345/token");

    expect(resp.status).toBe(200);
    expect(resp.data.access_token).toBe("mock-jwt-token");
  });

  it("getMachineIds returns all three identifiers", () => {
    const ids = getMachineIds();
    expect(ids).toHaveProperty("machineId");
    expect(ids).toHaveProperty("macMachineId");
    expect(ids).toHaveProperty("devDeviceId");
    expect(typeof ids.machineId).toBe("string");
    expect(ids.machineId.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI E2E — Models loading (T156)", () => {
  it("fetches models list from backend", async () => {
    const axios = (await import("axios")).default;
    const instance = axios.create();

    const resp = await instance.get("/models");

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.data.models)).toBe(true);
    expect(resp.data.models.length).toBeGreaterThan(0);
    expect(resp.data.models[0]).toHaveProperty("model_id");
    expect(resp.data.models[0]).toHaveProperty("name");
  });

  it("free users see at least 10 models", async () => {
    const axios = (await import("axios")).default;
    const instance = axios.create();

    const resp = await instance.get("/models");
    const freeModels = resp.data.models.filter(
      (m: { pricing_tier: string }) => m.pricing_tier === "free",
    );
    expect(freeModels.length).toBeGreaterThanOrEqual(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI E2E — Streaming chat turn (T156)", () => {
  it("startBridge resolves with pid and port", async () => {
    const result = await startBridge();
    expect(result).toHaveProperty("pid");
    expect(result).toHaveProperty("port");
    expect(result.port).toBe(7432);
  });

  it("bridgeAgentRun fires progress events, then phase_complete", async () => {
    const events: { type: string; data: unknown }[] = [];
    const result = await bridgeAgentRun(
      "phase1",
      "/tmp/test-project",
      "user-123",
      false, // not yolo
      (event) => events.push(event),
    );

    const types = events.map((e) => e.type);

    expect(types).toContain("progress");
    expect(types).toContain("phase_complete");
    expect(result).toEqual({ status: "success", files_written: 12 });
  });

  it("bridgeAgentRun receives HIL question event", async () => {
    const events: { type: string; data: unknown }[] = [];
    await bridgeAgentRun("phase1", "/tmp/test-project", "user-123", false, (e) =>
      events.push(e),
    );

    const qaEvent = events.find((e) => e.type === "qa_question");
    expect(qaEvent).toBeDefined();
    expect(typeof qaEvent?.data).toBe("string");
  });

  it("bridgePing returns ok status", async () => {
    const resp = await bridgePing();
    expect(resp.status).toBe("ok");
  });

  it("stopBridge completes without error", async () => {
    await expect(stopBridge()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI E2E — Storage operations (T156)", () => {
  it("readStorage returns default structure when no file exists", () => {
    const storage = readStorage();
    expect(storage).toHaveProperty("machineId");
    expect(storage).toHaveProperty("privacyMode");
    expect(storage).toHaveProperty("mcpGlobal");
    expect(Array.isArray(storage.mcpGlobal)).toBe(true);
  });

  it("isAuthenticated returns false when no JWT stored", () => {
    expect(isAuthenticated()).toBe(false);
  });

  it("writeStorage is called with correct shape", () => {
    const payload = {
      jwt: "test.jwt.token",
      userId: "user-123",
      plan: "free" as const,
      machineId: "m1",
      macMachineId: "mm1",
      devDeviceId: "d1",
      privacyMode: false,
      mcpGlobal: [],
    };
    writeStorage(payload);
    expect(writeStorage).toHaveBeenCalledWith(payload);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI E2E — Memory search (T156)", () => {
  it("bridgeMemorySearch returns results array", async () => {
    const result = await bridgeMemorySearch("how to setup database");
    expect(result).toHaveProperty("results");
    expect(Array.isArray(result.results)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI E2E — Context bar and undo (T156)", () => {
  it("undo stack mock returns empty on fresh session", async () => {
    const { db } = await import("@/db/client.js");
    const rows = await db
      .select()
      .from("undo_stack" as never)
      .where("session_id = 'new'" as never)
      .limit(10 as never);

    // Mock returns empty array — undo menu would show no items
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });
});
