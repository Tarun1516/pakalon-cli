/**
 * test-gen.ts — AI-powered test generation command.
 * T2-12: /test-gen <file> [--framework vitest|jest|pytest] [--output <path>]
 *
 * Sends the source file to Python bridge and writes a ready-to-run test file.
 */

import axios from "axios";
import fs from "fs";
import path from "path";
import { safeReadForContext } from "../utils/env-mask";
import { lockedWrite } from "../utils/file-lock";

const BRIDGE_PORT = process.env.PAKALON_BRIDGE_PORT ?? "7432";
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

export interface TestGenResult {
  ok: boolean;
  output: string;
  error?: string;
  testFilePath?: string;
  framework?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Framework detection
// ─────────────────────────────────────────────────────────────────────────────

function detectFramework(filePath: string, cwd: string): "vitest" | "jest" | "pytest" | "unknown" {
  const ext = path.extname(filePath).toLowerCase();

  if ([".py"].includes(ext)) return "pytest";

  // Check package.json for test framework
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return "vitest";
      if (deps.jest || deps["@jest/core"]) return "jest";
    } catch { /* ignore */ }
  }

  // Check vitest.config.ts / jest.config.ts
  if (fs.existsSync(path.join(cwd, "vitest.config.ts"))) return "vitest";
  if (fs.existsSync(path.join(cwd, "jest.config.ts")) || fs.existsSync(path.join(cwd, "jest.config.js"))) return "jest";

  return ext === ".py" ? "pytest" : "vitest";
}

function testFileExtension(framework: string): string {
  return framework === "pytest" ? ".test.py" : ".test.ts";
}

function defaultTestFilePath(sourceFile: string, framework: string): string {
  const dir = path.dirname(sourceFile);
  const base = path.basename(sourceFile, path.extname(sourceFile));
  const ext = testFileExtension(framework);
  return path.join(dir, `${base}${ext}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────────────────────────────────────

function buildTestGenPrompt(
  content: string,
  filePath: string,
  framework: "vitest" | "jest" | "pytest" | "unknown"
): string {
  const lang = framework === "pytest" ? "Python" : "TypeScript";
  const frameworkName = framework === "unknown" ? "vitest" : framework;

  return `Generate a complete, production-quality test suite for this ${lang} file using ${frameworkName}.

Source file: ${path.basename(filePath)}

\`\`\`${lang.toLowerCase()}
${content}
\`\`\`

Requirements:
1. Import the module correctly (use relative paths as needed)
2. Test every exported function/class/method
3. Include happy-path, edge-case, and error-path tests
4. Mock external dependencies (axios, fs, db calls, etc.) appropriately
5. Use descriptive test names following the pattern: "should <do something> when <condition>"
6. Aim for >80% coverage of the source file
7. Use ${frameworkName} syntax exclusively (describe/it/expect for ${frameworkName === "pytest" ? "pytest-bdd or plain pytest" : frameworkName})
8. Add a brief comment block at the top explaining the test strategy

Output ONLY the test file content, inside a single code block. No explanations before or after.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge call
// ─────────────────────────────────────────────────────────────────────────────

async function requestTestGenFromBridge(prompt: string): Promise<string> {
  const res = await axios.post(
    `${BRIDGE_URL}/quick`,
    { prompt, stream: false },
    { timeout: 180_000 } // 3 min — test generation is slow
  );
  return (res.data?.result ?? res.data?.message ?? "").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract code block from LLM response
// ─────────────────────────────────────────────────────────────────────────────

function extractCodeBlock(response: string): string {
  // Match ```[lang]\n...\n```
  const match = response.match(/```(?:[a-z]*)\n([\s\S]+?)```/);
  if (match) return match[1]!.trim();
  // If no code block, return the whole response trimmed
  return response.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export interface TestGenOptions {
  framework?: "vitest" | "jest" | "pytest";
  outputPath?: string;
  write?: boolean; // default false — display only; true to write to disk
}

export async function generateTests(
  filePath: string,
  opts: TestGenOptions = {}
): Promise<TestGenResult> {
  const absSource = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absSource)) {
    return { ok: false, output: "", error: `File not found: ${absSource}` };
  }

  const content = safeReadForContext(absSource);
  if (!content) {
    return { ok: false, output: "", error: `Could not read file (blocked or binary): ${absSource}` };
  }

  const framework = opts.framework ?? detectFramework(absSource, process.cwd());
  const testPath = opts.outputPath
    ? path.resolve(process.cwd(), opts.outputPath)
    : defaultTestFilePath(absSource, framework);

  const prompt = buildTestGenPrompt(content, absSource, framework);

  let rawResponse: string;
  try {
    rawResponse = await requestTestGenFromBridge(prompt);
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, output: "", error: `Bridge error: ${e.message ?? String(err)}` };
  }

  const testCode = extractCodeBlock(rawResponse);

  if (opts.write) {
    const writeResult = await lockedWrite(testPath, testCode, "test-gen");
    if (!writeResult.ok) {
      return { ok: false, output: "", error: writeResult.message };
    }
    return {
      ok: true,
      output: `Test file written to: ${testPath}\n\nRun with: ${framework === "pytest" ? `pytest ${testPath}` : `npx ${framework} run ${testPath}`}`,
      testFilePath: testPath,
      framework,
    };
  }

  return {
    ok: true,
    output: `Generated test suite (${framework}) for ${path.basename(absSource)}:\n\nSave path: ${testPath}\n\n\`\`\`\n${testCode}\n\`\`\`\n\nRun /test-gen ${filePath} --write to save this file.`,
    testFilePath: testPath,
    framework,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

export async function handleTestGenCommand(args: string[]): Promise<TestGenResult> {
  const writeFlag = args.includes("--write") || args.includes("-w");
  const frameworkIdx = args.findIndex((a) => a === "--framework" || a === "-f");
  const outputIdx = args.findIndex((a) => a === "--output" || a === "-o");

  const framework = frameworkIdx >= 0
    ? (args[frameworkIdx + 1] as "vitest" | "jest" | "pytest" | undefined)
    : undefined;
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

  const filePath = args.find((a) => !a.startsWith("-") && a !== framework && a !== outputPath);

  if (!filePath) {
    return {
      ok: true,
      output: [
        "Usage: /test-gen <file> [options]",
        "",
        "Options:",
        "  --framework <vitest|jest|pytest>   Override framework auto-detection",
        "  --output <path>                    Custom output path for test file",
        "  --write, -w                        Write test file to disk",
        "",
        "Examples:",
        "  /test-gen src/utils/retry.ts                 — preview tests",
        "  /test-gen src/utils/retry.ts --write         — write test file",
        "  /test-gen python/agents/phase1/graph.py -w   — Python pytest",
      ].join("\n"),
    };
  }

  return generateTests(filePath, { framework, outputPath, write: writeFlag });
}

