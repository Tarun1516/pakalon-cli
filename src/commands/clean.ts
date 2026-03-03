/**
 * clean.ts — Workspace cleanup slash-command.
 * T2-9: /clean — remove build artifacts, caches, temp files
 *
 * Provides a safe, dry-run first cleanup of common junk directories.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export interface CleanResult {
  ok: boolean;
  output: string;
  error?: string;
  bytesFreed?: number;
  pathsRemoved?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Directories / file patterns that are safe to delete
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_DIRS = [
  "node_modules/.cache",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "*.egg-info",
  ".tox",
  "htmlcov",
  ".coverage",
  "coverage",
  ".vite",
  ".parcel-cache",
  ".swc",
  "tmp",
  ".tmp",
  "temp",
  ".temp",
];

/** All paths matching a glob-ish pattern relative to root dir. */
function findMatchingPaths(root: string, pattern: string): string[] {
  const results: string[] = [];

  if (pattern.includes("*")) {
    const ext = pattern.replace("*", "");
    const scanDir = (dir: string, depth = 0) => {
      if (depth > 4) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name.endsWith(ext)) {
            results.push(full);
          } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            scanDir(full, depth + 1);
          }
        }
      } catch { /* ignore permission errors */ }
    };
    scanDir(root);
    return results;
  }

  const target = path.join(root, pattern);
  if (fs.existsSync(target)) results.push(target);

  // Also scan sub-dirs for __pycache__ style patterns
  if (!pattern.startsWith(".") && !pattern.includes("/")) {
    const scanDir = (dir: string, depth = 0) => {
      if (depth > 5) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const full = path.join(dir, entry.name);
          if (entry.name === pattern) {
            results.push(full);
          } else if (entry.name !== "node_modules" && entry.name !== ".git") {
            scanDir(full, depth + 1);
          }
        }
      } catch { /* ignore */ }
    };
    scanDir(root);
  }

  return results;
}

function getDirSize(dir: string): number {
  let size = 0;
  try {
    const stat = fs.statSync(dir);
    if (stat.isFile()) return stat.size;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) size += getDirSize(full);
      else {
        try { size += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return size;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function removeRecursive(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main clean function
// ─────────────────────────────────────────────────────────────────────────────

export interface CleanOptions {
  dryRun?: boolean;       // default true — preview only
  scope?: string;         // restrict to a subdirectory
  includeNodeModules?: boolean; // also delete node_modules (off by default)
}

export function cleanWorkspace(opts: CleanOptions = {}): CleanResult {
  const { dryRun = true, scope, includeNodeModules = false } = opts;
  const root = scope ? path.resolve(process.cwd(), scope) : process.cwd();

  if (!fs.existsSync(root)) {
    return { ok: false, output: "", error: `Path not found: ${root}` };
  }

  const patterns = [...SAFE_DIRS];
  if (includeNodeModules) patterns.push("node_modules");

  let totalBytes = 0;
  const found: string[] = [];
  const removed: string[] = [];

  for (const pattern of patterns) {
    const matches = findMatchingPaths(root, pattern);
    for (const p of matches) {
      const size = getDirSize(p);
      totalBytes += size;
      found.push(`${p} (${formatBytes(size)})`);

      if (!dryRun) {
        try {
          removeRecursive(p);
          removed.push(p);
        } catch (err: unknown) {
          const e = err as { message?: string };
          found[found.length - 1] += ` [ERROR: ${e.message}]`;
        }
      }
    }
  }

  if (found.length === 0) {
    return { ok: true, output: "Nothing to clean — workspace is already tidy.", bytesFreed: 0, pathsRemoved: [] };
  }

  const lines: string[] = [];

  if (dryRun) {
    lines.push(`DRY RUN — the following paths would be deleted (${formatBytes(totalBytes)} total):\n`);
    lines.push(...found.map((f) => `  - ${f}`));
    lines.push(`\nRun /clean --confirm to actually delete these files.`);
  } else {
    lines.push(`Cleaned ${removed.length} path(s), freed ${formatBytes(totalBytes)}:\n`);
    lines.push(...removed.map((r) => `  ✓ ${r}`));
    const failed = found.filter((f) => f.includes("[ERROR]"));
    if (failed.length) {
      lines.push(`\n${failed.length} path(s) failed to delete.`);
    }
  }

  return {
    ok: true,
    output: lines.join("\n"),
    bytesFreed: totalBytes,
    pathsRemoved: dryRun ? [] : removed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

export function handleCleanCommand(args: string[]): CleanResult {
  const confirm = args.includes("--confirm") || args.includes("-y");
  const nodeModules = args.includes("--node-modules") || args.includes("--nm");
  const scope = args.find((a) => !a.startsWith("--") && a !== "-y" && a !== "--nm");

  if (args.includes("--help") || args.includes("-h")) {
    return {
      ok: true,
      output: [
        "Usage: /clean [options] [path]",
        "",
        "Options:",
        "  --confirm        Actually delete (without this, preview only)",
        "  --node-modules   Also include node_modules directories",
        "  -h, --help       Show this help",
        "",
        "Examples:",
        "  /clean                   — preview what would be deleted",
        "  /clean --confirm         — delete build artifacts and caches",
        "  /clean --confirm --node-modules  — also delete node_modules",
        "  /clean pakalon-cli/      — clean only pakalon-cli subdirectory",
      ].join("\n"),
    };
  }

  return cleanWorkspace({ dryRun: !confirm, scope, includeNodeModules: nodeModules });
}
