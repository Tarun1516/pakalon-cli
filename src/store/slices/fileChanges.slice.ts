/**
 * fileChanges slice — tracks cumulative lines added/deleted across the
 * current session, for display in the FileChangeSummary panel.
 */
import type { StateCreator } from "zustand";

export interface FileChange {
  path: string;
  linesAdded: number;
  linesDeleted: number;
  changedAt: string;
}

export interface FileChangesState {
  sessionLinesAdded: number;
  sessionLinesDeleted: number;
  changedFiles: FileChange[];
  // Actions
  recordFileChange: (path: string, added: number, deleted: number) => void;
  clearFileChanges: () => void;
}

export const createFileChangesSlice: StateCreator<
  FileChangesState,
  [],
  [],
  FileChangesState
> = (set) => ({
  sessionLinesAdded: 0,
  sessionLinesDeleted: 0,
  changedFiles: [],

  recordFileChange: (filePath, added, deleted) =>
    set((s) => {
      // Update or insert the file record
      const existing = s.changedFiles.findIndex((f) => f.path === filePath);
      const changedFiles = [...s.changedFiles];
      if (existing >= 0) {
        changedFiles[existing] = {
          ...changedFiles[existing]!,
          linesAdded: changedFiles[existing]!.linesAdded + added,
          linesDeleted: changedFiles[existing]!.linesDeleted + deleted,
          changedAt: new Date().toISOString(),
        };
      } else {
        changedFiles.push({
          path: filePath,
          linesAdded: added,
          linesDeleted: deleted,
          changedAt: new Date().toISOString(),
        });
      }
      return {
        sessionLinesAdded: s.sessionLinesAdded + added,
        sessionLinesDeleted: s.sessionLinesDeleted + deleted,
        changedFiles,
      };
    }),

  clearFileChanges: () =>
    set({ sessionLinesAdded: 0, sessionLinesDeleted: 0, changedFiles: [] }),
});
