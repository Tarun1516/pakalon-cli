/**
 * /directory command — show tree of current directory + .pakalon/ context info.
 */
import fs from "fs";
import path from "path";
import { debugLog } from "@/utils/logger.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
  ".turbo",
  ".cache",
]);

/**
 * Generate a tree listing of the directory.
 */
function buildTree(
  dirPath: string,
  prefix: string = "",
  depth: number = 0,
  maxDepth: number = 3
): string[] {
  if (depth > maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const sorted = entries.sort((a, b) => {
    // Directories first
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    if (!entry) continue;
    const isLast = i === sorted.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const nextPrefix = isLast ? prefix + "    " : prefix + "│   ";

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) {
        lines.push(`${prefix}${connector}${entry.name}/ (ignored)`);
        continue;
      }
      lines.push(`${prefix}${connector}${entry.name}/`);
      if (depth < maxDepth) {
        const subLines = buildTree(
          path.join(dirPath, entry.name),
          nextPrefix,
          depth + 1,
          maxDepth
        );
        lines.push(...subLines);
      }
    } else {
      lines.push(`${prefix}${connector}${entry.name}`);
    }
  }

  return lines;
}

/** Returns a directory tree string for use in TUI */
export function cmdDirectoryTree(cwd: string = process.cwd()): string {
  const dirName = path.basename(cwd);
  const lines = [`${dirName}/`, ...buildTree(cwd)];
  return lines.join("\n");
}

export function cmdDirectory(cwd: string = process.cwd()): void {
  const dirName = path.basename(cwd);
  console.log(`\n  ${dirName}/`);

  const tree = buildTree(cwd);
  for (const line of tree) {
    console.log(`  ${line}`);
  }

  // Show .pakalon/ context if exists
  const pakalonDir = path.join(cwd, ".pakalon");
  if (fs.existsSync(pakalonDir)) {
    console.log("\n── .pakalon/ Context ─────────────────────────────────\n");

    const pakalonFiles = fs.readdirSync(pakalonDir);
    for (const file of pakalonFiles.sort()) {
      const filePath = path.join(pakalonDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const size = stat.size;
        const kb = size < 1024 ? `${size}B` : `${Math.round(size / 1024)}KB`;
        console.log(`  .pakalon/${file.padEnd(30)} ${kb}`);
      }
    }
  }

  // Count files and folders
  const countItems = (dir: string, depth: number): { files: number; dirs: number } => {
    if (depth > 5) return { files: 0, dirs: 0 };
    let files = 0, dirs = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.isDirectory()) {
          dirs++;
          const sub = countItems(path.join(dir, entry.name), depth + 1);
          files += sub.files;
          dirs += sub.dirs;
        } else {
          files++;
        }
      }
    } catch { /* skip */ }
    return { files, dirs };
  };

  const counts = countItems(cwd, 0);
  console.log(`\n  ${counts.dirs} directories, ${counts.files} files\n`);

  debugLog(`[directory] Listed ${cwd}: ${counts.dirs} dirs, ${counts.files} files`);
}
