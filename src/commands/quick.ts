/**
 * quick.ts — Quick-action slash-commands forwarded to the Python agent bridge.
 * T0-2: /explain, /refactor, /fix-lint, /find-usages, /review, /docstring
 *
 * Each command builds a structured prompt and sends it to the backend via the
 * Bridge API on port 7432 (or PAKALON_BRIDGE_PORT env var).
 */

import axios from "axios";
import fs from "fs";
import path from "path";
import { filterContextFiles, safeReadForContext } from "../utils/env-mask";

const BRIDGE_PORT = process.env.PAKALON_BRIDGE_PORT ?? "7432";
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

export interface QuickResult {
  ok: boolean;
  output: string;
  error?: string;
  command: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** POST a quick prompt to the bridge and get a synchronous response. */
async function bridgePrompt(prompt: string, context?: string, timeoutMs = 60_000): Promise<string> {
  const payload: Record<string, unknown> = { prompt, stream: false };
  if (context) payload.context = context;

  const res = await axios.post(`${BRIDGE_URL}/quick`, payload, { timeout: timeoutMs });
  return (res.data?.result ?? res.data?.message ?? JSON.stringify(res.data)).trim();
}

/** Read a file and return its content (blocks .env files). */
function readFile(filePath: string): string | null {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return null;
  return safeReadForContext(abs);
}

/** Try to detect language from file extension. */
function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript (React)", ".js": "JavaScript",
    ".jsx": "JavaScript (React)", ".py": "Python", ".go": "Go",
    ".rs": "Rust", ".java": "Java", ".cs": "C#", ".cpp": "C++",
    ".c": "C", ".rb": "Ruby", ".swift": "Swift", ".kt": "Kotlin",
    ".php": "PHP", ".sql": "SQL", ".sh": "Shell", ".md": "Markdown",
  };
  return map[ext] ?? "code";
}

// ─────────────────────────────────────────────────────────────────────────────
// /explain <file|snippet>
// ─────────────────────────────────────────────────────────────────────────────

