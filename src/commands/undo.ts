/**
 * /undo command — 4-option undo menu for conversation and/or code changes.
 */
import fs from "fs";
import path from "path";
import { debugLog } from "@/utils/logger.js";

export type UndoOption = "conversation" | "code" | "both" | "nothing";

export interface UndoSnapshot {
  id: string;
  sessionId: string;
  conversationSnapshot: string; // JSON serialized messages
  codeSnapshot: Record<string, string>; // filepath -> content before change
  createdAt: string;
}

// In-memory undo stack for current session
const undoStack: UndoSnapshot[] = [];

/**
 * Push a snapshot before a write_file tool call.
 */
export function pushUndoSnapshot(
  sessionId: string,
  conversationSnapshot: string,
  codeChanges: Record<string, string>
): void {
  const snapshot: UndoSnapshot = {
    id: `undo_${Date.now()}`,
    sessionId,
    conversationSnapshot,
    codeSnapshot: codeChanges,
    createdAt: new Date().toISOString(),
  };
  undoStack.push(snapshot);
  // Keep last 50 snapshots
  if (undoStack.length > 50) undoStack.shift();
  debugLog(`[undo] Pushed snapshot ${snapshot.id}`);
}

/**
 * Get the latest snapshot for a session.
 */
export function peekUndo(sessionId: string): UndoSnapshot | null {
  for (let i = undoStack.length - 1; i >= 0; i--) {
    const snap = undoStack[i];
    if (snap && snap.sessionId === sessionId) {
      return snap;
    }
  }
  return null;
}

/**
 * Pop and apply the undo action.
 */
export async function applyUndo(
  sessionId: string,
  option: UndoOption
): Promise<{
  ok: boolean;
  restoredConversation?: string;
  restoredFiles?: string[];
  message: string;
}> {
  const snapshot = peekUndo(sessionId);

  if (!snapshot) {
    return { ok: false, message: "No undo history available for this session." };
  }

  if (option === "nothing") {
    return { ok: true, message: "No changes made." };
  }

  const restoredFiles: string[] = [];

  // Restore code files
  if ((option === "code" || option === "both") && snapshot.codeSnapshot) {
    for (const [filePath, content] of Object.entries(snapshot.codeSnapshot)) {
      try {
        if (content === "__DELETED__") {
          // File was created — delete it
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            restoredFiles.push(`deleted: ${filePath}`);
          }
        } else {
          fs.writeFileSync(filePath, content, "utf-8");
          restoredFiles.push(`restored: ${filePath}`);
        }
      } catch (e) {
        debugLog(`[undo] Failed to restore ${filePath}: ${String(e)}`);
      }
    }
  }

  // Remove from stack
  const idx = undoStack.findIndex((s) => s.id === snapshot.id);
  if (idx !== -1) undoStack.splice(idx, 1);

  const restoredConversation =
    option === "conversation" || option === "both"
      ? snapshot.conversationSnapshot
      : undefined;

  return {
    ok: true,
    restoredConversation,
    restoredFiles,
    message: buildUndoMessage(option, restoredFiles),
  };
}

function buildUndoMessage(option: UndoOption, files: string[]): string {
  switch (option) {
    case "conversation":
      return "✓ Conversation rewound to before last AI response.";
    case "code":
      return `✓ Code reverted: ${files.length} file(s) restored.`;
    case "both":
      return `✓ Conversation and code both reverted. ${files.length} file(s) restored.`;
    default:
      return "No changes made.";
  }
}

/**
 * Get a diff summary of changes that would be undone.
 */
export function getUndoDiff(sessionId: string): string {
  const snapshot = peekUndo(sessionId);
  if (!snapshot) return "No undo history available.";

  const files = Object.keys(snapshot.codeSnapshot);
  if (files.length === 0) return "No code changes in last action.";

  return files
    .map((f) => {
      const content = snapshot.codeSnapshot[f];
      if (content === "__DELETED__") return `  + created: ${path.basename(f)}`;
      return `  ~ modified: ${path.basename(f)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// T1-6: Multi-step rollback
// ---------------------------------------------------------------------------

/**
 * List all available undo snapshots for a session (newest first).
 */
export function listUndoSnapshots(sessionId: string): Array<{
  index: number;
  id: string;
  createdAt: string;
  fileCount: number;
  fileSummary: string;
}> {
  const snapshots = undoStack
    .filter((s) => s.sessionId === sessionId)
    .reverse(); // newest first

  return snapshots.map((snap, idx) => {
    const files = Object.keys(snap.codeSnapshot);
    const fileSummary = files.length
      ? files.slice(0, 3).map((f) => path.basename(f)).join(", ") + (files.length > 3 ? ` (+${files.length - 3} more)` : "")
      : "conversation only";
    return { index: idx, id: snap.id, createdAt: snap.createdAt, fileCount: files.length, fileSummary };
  });
}

/**
 * Rollback to a specific snapshot by index (0 = most recent, 1 = one before that, etc.)
 * All snapshots AFTER the target are discarded; the target itself is applied and removed.
 */
export async function applyUndoTo(
  sessionId: string,
  targetIndex: number,
  option: UndoOption
): Promise<{
  ok: boolean;
  restoredConversation?: string;
  restoredFiles?: string[];
  stepsRolledBack?: number;
  message: string;
}> {
  const sessionSnaps = undoStack
    .map((s, globalIdx) => ({ ...s, globalIdx }))
    .filter((s) => s.sessionId === sessionId)
    .reverse(); // newest first

  if (!sessionSnaps.length) {
    return { ok: false, message: "No undo history available for this session." };
  }

  if (targetIndex < 0 || targetIndex >= sessionSnaps.length) {
    return { ok: false, message: `Invalid snapshot index ${targetIndex}. Available: 0–${sessionSnaps.length - 1}.` };
  }

  if (option === "nothing") {
    return { ok: true, stepsRolledBack: 0, message: "No changes made." };
  }

  // Apply all snapshots from 0 up to and including targetIndex
  const toApply = sessionSnaps.slice(0, targetIndex + 1);
  const allRestoredFiles: string[] = [];
  let lastConversation: string | undefined;

  for (const snap of toApply) {
    // Restore code
    if ((option === "code" || option === "both") && snap.codeSnapshot) {
      for (const [filePath, content] of Object.entries(snap.codeSnapshot)) {
        try {
          if (content === "__DELETED__") {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              allRestoredFiles.push(`deleted: ${filePath}`);
            }
          } else {
            fs.writeFileSync(filePath, content, "utf-8");
            allRestoredFiles.push(`restored: ${filePath}`);
          }
        } catch (e) {
          debugLog(`[undo] Failed to restore ${filePath}: ${String(e)}`);
        }
      }
    }
    if (option === "conversation" || option === "both") {
      lastConversation = snap.conversationSnapshot;
    }
  }

  // Remove applied snapshots from the global stack
  const idsToRemove = new Set(toApply.map((s) => s.id));
  for (let i = undoStack.length - 1; i >= 0; i--) {
    if (idsToRemove.has(undoStack[i]!.id)) {
      undoStack.splice(i, 1);
    }
  }

  const stepsRolledBack = toApply.length;
  const uniqueFiles = [...new Set(allRestoredFiles.map((f) => f.split(": ")[1] ?? f))];

  return {
    ok: true,
    restoredConversation: lastConversation,
    restoredFiles: allRestoredFiles,
    stepsRolledBack,
    message: `\u2713 Rolled back ${stepsRolledBack} step(s). ${uniqueFiles.length} file(s) affected.`,
  };
}
