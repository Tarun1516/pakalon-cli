/**
 * storage.ts — Persistent app storage in ~/.config/pakalon/storage.json
 *
 * Stores non-sensitive per-device settings:
 *   - Machine IDs (telemetry.machineId, macMachineId, devDeviceId)
 *   - Privacy mode
 *   - Global MCP server list
 *   - hasLaunched (for banner suppression after first run)
 *   - Default / fallback model preferences
 *   - User plan + display name cache (non-authoritative, refreshed from backend)
 *
 * Sensitive auth tokens live in credentials.json (see auth/storage.ts).
 */
import fs from "fs";
import path from "path";
import os from "os";
import type { MachineIds } from "./machine-id.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface McpServerEntry {
  name: string;
  url: string;
  enabled?: boolean;
}

export interface StorageData {
  // Machine identity (mirrors Cursor's telemetry.* naming)
  machineId: string;
  macMachineId: string;
  devDeviceId: string;

  // Privacy mode — suppresses external provider data retention header
  privacyMode: boolean;

  // Global MCP server list (project-level is in .pakalon/mcp.json)
  mcpGlobal: McpServerEntry[];

  // UI state
  hasLaunched: boolean;

  // Cached plan info (non-authoritative — always re-read from JWT)
  cachedPlan?: string;
  cachedGithubLogin?: string;

  // Model preferences
  defaultModel?: string;
  fallbackModel?: string;

  // Arbitrary extension data per plugin/feature
  [key: string]: unknown;
}

const STORAGE_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

function getConfigDir(): string {
  const base =
    process.env.PAKALON_CONFIG_DIR ??
    (process.platform === "win32"
      ? path.join(process.env.APPDATA ?? os.homedir(), "pakalon")
      : path.join(os.homedir(), ".config", "pakalon"));
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

export function getStoragePath(): string {
  return path.join(getConfigDir(), "storage.json");
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

function defaultStorage(): StorageData {
  // Lazy import to avoid circular dependency at module load time
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getMachineIds } = require("./machine-id.js") as typeof import("./machine-id.js");
  const ids: MachineIds = getMachineIds();
  return {
    machineId: ids.machineId,
    macMachineId: ids.macMachineId,
    devDeviceId: ids.devDeviceId,
    privacyMode: false,
    mcpGlobal: [],
    hasLaunched: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read storage.json from disk.
 * Always returns a fully-populated StorageData (fills defaults for missing keys).
 */
export function readStorage(): StorageData {
  const storagePath = getStoragePath();
  let raw: Partial<StorageData> = {};
  try {
    if (fs.existsSync(storagePath)) {
      raw = JSON.parse(fs.readFileSync(storagePath, "utf8")) as Partial<StorageData>;
    }
  } catch {
    raw = {};
  }
  const defaults = defaultStorage();
  return {
    ...defaults,
    ...raw,
    // Always use the live machine IDs (they are deterministic so this is fine)
    machineId: raw.machineId ?? defaults.machineId,
    macMachineId: raw.macMachineId ?? defaults.macMachineId,
    devDeviceId: raw.devDeviceId ?? defaults.devDeviceId,
    privacyMode: raw.privacyMode ?? false,
    mcpGlobal: raw.mcpGlobal ?? [],
    hasLaunched: raw.hasLaunched ?? false,
  };
}

/**
 * Write a complete StorageData object to disk (mode 0600).
 */
export function writeStorage(data: StorageData): void {
  const storagePath = getStoragePath();
  const payload = { _version: STORAGE_VERSION, ...data };
  fs.writeFileSync(storagePath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
}

/**
 * Apply a partial update to storage.json.
 * Reads current, merges, writes back.
 */
export function updateStorage(partial: Partial<StorageData>): StorageData {
  const current = readStorage();
  const updated: StorageData = { ...current, ...partial };
  writeStorage(updated);
  return updated;
}

/**
 * Convenience: get just the machine IDs from storage (fast path).
 */
export function getStoredMachineIds(): Pick<StorageData, "machineId" | "macMachineId" | "devDeviceId"> {
  const s = readStorage();
  return { machineId: s.machineId, macMachineId: s.macMachineId, devDeviceId: s.devDeviceId };
}

/**
 * Mark the app as having been launched (suppresses the banner next time).
 */
export function markHasLaunched(): void {
  updateStorage({ hasLaunched: true });
}

/**
 * Toggle privacy mode and persist.
 */
export function setPrivacyMode(enabled: boolean): void {
  updateStorage({ privacyMode: enabled });
}

/**
 * Add or update a global MCP server entry.
 */
export function addGlobalMcpServer(entry: McpServerEntry): void {
  const s = readStorage();
  const existing = s.mcpGlobal.findIndex((e) => e.name === entry.name);
  if (existing >= 0) {
    s.mcpGlobal[existing] = entry;
  } else {
    s.mcpGlobal.push(entry);
  }
  writeStorage(s);
}

/**
 * Remove a global MCP server entry by name.
 */
export function removeGlobalMcpServer(name: string): void {
  const s = readStorage();
  s.mcpGlobal = s.mcpGlobal.filter((e) => e.name !== name);
  writeStorage(s);
}