export async function explainCode(target: string): Promise<QuickResult> {
  const content = readFile(target);
  const lang = detectLanguage(target);

  const codeBlock = content ?? target; // if not a file, treat as raw snippet

  const prompt = `Explain the following ${lang} code clearly and concisely. Focus on:
1. What it does at a high level
2. Key algorithms or patterns used
3. Any non-obvious logic or gotchas
4. How it's expected to be used

\`\`\`${lang.toLowerCase().split(" ")[0]}
${codeBlock}
\`\`\``;

  try {
    const output = await bridgePrompt(prompt);
    return { ok: true, output, command: "explain" };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, output: "", error: e.message ?? String(err), command: "explain" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /refactor <file> [goal?]
// ─────────────────────────────────────────────────────────────────────────────

export async function refactorCode(filePath: string, goal?: string): Promise<QuickResult> {
  const content = readFile(filePath);
  if (!content) return { ok: false, output: "", error: `File not found: ${filePath}`, command: "refactor" };

  const lang = detectLanguage(filePath);
  const goalText = goal ? `Goal: ${goal}` : "Goal: improve readability, reduce complexity, apply best practices";

  const prompt = `Refactor the following ${lang} file. ${goalText}

Rules:
- Preserve all existing functionality (no behaviour changes)
- Keep the same public API / exports
- Show the complete refactored file, not just changed sections
- Add a brief comment above each significant change explaining WHY

\`\`\`${lang.toLowerCase().split(" ")[0]}
${content}
\`\`\`

Output format: refactored file inside a code block, followed by a bullet list of changes made.`;

  try {
    const output = await bridgePrompt(prompt, undefined, 120_000);
    return { ok: true, output, command: "refactor" };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, output: "", error: e.message ?? String(err), command: "refactor" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /fix-lint <file> [linter-output?]
// ─────────────────────────────────────────────────────────────────────────────

export async function fixLint(filePath: string, linterOutput?: string): Promise<QuickResult> {
  const content = readFile(filePath);
  if (!content) return { ok: false, output: "", error: `File not found: ${filePath}`, command: "fix-lint" };

  const lang = detectLanguage(filePath);
  const lintSection = linterOutput
    ? `\nLinter output to address:\n\`\`\`\n${linterOutput}\n\`\`\``
    : "\nFix all lint/style issues you can detect.";

  const prompt = `Fix all lint and style issues in this ${lang} file. ${lintSection}

Rules:
- Fix only lint/style issues; don't change logic
- Show the complete corrected file
- List each fix applied at the end

\`\`\`${lang.toLowerCase().split(" ")[0]}
${content}
\`\`\``;

  try {
    const output = await bridgePrompt(prompt, undefined, 90_000);
    return { ok: true, output, command: "fix-lint" };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, output: "", error: e.message ?? String(err), command: "fix-lint" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /find-usages <symbol> [file?]
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from "child_process";

export async function findUsages(symbol: string, limitToFile?: string): Promise<QuickResult> {
  try {
    // Try ripgrep first for speed
    const rgArgs = limitToFile
      ? `rg --no-heading -n "${symbol}" ${JSON.stringify(limitToFile)}`
      : `rg --no-heading -n "${symbol}" --glob "*.{ts,tsx,js,py}" .`;

    let output: string;
    try {
      output = execSync(rgArgs, { cwd: process.cwd(), encoding: "utf-8", maxBuffer: 1024 * 1024 });
    } catch (rgErr: unknown) {
      const e = rgErr as { stdout?: string };
      // rg exits non-zero when no matches found
      output = e.stdout ?? "(no usages found)";
    }

    const lines = output.trim().split("\n").filter(Boolean);
    const summary = lines.length
      ? `Found ${lines.length} usage(s) of \`${symbol}\`:\n\n${lines.slice(0, 50).join("\n")}${lines.length > 50 ? `\n... (${lines.length - 50} more)` : ""}`
      : `No usages of \`${symbol}\` found.`;

    return { ok: true, output: summary, command: "find-usages" };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, output: "", error: e.message ?? String(err), command: "find-usages" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /review <file> [pr-diff?]
// ─────────────────────────────────────────────────────────────────────────────

export async function reviewCode(filePath: string, prDiff?: string): Promise<QuickResult> {
  const content = prDiff ?? readFile(filePath);
  if (!content) return { ok: false, output: "", error: `File not found: ${filePath}`, command: "review" };

  const lang = prDiff ? "diff" : detectLanguage(filePath);
  const context = prDiff ? "Pull Request diff" : `${lang} file`;

  const prompt = `Perform a thorough code review of this ${context}. Provide:

1. **Summary** — what this code does
2. **Issues** — bugs, security flaws, performance problems (label severity: Critical/High/Medium/Low)
3. **Style & maintainability** — suggestions for cleaner code
4. **Praise** — what's done well (keep reviewers honest)
5. **Action items** — ordered list of changes recommended

\`\`\`${lang.toLowerCase().split(" ")[0]}
${content}
\`\`\``;

  try {
    const output = await bridgePrompt(prompt, undefined, 120_000);
    return { ok: true, output, command: "review" };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, output: "", error: e.message ?? String(err), command: "review" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /docstring <file|function-code>
// ─────────────────────────────────────────────────────────────────────────────

export async function generateDocstring(target: string): Promise<QuickResult> {
  const content = readFile(target) ?? target;
  const lang = readFile(target) ? detectLanguage(target) : "code";

  const prompt = `Add or improve docstrings/JSDoc comments for every function, class, and exported symbol in this ${lang} snippet.

Rules:
- Use the language's native doc format (JSDoc for JS/TS, Google-style for Python)
- Include @param, @returns, @throws where applicable
- Keep descriptions concise but complete
- Show the complete annotated code

\`\`\`${lang.toLowerCase().split(" ")[0]}
${content}
\`\`\``;

  try {
    const output = await bridgePrompt(prompt, undefined, 90_000);
    return { ok: true, output, command: "docstring" };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, output: "", error: e.message ?? String(err), command: "docstring" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch: parse "/quick <sub> [args...]" or directly from slash command
// ─────────────────────────────────────────────────────────────────────────────

export interface QuickCommandResult extends QuickResult {
  subCommand: string;
}

export async function handleQuickCommand(sub: string, args: string[]): Promise<QuickCommandResult> {
  switch (sub) {
    case "explain":
      return { ...(await explainCode(args.join(" "))), subCommand: "explain" };

    case "refactor":
      return { ...(await refactorCode(args[0] ?? "", args.slice(1).join(" ") || undefined)), subCommand: "refactor" };

    case "fix-lint":
    case "fixlint":
      return { ...(await fixLint(args[0] ?? "", args.slice(1).join("\n") || undefined)), subCommand: "fix-lint" };

    case "find-usages":
    case "usages":
      return { ...(await findUsages(args[0] ?? "", args[1])), subCommand: "find-usages" };

    case "review":
      return { ...(await reviewCode(args[0] ?? "")), subCommand: "review" };

    case "docstring":
    case "docs":
      return { ...(await generateDocstring(args.join(" "))), subCommand: "docstring" };

    default:
      return {
        ok: true,
        output: [
          "Quick commands:",
          "  /explain <file|snippet>      — explain what code does",
          "  /refactor <file> [goal]      — refactor with optional goal",
          "  /fix-lint <file> [output]    — fix lint/style issues",
          "  /find-usages <symbol> [file] — find all usages of a symbol",
          "  /review <file>               — code review",
          "  /docstring <file|snippet>    — add/improve docstrings",
        ].join("\n"),
        command: "help",
        subCommand: "help",
      };
  }
}
