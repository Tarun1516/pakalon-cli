/**
 * error-help.ts — Error explanation and AI-assisted fix suggestions.
 * T2-7: /error-help <message> — search docs, suggest fixes, explain stack traces
 *
 * Steps:
 * 1. Parse / classify the error type
 * 2. Augment with code context if a file is active
 * 3. Send to Python bridge for AI analysis
 * 4. Optionally surface relevant docs URLs
 */

import axios from "axios";
import path from "path";
import fs from "fs";

const BRIDGE_PORT = process.env.PAKALON_BRIDGE_PORT ?? "7432";
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

export interface ErrorHelpResult {
  ok: boolean;
  output: string;
  error?: string;
  errorType?: string;
  suggestedFixes?: string[];
  docsUrls?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Error type classifier
// ─────────────────────────────────────────────────────────────────────────────

interface ErrorClassification {
  type: string;
  language: string;
  isNetworkError: boolean;
  isTypeError: boolean;
  isImportError: boolean;
  isSyntaxError: boolean;
  isRuntimeError: boolean;
  extractedSymbols: string[];
}

function classifyError(message: string): ErrorClassification {
  const m = message.toLowerCase();

  const isNetworkError = /econnrefused|econnreset|etimedout|fetch failed|network error|socket hang up/.test(m);
  const isTypeError = /typeerror|is not a function|cannot read prop|undefined is not|null is not/.test(m);
  const isImportError = /cannot find module|module not found|importerror|modulenotfounderror|no module named/.test(m);
  const isSyntaxError = /syntaxerror|unexpected token|unexpected end of input|invalid syntax/.test(m);
  const isRuntimeError = /runtimeerror|attributeerror|keyerror|indexerror|valueerror|zerodivision/.test(m);

  let language = "general";
  if (/\.py|python|traceback|most recent call last/.test(m)) language = "Python";
  else if (/\.ts|\.tsx|typescript|tserror/.test(m)) language = "TypeScript";
  else if (/\.js|\.jsx|javascript/.test(m)) language = "JavaScript";
  else if (/\.go|goroutine/.test(m)) language = "Go";
  else if (/\.rs|rust|panicked at/.test(m)) language = "Rust";

  let type = "RuntimeError";
  if (isNetworkError) type = "NetworkError";
  else if (isTypeError) type = "TypeError";
  else if (isImportError) type = "ImportError";
  else if (isSyntaxError) type = "SyntaxError";

  // Extract likely symbol names (CamelCase words, quoted strings, 'xxx' patterns)
  const symbolMatches = message.match(/['"`]([^'"`\s]+)['"`]|(\b[A-Z][a-zA-Z]+Error\b)|(\b\w+\(\))/g) ?? [];
  const extractedSymbols = [...new Set(symbolMatches.map((s) => s.replace(/['"`]/g, "")))].slice(0, 5);

  return { type, language, isNetworkError, isTypeError, isImportError, isSyntaxError, isRuntimeError, extractedSymbols };
}

// ─────────────────────────────────────────────────────────────────────────────
// Docs URL suggester (static knowledge, no web search needed)
// ─────────────────────────────────────────────────────────────────────────────

function suggestDocsUrls(cls: ErrorClassification, symbols: string[]): string[] {
  const urls: string[] = [];

  if (cls.language === "Python") {
    if (cls.isImportError) urls.push("https://docs.python.org/3/reference/import.html");
    if (cls.isSyntaxError) urls.push("https://docs.python.org/3/reference/expressions.html");
    if (cls.isRuntimeError) urls.push("https://docs.python.org/3/library/exceptions.html");
  }

  if (cls.language === "TypeScript") {
    if (cls.isTypeError) urls.push("https://www.typescriptlang.org/docs/handbook/2/types-from-types.html");
    if (cls.isImportError) urls.push("https://www.typescriptlang.org/tsconfig#moduleResolution");
    if (cls.isSyntaxError) urls.push("https://www.typescriptlang.org/docs/handbook/");
  }

  if (cls.isNetworkError) {
    urls.push("https://nodejs.org/api/errors.html#common-system-errors");
    urls.push("https://axios-http.com/docs/handling_errors");
  }

  // FastAPI / SQLAlchemy common errors
  if (symbols.some((s) => /sqlalchemy|alembic/i.test(s))) {
    urls.push("https://docs.sqlalchemy.org/en/20/errors.html");
  }
  if (symbols.some((s) => /fastapi|starlette/i.test(s))) {
    urls.push("https://fastapi.tiangolo.com/tutorial/handling-errors/");
  }

  return urls.slice(0, 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// AI bridge call
// ─────────────────────────────────────────────────────────────────────────────

async function askBridgeForFixSuggestions(errorText: string, codeContext?: string): Promise<string> {
  const contextSection = codeContext
    ? `\n\nRelevant code context:\n\`\`\`\n${codeContext.slice(0, 3000)}\n\`\`\``
    : "";

  const prompt = `A developer encountered this error:

\`\`\`
${errorText}
\`\`\`
${contextSection}

Please:
1. Explain what caused this error in plain English
2. List the most likely root causes (numbered)
3. Provide concrete fix suggestions with code examples
4. Mention any common gotchas related to this error type

Be specific and actionable.`;

  try {
    const res = await axios.post(`${BRIDGE_URL}/quick`, { prompt, stream: false }, { timeout: 45_000 });
    return (res.data?.result ?? res.data?.message ?? "").trim();
  } catch {
    return "(Bridge unavailable — start the Python bridge with /bridge start)";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read recent file context (last ~50 lines of active file in CWD)
// ─────────────────────────────────────────────────────────────────────────────

function extractFileContextFromError(errorText: string): string | undefined {
  const fileMatch = errorText.match(/(?:at|File|in)\s+["']?([^\s"']+\.[a-z]{1,5})["']?(?::\d+)?/);
  if (!fileMatch || !fileMatch[1]) return undefined;

  const filePath = path.resolve(process.cwd(), fileMatch[1]);
  if (!fs.existsSync(filePath)) return undefined;

  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const lineMatch = errorText.match(/:(\d+)/);
    if (lineMatch && lineMatch[1]) {
      const lineNo = parseInt(lineMatch[1], 10) - 1;
      const start = Math.max(0, lineNo - 10);
      const end = Math.min(lines.length, lineNo + 10);
      return `// ${fileMatch[1]}:${lineNo + 1}\n` + lines.slice(start, end).join("\n");
    }
    return lines.slice(-50).join("\n"); // last 50 lines
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export async function getErrorHelp(errorText: string): Promise<ErrorHelpResult> {
  if (!errorText) {
    return { ok: false, output: "", error: "Paste an error message or stack trace after /error-help" };
  }

  const cls = classifyError(errorText);
  const codeContext = extractFileContextFromError(errorText);
  const docsUrls = suggestDocsUrls(cls, cls.extractedSymbols);

  const aiAnalysis = await askBridgeForFixSuggestions(errorText, codeContext);

  const lines: string[] = [
    `Error type: ${cls.type} (${cls.language})`,
    "",
  ];

  if (aiAnalysis) {
    lines.push(aiAnalysis);
  }

  if (docsUrls.length) {
    lines.push("\nRelevant documentation:");
    docsUrls.forEach((u) => lines.push(`  • ${u}`));
  }

  return {
    ok: true,
    output: lines.join("\n"),
    errorType: cls.type,
    docsUrls,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

export async function handleErrorHelpCommand(args: string[]): Promise<ErrorHelpResult> {
  const errorText = args.join(" ");
  return getErrorHelp(errorText);
}
