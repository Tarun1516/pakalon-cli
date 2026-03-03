/**
 * Undo Manager — tracks file operations performed by the AI agent and
 * allows reverting them one at a time or in bulk.
 *
 * Integrated with writeFileTool / deleteFileTool.
 * Exposed via `/undo` slash command which shows an interactive Ink menu.
 *
 * P2: Snapshots are persisted to `.pakalon/snapshots/` so they survive CLI restarts.
 * U: Named checkpoints for update guardrails + bulk rollback.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface FileSnapshot {
  id: string;
  path: string;
  previousContent: string | null; // null = file did not exist before (was created)
  newContent: string;
  operation: "write" | "delete";
  timestamp: Date;
  /** Optional tag linking this snapshot to a named checkpoint */
  checkpointId?: string;
}

/** Named checkpoint — marks a point in the undo history for bulk rollback */
export interface UndoCheckpoint {
  checkpointId: string;
  label: string;
  timestamp: Date;
  /** Index in history[] at the time the checkpoint was created */
  historyIndexAtCreation: number;
}

/** Conversation message for snapshot */
export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

/** Snapshot of conversation state for undo */
export interface ConversationSnapshot {
  id: string;
  messages: ConversationMessage[];
  timestamp: Date;
}

/** Resolve the .pakalon/snapshots directory relative to cwd (or home as fallback) */
function getSnapshotDir(): string {
  const cwd = process.cwd();
  const local = path.join(cwd, ".pakalon", "snapshots");
  try {
    fs.mkdirSync(local, { recursive: true });
    return local;
  } catch {
    const fallback = path.join(os.homedir(), ".pakalon", "snapshots");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

class UndoManager {
  private history: FileSnapshot[] = [];
  private checkpoints: UndoCheckpoint[] = [];
  private maxHistory = 50;

  constructor() {
    this.loadFromFs();
  }

  /**
   * Record a file write. Call BEFORE writing so we can snapshot old content.
   * Persists snapshot to `.pakalon/snapshots/<ts>_<id>.json` for restart recovery.
   * @param filePath Absolute path
   * @param newContent Content being written
   * @param previousContent Content before write (null if new file)
   */
  record(filePath: string, newContent: string, previousContent: string | null): void {
    const snapshot: FileSnapshot = {
      id: crypto.randomUUID(),
      path: filePath,
      previousContent,
      newContent,
      operation: "write",
      timestamp: new Date(),
    };
    this.history.push(snapshot);
    // Trim oldest if over limit
    if (this.history.length > this.maxHistory) {
      const evicted = this.history.splice(0, this.history.length - this.maxHistory);
      for (const s of evicted) this.deleteSnapshotFile(s.id);
    }
    // Persist to filesystem
    this.persistSnapshot(snapshot);
  }

  /**
   * Get the N most recent undoable operations.
   */
  getHistory(limit = 10): FileSnapshot[] {
    return this.history.slice(-limit).reverse();
  }

  /**
   * Undo a single operation by ID.
   * @returns The snapshot that was reverted, or null if not found.
   */
  undoById(id: string): FileSnapshot | null {
    const idx = this.history.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const snapshot = this.history[idx];
    if (!snapshot) return null;
    this.applyUndo(snapshot);
    this.history.splice(idx, 1);
    this.deleteSnapshotFile(snapshot.id);
    return snapshot;
  }

  /**
   * Undo the most recent operation.
   * @returns The snapshot that was reverted, or null if history is empty.
   */
  undoLast(): FileSnapshot | null {
    const snapshot = this.history.pop();
    if (!snapshot) return null;
    this.applyUndo(snapshot);
    this.deleteSnapshotFile(snapshot.id);
    return snapshot;
  }

  /**
   * Clear all recorded history without reverting (also removes snapshot files).
   */
  clear(): void {
    for (const s of this.history) this.deleteSnapshotFile(s.id);
    this.history = [];
    this.checkpoints = [];
  }

  // ─── Named checkpoints for update guardrails ──────────────────────────────

  /**
   * Create a named checkpoint at the current position in history.
   * All operations recorded AFTER this checkpoint can be bulk-rolled back.
   *
   * @param label Human-readable label (e.g. "before /update fix login bug")
   * @returns checkpointId — pass to rollbackToCheckpoint()
   */
  createNamedCheckpoint(label: string): string {
    const checkpointId = crypto.randomUUID();
    const checkpoint: UndoCheckpoint = {
      checkpointId,
      label,
      timestamp: new Date(),
      historyIndexAtCreation: this.history.length,
    };
    this.checkpoints.push(checkpoint);
    return checkpointId;
  }

  /**
   * Get all named checkpoints in chronological order.
   */
  getCheckpoints(): UndoCheckpoint[] {
    return [...this.checkpoints];
  }

  /**
   * Rollback all file changes made SINCE a named checkpoint.
   * Operations are undone in reverse order (newest first).
   *
   * @param checkpointId  ID returned by createNamedCheckpoint()
   * @returns List of reverted snapshots
   */
  rollbackToCheckpoint(checkpointId: string): FileSnapshot[] {
    const cp = this.checkpoints.find((c) => c.checkpointId === checkpointId);
    if (!cp) return [];

    // All operations after the checkpoint
    const toRevert = this.history.slice(cp.historyIndexAtCreation).reverse();
    for (const snap of toRevert) {
      this.applyUndo(snap);
      this.deleteSnapshotFile(snap.id);
    }
    // Trim history and remove checkpoint
    this.history = this.history.slice(0, cp.historyIndexAtCreation);
    this.checkpoints = this.checkpoints.filter((c) => c.checkpointId !== checkpointId);
    return toRevert;
  }

  get hasHistory(): boolean {
    return this.history.length > 0;
  }

  // ─── Filesystem persistence ────────────────────────────────────────────────

  private persistSnapshot(snapshot: FileSnapshot): void {
    try {
      const dir = getSnapshotDir();
      const ts = new Date(snapshot.timestamp).getTime();
      const file = path.join(dir, `${ts}_${snapshot.id}.json`);
      fs.writeFileSync(file, JSON.stringify(snapshot), "utf-8");
    } catch { /* best-effort — in-memory still works */ }
  }

  private deleteSnapshotFile(id: string): void {
    try {
      const dir = getSnapshotDir();
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(`_${id}.json`));
      for (const f of files) fs.unlinkSync(path.join(dir, f));
    } catch { /* best-effort */ }
  }

  /** Load persisted snapshots from .pakalon/snapshots/ on startup. */
  private loadFromFs(): void {
    try {
      const dir = getSnapshotDir();
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort(); // chronological (ts-prefixed filenames)
      for (const file of files.slice(-this.maxHistory)) {
        try {
          const raw = fs.readFileSync(path.join(dir, file), "utf-8");
          const snap = JSON.parse(raw) as FileSnapshot;
          snap.timestamp = new Date(snap.timestamp); // deserialize date
          this.history.push(snap);
        } catch { /* skip corrupt file */ }
      }
    } catch { /* no snapshot dir yet — that's fine */ }
  }

  // ─── Apply ────────────────────────────────────────────────────────────────

  private applyUndo(snapshot: FileSnapshot): void {
    const doUndo = async () => {
      try {
        if (snapshot.previousContent === null) {
          if (fs.existsSync(snapshot.path)) fs.unlinkSync(snapshot.path);
        } else {
          fs.writeFileSync(snapshot.path, snapshot.previousContent, "utf-8");
        }
      } catch { /* best-effort */ }
    };
    void doUndo();
  }
}

export const undoManager = new UndoManager();
