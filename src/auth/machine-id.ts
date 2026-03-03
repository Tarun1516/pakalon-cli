/**
 * Machine ID generation — deterministic, cross-platform hardware fingerprint.
 * Used to identify the CLI device without collecting PII.
 * Mirrors Cursor's telemetry.machineId / macMachineId / devDeviceId pattern.
 */
import { createHash, randomUUID } from "crypto";
import { execSync } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";

/**
 * Collect raw system identifiers available on each platform.
 * Returns an array of strings that are combined and hashed.
 */
function collectSystemIdentifiers(): string[] {
  const ids: string[] = [];

  // Hostname (stable but not unique enough alone)
  ids.push(os.hostname());

  // Platform + arch
  ids.push(`${os.platform()}-${os.arch()}`);

  // CPU model
  const cpus = os.cpus();
  if (cpus.length > 0) {
    ids.push(cpus[0]!.model);
  }

  // Total memory (relatively stable)
  ids.push(String(os.totalmem()));

  // Platform-specific IDs
  try {
    if (process.platform === "darwin") {
      // macOS: system hardware UUID
      const uuid = execSync(
        "ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID",
        { encoding: "utf8", timeout: 2000 }
      )
        .match(/"([0-9A-F-]{36})"/i)?.[1]
        ?.trim();
      if (uuid) ids.push(uuid);
    } else if (process.platform === "linux") {
      // Linux: machine-id
      const machineId = fs
        .readFileSync("/etc/machine-id", "utf8")
        .trim();
      if (machineId) ids.push(machineId);
    } else if (process.platform === "win32") {
      // Windows: MachineGuid from registry
      const guid = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: "utf8", timeout: 2000 }
      )
        .match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/)?.[1]
        ?.trim();
      if (guid) ids.push(guid);
    }
  } catch {
    // Non-fatal; fall back to hostname+cpu combination
  }

  return ids;
}

/**
 * Generate a deterministic SHA-256 machine ID.
 * The result is stable across invocations on the same machine.
 */
export function getMachineId(): string {
  const parts = collectSystemIdentifiers();
  return createHash("sha256")
    .update(parts.join("|"))
    .digest("hex");
}

/**
 * Generate a shorter 16-char device ID suitable for the device code flow.
 * This is NOT the same as the machine ID — it's a user-facing device token.
 */
export function getDeviceId(): string {
  const machineId = getMachineId();
  // Use first 16 hex chars for display brevity
  return machineId.substring(0, 16);
}

/**
 * Generate macMachineId: SHA-256 of the MAC addresses of all network interfaces.
 * Returns a deterministic hex string; empty interfaces are ignored.
 */
export function getMacMachineId(): string {
  const macs: string[] = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const [, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        const mac = (addr as any).mac;
        if (mac && mac !== "00:00:00:00:00:00") {
          macs.push(mac.toLowerCase());
        }
      }
    }
  } catch {
    // Non-fatal
  }
  // Stable sort so order is reproducible
  macs.sort();
  return createHash("sha256")
    .update(macs.join("|") || "no-mac")
    .digest("hex");
}

/**
 * Return the path to the Pakalon config directory for persistent storage.
 * Created on first access.
 */
function getConfigDir(): string {
  const base =
    process.env.PAKALON_CONFIG_DIR ??
    (process.platform === "win32"
      ? path.join(process.env.APPDATA ?? os.homedir(), "pakalon")
      : path.join(os.homedir(), ".config", "pakalon"));
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

/**
 * Return the devDeviceId — a persistent UUID v4 stored in storage.json.
 * Generated once on first run, never changes afterwards.
 */
export function getDevDeviceId(): string {
  const storagePath = path.join(getConfigDir(), "storage.json");
  try {
    if (fs.existsSync(storagePath)) {
      const raw = JSON.parse(fs.readFileSync(storagePath, "utf8"));
      if (raw?.devDeviceId && typeof raw.devDeviceId === "string") {
        return raw.devDeviceId;
      }
    }
  } catch {
    // fall through to generation
  }
  const id = randomUUID();
  // Write back — read-modify-write to preserve other keys
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(storagePath)) {
      existing = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    }
  } catch {
    // ignore
  }
  existing.devDeviceId = id;
  fs.writeFileSync(storagePath, JSON.stringify(existing, null, 2), { encoding: "utf8", mode: 0o600 });
  return id;
}

/**
 * Return the path to Cursor's globalStorage/storage.json, if it exists.
 * Cursor follows VS Code's storage conventions per platform.
 */
function getCursorStoragePath(): string | null {
  let base: string;
  if (process.platform === "win32") {
    base = path.join(process.env.APPDATA ?? os.homedir(), "Cursor", "User", "globalStorage");
  } else if (process.platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage");
  } else {
    base = path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage");
  }
  const p = path.join(base, "storage.json");
  return fs.existsSync(p) ? p : null;
}

/**
 * Attempt to read Cursor's persisted machine IDs from its storage.json.
 * Returns null if Cursor is not installed or the file is unreadable.
 */
function readCursorMachineIds(): Partial<MachineIds> | null {
  try {
    const p = getCursorStoragePath();
    if (!p) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    const machineId = typeof raw["telemetry.machineId"] === "string" ? raw["telemetry.machineId"] : undefined;
    const macMachineId = typeof raw["telemetry.macMachineId"] === "string" ? raw["telemetry.macMachineId"] : undefined;
    const devDeviceId = typeof raw["telemetry.devDeviceId"] === "string" ? raw["telemetry.devDeviceId"] : undefined;
    if (!machineId && !macMachineId && !devDeviceId) return null;
    return { machineId, macMachineId, devDeviceId };
  } catch {
    return null;
  }
}

/**
 * Return all three Cursor-compatible machine identifiers.
 * Priority: Cursor's own storage.json (if installed) → hardware fingerprint.
 * This is the single function that should be called for telemetry reporting.
 */
export interface MachineIds {
  machineId: string;      // SHA-256 of hardware fingerprint (or Cursor's value)
  macMachineId: string;   // SHA-256 of network MAC addresses (or Cursor's value)
  devDeviceId: string;    // Persistent UUID v4 (Cursor's or Pakalon's own)
}

export function getMachineIds(): MachineIds {
  // T-CLI-AUTH: Try Cursor's storage.json first — reuse the same IDs so Pakalon
  // telemetry aligns with Cursor's device tracking for users who have both installed.
  const cursor = readCursorMachineIds();
  return {
    machineId: cursor?.machineId ?? getMachineId(),
    macMachineId: cursor?.macMachineId ?? getMacMachineId(),
    devDeviceId: cursor?.devDeviceId ?? getDevDeviceId(),
  };
}
