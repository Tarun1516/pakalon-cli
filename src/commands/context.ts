/**
 * Context command — manage file context attachments.
 */
import * as fs from "fs";
import * as path from "path";

export interface ContextFile {
  filePath: string;
  size: number;
  exists: boolean;
}

const _contextFiles: string[] = [];

export function cmdAddContext(filePath: string): ContextFile {
  const abs = path.resolve(filePath);
  const exists = fs.existsSync(abs);
  if (exists && !_contextFiles.includes(abs)) {
    _contextFiles.push(abs);
  }
  return {
    filePath: abs,
    size: exists ? fs.statSync(abs).size : 0,
    exists,
  };
}

export function cmdRemoveContext(filePath: string): void {
  const abs = path.resolve(filePath);
  const idx = _contextFiles.indexOf(abs);
  if (idx !== -1) _contextFiles.splice(idx, 1);
}

export function cmdListContext(): ContextFile[] {
  return _contextFiles.map((f) => ({
    filePath: f,
    size: fs.existsSync(f) ? fs.statSync(f).size : 0,
    exists: fs.existsSync(f),
  }));
}

export function cmdClearContext(): void {
  _contextFiles.length = 0;
}

export function getContextFiles(): string[] {
  return [..._contextFiles];
}
