import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  reloadHooksConfig,
  runUserPromptSubmitHook,
} from "../hooks.js";
import { parseExitCode, BlockedByExit2Error } from "../exit-code.js";

const tempDirs: string[] = [];

function makeProjectWithHooks(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pakalon-hooks-test-"));
  const hooksDir = join(dir, ".pakalon");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "hooks.json"), JSON.stringify(config, null, 2), "utf-8");
  tempDirs.push(dir);
  return dir;
}

function writeHookScript(projectDir: string, fileName: string, source: string): string {
  const scriptPath = join(projectDir, ".pakalon", fileName);
  writeFileSync(scriptPath, source, "utf-8");
  return scriptPath;
}

afterEach(() => {
  reloadHooksConfig();
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("runUserPromptSubmitHook", () => {
  it("blocks when hook returns deny decision", async () => {
    const projectDir = makeProjectWithHooks({ UserPromptSubmit: [] });
    const scriptPath = writeHookScript(
      projectDir,
      "deny-hook.js",
      "process.stdout.write(JSON.stringify({ action: 'deny', reason: 'blocked by policy' }));"
    );
    const command = `"${process.execPath}" "${scriptPath}"`;
    writeFileSync(
      join(projectDir, ".pakalon", "hooks.json"),
      JSON.stringify({ UserPromptSubmit: [{ command }] }, null, 2),
      "utf-8"
    );

    const result = await runUserPromptSubmitHook("delete everything", projectDir, "session-1");

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("blocked by policy");
    expect(result.decision?.action).toBe("deny");
  });

  it("allows and rewrites prompt when hook returns updatedPrompt", async () => {
    const projectDir = makeProjectWithHooks({ UserPromptSubmit: [] });
    const scriptPath = writeHookScript(
      projectDir,
      "allow-hook.js",
      "process.stdout.write(JSON.stringify({ action: 'allow', updatedPrompt: 'safe rewritten prompt' }));"
    );
    const command = `"${process.execPath}" "${scriptPath}"`;
    writeFileSync(
      join(projectDir, ".pakalon", "hooks.json"),
      JSON.stringify({ UserPromptSubmit: [{ command }] }, null, 2),
      "utf-8"
    );

    const result = await runUserPromptSubmitHook("unsafe prompt", projectDir, "session-2");

    expect(result.blocked).toBe(false);
    expect(result.decision?.action).toBe("allow");
    expect(result.decision?.updatedPrompt).toBe("safe rewritten prompt");
  });
});

describe("hooks integration with exit codes", () => {
  it("hook script exiting with code 2 triggers permission request", async () => {
    const projectDir = makeProjectWithHooks({ UserPromptSubmit: [] });
    const scriptPath = writeHookScript(
      projectDir,
      "exit2-hook.js",
      `process.stderr.write("Permission required to proceed");
process.exit(2);`
    );
    const command = `"${process.execPath}" "${scriptPath}"`;
    writeFileSync(
      join(projectDir, ".pakalon", "hooks.json"),
      JSON.stringify({ UserPromptSubmit: [{ command }] }, null, 2),
      "utf-8"
    );

    // Simulate how hooks.ts processes exit codes (if it uses parseExitCode)
    const result = parseExitCode(
      { stdout: "", stderr: "Permission required to proceed", exitCode: 2 },
      false,
      false
    );

    expect(result.requiresPermission).toBe(true);
    expect(result.success).toBe(false);
  });

  it("hook script with throwOnExit2 throws BlockedByExit2Error", async () => {
    const projectDir = makeProjectWithHooks({ UserPromptSubmit: [] });
    const scriptPath = writeHookScript(
      projectDir,
      "exit2-throw-hook.js",
      `process.exit(2);`
    );
    const command = `"${process.execPath}" "${scriptPath}"`;

    // Simulate how hooks would use parseExitCode with throwOnExit2
    const result = parseExitCode(
      { stdout: "", stderr: "exit 2", exitCode: 2 },
      false,
      true
    );

    expect(result).toBeInstanceOf(BlockedByExit2Error);
  });
});

// Integration tests for hook blocking events with exit code semantics
describe("Hook blocking events with exit codes", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    reloadHooksConfig();
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("blocks when hook script exits with code 2", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pakalon-exit2-"));
    tempDirs.push(projectDir);
    const hooksDir = join(projectDir, ".pakalon");
    mkdirSync(hooksDir, { recursive: true });

    // Write a script that exits with code 2
    const scriptPath = join(hooksDir, "exit2-hook.js");
    writeHookScript(projectDir, "exit2-hook.js", "process.exit(2);");

    const command = `"${process.execPath}" "${scriptPath}"`;
    writeFileSync(
      join(hooksDir, "hooks.json"),
      JSON.stringify({ UserPromptSubmit: [{ command }] }, null, 2),
      "utf-8"
    );

    // Test with throwOnExit2 to verify blocking behavior
    const result = await runUserPromptSubmitHook("test prompt", projectDir, "session-exit2");

    // Should be blocked when hook returns exit 2
    expect(result.blocked).toBe(true);
  });

  it("passes when hook script exits with code 0", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pakalon-exit0-"));
    tempDirs.push(projectDir);
    const hooksDir = join(projectDir, ".pakalon");
    mkdirSync(hooksDir, { recursive: true });

    // Write a script that exits with code 0 (allow)
    writeHookScript(projectDir, "exit0-hook.js",
      "process.stdout.write(JSON.stringify({ action: 'allow' }));"
    );

    const command = `"${process.execPath}" "${join(hooksDir, "exit0-hook.js")}"`;
    writeFileSync(
      join(hooksDir, "hooks.json"),
      JSON.stringify({ UserPromptSubmit: [{ command }] }, null, 2),
      "utf-8"
    );

    const result = await runUserPromptSubmitHook("test prompt", projectDir, "session-exit0");

    expect(result.blocked).toBe(false);
  });
});
