/**
 * search.ts — Workspace search slash-commands.
 * T1-4: /search <query>, /find-symbol <name>, /goto <file:line>, /grep <pattern>
 *
 * Uses ripgrep (rg) when available, falls back to basic grep / custom logic.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export interface SearchResult {
  ok: boolean;
  output: string;
  error?: string;
  matches?: SearchMatch[];
}

export interface SearchMatch {
  file: string;
  line: number;
  column?: number;
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RESULTS = 200;

function rgAvailable(): boolean {
  try {
    execSync("rg --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runRg(args: string): { stdout: string; ok: boolean } {
  try {
    const stdout = execSync(`rg ${args}`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), ok: true };
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    return { stdout: (e.stdout ?? "").trim(), ok: false };
  }
}

function parseRgOutput(raw: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // Format: file:line:col:text  (JSON output would be cleaner but harder to read)
    const m = line.match(/^([^:]+):(\d+):(\d+):(.*)/);
    if (m) {
      matches.push({ file: m[1]!, line: parseInt(m[2]!, 10), column: parseInt(m[3]!, 10), text: m[4]! });
    }
  }
  return matches;
}

function formatMatches(matches: SearchMatch[], query: string): string {
  if (!matches.length) return `No results for: ${query}`;

  const grouped: Record<string, SearchMatch[]> = {};
  for (const m of matches) {
    (grouped[m.file] ??= []).push(m);
  }

  const lines: string[] = [`Found ${matches.length} match(es) for "${query}":\n`];
  for (const [file, ms] of Object.entries(grouped)) {
    lines.push(`  ${file}`);
    for (const m of ms.slice(0, 20)) {
      const col = m.column ? `:${m.column}` : "";
      lines.push(`    L${m.line}${col}: ${m.text.trim()}`);
    }
    if (ms.length > 20) lines.push(`    ... (${ms.length - 20} more in this file)`);
  }

  if (matches.length >= MAX_RESULTS) {
    lines.push(`\n(results capped at ${MAX_RESULTS} — refine your query for more precision)`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// /search <query> — full-text search across workspace
// ─────────────────────────────────────────────────────────────────────────────

export function searchWorkspace(query: string, glob?: string): SearchResult {
  if (!query) return { ok: false, output: "", error: "Query required." };

  const globArg = glob ? `--glob ${JSON.stringify(glob)}` : '--glob "*.{ts,tsx,js,jsx,py,go,rs,java,cs,md}"';
  const args = `--no-heading --column --smart-case -m ${MAX_RESULTS} ${globArg} ${JSON.stringify(query)}`;

  if (rgAvailable()) {
    const { stdout } = runRg(args);
    const matches = parseRgOutput(stdout);
    return { ok: true, output: formatMatches(matches, query), matches };
  }

  // Fallback: basic recursive grep
  try {
    const out = execSync(`grep -rn --include="*.ts" --include="*.py" --include="*.js" -m ${MAX_RESULTS} "${query}" .`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, output: out.trim() || "No results." };
  } catch (err: unknown) {
    const e = err as { stdout?: string; message?: string };
    const out = e.stdout?.trim();
    if (out) return { ok: true, output: out };
    return { ok: false, output: "", error: `grep failed: ${e.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /find-symbol <name> — find class, function, variable definitions
// ─────────────────────────────────────────────────────────────────────────────

export function findSymbol(name: string): SearchResult {
  if (!name) return { ok: false, output: "", error: "Symbol name required." };

  // Patterns that match function/class/variable definitions across languages
  const patterns = [
    // TS/JS
    `(function|const|let|var|class|interface|type|enum)\\s+${name}[\\s<({=]`,
    `export\\s+(default\\s+)?(function|const|class|async function)\\s+${name}[\\s<({]`,
    // Python
    `(def|class)\\s+${name}[\\s(:]`,
    // Go
    `func\\s+\\(?\\w*\\)?\\s*${name}\\s*\\(`,
  ];

  const combined = patterns.join("|");

  if (rgAvailable()) {
    const args = `--no-heading --column --smart-case -m ${MAX_RESULTS} --glob "*.{ts,tsx,js,jsx,py,go,rs}" -e ${JSON.stringify(combined)}`;
    const { stdout } = runRg(args);
    const matches = parseRgOutput(stdout);
    if (matches.length) return { ok: true, output: formatMatches(matches, name), matches };
  }

  // Fallback: just search for the name literally
  return searchWorkspace(name, "*.{ts,tsx,js,py,go}");
}

// ─────────────────────────────────────────────────────────────────────────────
// /goto <file:line> — open file at a specific line (outputs a clickable path)
// ─────────────────────────────────────────────────────────────────────────────

export interface GotoTarget {
  file: string;
  line?: number;
  exists: boolean;
  content?: string;
}

export function resolveGoto(target: string): GotoTarget {
  const match = target.match(/^(.+?):(\d+)$/);
  const filePart = match ? match[1]! : target;
  const linePart = match ? parseInt(match[2]!, 10) : undefined;
  const abs = path.resolve(process.cwd(), filePart);

  if (!fs.existsSync(abs)) {
    return { file: abs, line: linePart, exists: false };
  }

  if (linePart !== undefined) {
    const lines = fs.readFileSync(abs, "utf-8").split("\n");
    const start = Math.max(0, linePart - 3);
    const end = Math.min(lines.length, linePart + 3);
    const context = lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1 === linePart ? "→" : " "} ${start + i + 1}: ${l}`)
      .join("\n");
    return { file: abs, line: linePart, exists: true, content: context };
  }

  return { file: abs, line: undefined, exists: true };
}

export function gotoTarget(target: string): SearchResult {
  const result = resolveGoto(target);
  if (!result.exists) {
    return { ok: false, output: "", error: `File not found: ${result.file}` };
  }

  const lineInfo = result.line ? `:${result.line}` : "";
  let output = `File: ${result.file}${lineInfo}`;
  if (result.content) {
    output += `\n\n${result.content}`;
  }
  return { ok: true, output };
}

// ─────────────────────────────────────────────────────────────────────────────
// /grep <pattern> [path?] — raw regex grep
// ─────────────────────────────────────────────────────────────────────────────

export function grepPattern(pattern: string, scopePath?: string): SearchResult {
  if (!pattern) return { ok: false, output: "", error: "Pattern required." };

  const scope = scopePath ? JSON.stringify(path.resolve(process.cwd(), scopePath)) : ".";
  const args = `--no-heading --column -m ${MAX_RESULTS} ${scope} -e ${JSON.stringify(pattern)}`;

  if (rgAvailable()) {
    const { stdout } = runRg(args);
    const matches = parseRgOutput(stdout);
    return { ok: true, output: formatMatches(matches, pattern), matches };
  }

  try {
    const out = execSync(`grep -rn -m ${MAX_RESULTS} -E "${pattern}" ${scope}`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, output: out.trim() || "No matches." };
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    return { ok: true, output: e.stdout?.trim() || "No matches." };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /files <pattern> — find files by name pattern
// ─────────────────────────────────────────────────────────────────────────────

export function findFiles(pattern: string): SearchResult {
  if (!pattern) return { ok: false, output: "", error: "Pattern required." };

  if (rgAvailable()) {
    const args = `--files --glob ${JSON.stringify(`*${pattern}*`)} .`;
    const { stdout } = runRg(args);
    const files = stdout.split("\n").filter(Boolean);
    const output = files.length
      ? `Found ${files.length} file(s):\n${files.slice(0, 50).join("\n")}${files.length > 50 ? `\n... (${files.length - 50} more)` : ""}`
      : `No files matching: *${pattern}*`;
    return { ok: true, output };
  }

  try {
    const out = execSync(`find . -name "*${pattern}*" -not -path "*/node_modules/*" -not -path "*/.git/*"`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output: out.trim() || "No files found." };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, output: "", error: e.message ?? String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchCommandResult extends SearchResult {
  subCommand: string;
}

export function handleSearchCommand(sub: string, args: string[]): SearchCommandResult {
  switch (sub) {
    case "search":
      return { ...searchWorkspace(args[0] ?? "", args[1]), subCommand: "search" };

    case "find-symbol":
    case "symbol":
      return { ...findSymbol(args[0] ?? ""), subCommand: "find-symbol" };

    case "goto":
      return { ...gotoTarget(args[0] ?? ""), subCommand: "goto" };

    case "grep":
      return { ...grepPattern(args[0] ?? "", args[1]), subCommand: "grep" };

    case "files":
    case "find-files":
      return { ...findFiles(args[0] ?? ""), subCommand: "files" };

    default:
      return {
        ok: true,
        output: [
          "Search commands:",
          "  /search <query> [glob]         — full-text search",
          "  /find-symbol <name>            — find definition of a symbol",
          "  /goto <file:line>              — open file at line with context",
          "  /grep <regex> [path]           — raw regex search",
          "  /files <pattern>               — find files by name",
        ].join("\n"),
        subCommand: "help",
      };
  }
}
