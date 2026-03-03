/**
 * file-lock.ts — Advisory file-level write lock for concurrent agent access.
 * T1-6: Prevents multiple agents from corrupting the same file simultaneously.
 *
 * Uses a simple in-memory registry + lockfile on disk (`.pakalon/.locks/<hash>.lock`).
 * Advisory: agents that respect the lock won't write; external editors produce a diff prompt.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

/** Map from absolute file path → lock token (UUID) */
const IN_MEMORY_LOCKS = new Map<string, { token: string; owner: string; acquiredAt: Date }>();

function lockDir(): string {
  return path.join(os.tmpdir(), "pakalon-locks");
}

function lockFilePath(filePath: string): string {
  const hash = crypto.createHash("sha1").update(path.resolve(filePath)).digest("hex").slice(0, 12);
  return path.join(lockDir(), `${hash}.lock`);
}

function ensureLockDir(): void {
  const dir = lockDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Information about who holds a lock. */
export interface LockInfo {
  token: string;
  owner: string;
  acquiredAt: Date;
  filePath: string;
}

/**
 * Attempt to acquire a write lock on `filePath`.
 *
 * @param filePath  Absolute path to the file.
 * @param owner     Human-readable label (e.g. "Phase3-SA1", "user@agent-x").
 * @param timeoutMs If already locked, how long to wait before giving up (default 10s).
 * @returns Lock token string if successful, null if timed out.
 */
export async function acquireLock(
  filePath: string,
  owner: string,
  timeoutMs = 10_000
): Promise<string | null> {
  ensureLockDir();
  const absPath = path.resolve(filePath);
  const start = Date.now();

  while (true) {
    // Check in-memory (same process)
    if (!IN_MEMORY_LOCKS.has(absPath)) {
      const token = crypto.randomUUID();
      IN_MEMORY_LOCKS.set(absPath, { token, owner, acquiredAt: new Date() });

      // Also write disk lockfile for cross-process coordination
      const lfp = lockFilePath(absPath);
      try {
        fs.writeFileSync(lfp, JSON.stringify({ token, owner, filePath: absPath, acquiredAt: new Date().toISOString() }), { flag: "wx" });
      } catch {
        // Another process grabbed it — clean up in-memory and try again
        IN_MEMORY_LOCKS.delete(absPath);
        // fall through to wait
      }

      if (IN_MEMORY_LOCKS.has(absPath) && IN_MEMORY_LOCKS.get(absPath)!.token === token) {
        return token;
      }
    }

    if (Date.now() - start >= timeoutMs) {
      return null; // Timed out
    }

    // Wait 200ms before retrying
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Release a previously acquired lock.
 *
 * @param filePath  Absolute path that was locked.
 * @param token     Token returned by acquireLock.
 * @returns true if released, false if token didn't match (stale/wrong owner).
 */
export function releaseLock(filePath: string, token: string): boolean {
  const absPath = path.resolve(filePath);
  const existing = IN_MEMORY_LOCKS.get(absPath);

  if (!existing || existing.token !== token) {
    return false;
  }

  IN_MEMORY_LOCKS.delete(absPath);

  // Remove disk lockfile
  const lfp = lockFilePath(absPath);
  try {
    fs.unlinkSync(lfp);
  } catch {
    // Ignore if already gone
  }

  return true;
}

/**
 * Check if a file is currently locked, and by whom.
 */
export function getLockInfo(filePath: string): LockInfo | null {
  const absPath = path.resolve(filePath);
  const mem = IN_MEMORY_LOCKS.get(absPath);
  if (mem) {
    return { ...mem, filePath: absPath };
  }

  // Check disk lockfile (another process may hold it)
  const lfp = lockFilePath(absPath);
  try {
    const raw = fs.readFileSync(lfp, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      token: parsed.token,
      owner: parsed.owner,
      acquiredAt: new Date(parsed.acquiredAt),
      filePath: absPath,
    };
  } catch {
    return null;
  }
}

/**
 * Detect if a file was externally modified while a lock is held.
 * Returns true if the file's mtime is newer than the lock's acquiredAt.
 */
export function wasExternallyModified(filePath: string, lockToken: string): boolean {
  const absPath = path.resolve(filePath);
  const lockInfo = getLockInfo(absPath);

  if (!lockInfo || lockInfo.token !== lockToken) return false;

  try {
    const stat = fs.statSync(absPath);
    return stat.mtime > lockInfo.acquiredAt;
  } catch {
    return false;
  }
}

/**
 * Safely write a file with locking.
 * Checks for external modification before writing.
 *
 * @returns object with `ok`, `conflictDetected`, `message`
 */
export async function lockedWrite(
  filePath: string,
  content: string,
  owner: string
): Promise<{ ok: boolean; conflictDetected: boolean; message: string }> {
  const absPath = path.resolve(filePath);
  const token = await acquireLock(absPath, owner, 15_000);

  if (!token) {
    const info = getLockInfo(absPath);
    return {
      ok: false,
      conflictDetected: false,
      message: `Could not acquire lock on ${path.basename(filePath)} (held by ${info?.owner ?? "unknown"} since ${info?.acquiredAt.toISOString() ?? "?"})`,
    };
  }

  try {
    // Check for external modification
    if (fs.existsSync(absPath) && wasExternallyModified(absPath, token)) {
      return {
        ok: false,
        conflictDetected: true,
        message: `File ${path.basename(filePath)} was modified externally while lock was held. Use /diff to review before overwriting.`,
      };
    }

    // Ensure directory exists
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");

    return { ok: true, conflictDetected: false, message: `Written: ${filePath}` };
  } finally {
    releaseLock(absPath, token);
  }
}

/**
 * Release all locks held by a given owner (for cleanup on phase completion).
 */
export function releaseAllLocksForOwner(owner: string): number {
  let count = 0;
  for (const [filePath, info] of IN_MEMORY_LOCKS.entries()) {
    if (info.owner === owner) {
      IN_MEMORY_LOCKS.delete(filePath);
      const lfp = lockFilePath(filePath);
      try { fs.unlinkSync(lfp); } catch { /* ignore */ }
      count++;
    }
  }
  return count;
}

/** List all currently active locks (for debugging / /status command). */
export function listActiveLocks(): LockInfo[] {
  return Array.from(IN_MEMORY_LOCKS.entries()).map(([fp, info]) => ({
    ...info,
    filePath: fp,
  }));
}
