/**
 * exit-code.test.ts — Tests for exit code parsing middleware.
 *
 * Spec (CLI-req.md T-CLI-11):
 *  - Exit 0  → success, parse JSON from stdout
 *  - Exit 2  → permission / user-action required — block and surface to user
 *  - Other   → unexpected failure, raw stderr forwarded
 */

import { describe, it, expect } from "vitest";
import {
  parseExitCode,
  withExitCode,
  withExitCodeAsync,
  BlockedByExit2Error,
  type SubprocessResult,
  type ParsedResult,
} from "./exit-code";

describe("parseExitCode", () => {
  // ---------------------------------------------------------------------
  // Exit 0 - Success
  // ---------------------------------------------------------------------

  it("returns success with parsed JSON when exit code is 0 and stdout is valid JSON", () => {
    const result: SubprocessResult = {
      stdout: '{"status": "ok", "data": 123}',
      stderr: "",
      exitCode: 0,
    };

    const parsed = parseExitCode<{ status: string; data: number }>(result);

    expect(parsed.success).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.data).toEqual({ status: "ok", data: 123 });
    expect(parsed.requiresPermission).toBeUndefined();
  });

  it("returns success with raw string when exit code is 0 but stdout is not valid JSON", () => {
    const result: SubprocessResult = {
      stdout: "Hello World",
      stderr: "",
      exitCode: 0,
    };

    const parsed = parseExitCode(result);

    expect(parsed.success).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.data).toBe("Hello World");
  });

  it("returns success with empty string when exit code is 0 and stdout is empty", () => {
    const result: SubprocessResult = {
      stdout: "",
      stderr: "",
      exitCode: 0,
    };

    const parsed = parseExitCode(result);

    expect(parsed.success).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.data).toBe("");
  });

  it("returns success with raw string when jsonParse is false", () => {
    const result: SubprocessResult = {
      stdout: '{"should": "not-parse"}',
      stderr: "",
      exitCode: 0,
    };

    const parsed = parseExitCode(result, false);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toBe('{"should": "not-parse"}');
  });

  // ---------------------------------------------------------------------
  // Exit 2 - Permission Required
  // ---------------------------------------------------------------------

  it("returns requiresPermission=true when exit code is 2", () => {
    const result: SubprocessResult = {
      stdout: "",
      stderr: "Permission denied: cannot access /etc/passwd",
      exitCode: 2,
    };

    const parsed = parseExitCode(result);

    expect(parsed.success).toBe(false);
    expect(parsed.exitCode).toBe(2);
    expect(parsed.requiresPermission).toBe(true);
    expect(parsed.error).toContain("Permission denied");
  });

  it("returns requiresPermission=true with default message when exit 2 has no stderr", () => {
    const result: SubprocessResult = {
      stdout: "",
      stderr: "",
      exitCode: 2,
    };

    const parsed = parseExitCode(result);

    expect(parsed.requiresPermission).toBe(true);
    expect(parsed.error).toBe("Command requires user permission (exit 2)");
  });

  it("throws BlockedByExit2Error when exit code is 2 and throwOnExit2 is true", () => {
    const result: SubprocessResult = {
      stdout: "some output",
      stderr: "Permission denied",
      exitCode: 2,
    };

    expect(() => parseExitCode(result, true, true)).toThrow(BlockedByExit2Error);
  });

  it("BlockedByExit2Error contains stdout, stderr, and message", () => {
    const result: SubprocessResult = {
      stdout: "output data",
      stderr: "permission error",
      exitCode: 2,
    };

    try {
      parseExitCode(result, true, true);
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedByExit2Error);
      const error = err as BlockedByExit2Error;
      expect(error.stdout).toBe("output data");
      expect(error.stderr).toBe("permission error");
      expect(error.message).toContain("permission error");
    }
  });

  // ---------------------------------------------------------------------
  // Exit 1/127 - Failure
  // ---------------------------------------------------------------------

  it("returns failure with error message when exit code is 1", () => {
    const result: SubprocessResult = {
      stdout: "",
      stderr: "Command failed: file not found",
      exitCode: 1,
    };

    const parsed = parseExitCode(result);

    expect(parsed.success).toBe(false);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.error).toContain("Command exited with code 1");
    expect(parsed.raw).toBe("Command failed: file not found");
  });

  it("returns failure with stdout as raw when stderr is empty", () => {
    const result: SubprocessResult = {
      stdout: "some error output",
      stderr: "",
      exitCode: 127,
    };

    const parsed = parseExitCode(result);

    expect(parsed.success).toBe(false);
    expect(parsed.raw).toBe("some error output");
  });

  it("returns failure with generic message when both stdout and stderr are empty", () => {
    const result: SubprocessResult = {
      stdout: "",
      stderr: "",
      exitCode: 1,
    };

    const parsed = parseExitCode(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Command exited with code 1");
    expect(parsed.raw).toBe("");
  });

  it("handles various non-zero exit codes consistently", () => {
    const exitCodes = [1, 3, 4, 126, 127, 128, 255];

    for (const exitCode of exitCodes) {
      const result: SubprocessResult = {
        stdout: "",
        stderr: `Error code ${exitCode}`,
        exitCode,
      };

      const parsed = parseExitCode(result);
      expect(parsed.success).toBe(false);
      expect(parsed.exitCode).toBe(exitCode);
      expect(parsed.requiresPermission).toBeUndefined();
    }
  });
});

describe("withExitCode", () => {
  it("wraps a successful synchronous function", () => {
    const fn = (): SubprocessResult => ({
      stdout: '{"success": true}',
      stderr: "",
      exitCode: 0,
    });

    const result = withExitCode<{ success: boolean }>(fn);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ success: true });
  });

  it("propagates BlockedByExit2Error from the wrapped function", () => {
    const fn = (): SubprocessResult => ({
      stdout: "",
      stderr: "Permission required",
      exitCode: 2,
    });

    expect(() => withExitCode(fn, true, true)).toThrow(BlockedByExit2Error);
  });

  it("handles exceptions from the wrapped function", () => {
    const fn = (): SubprocessResult => {
      throw new Error("spawn failed");
    };

    const result = withExitCode(fn);
    expect(result.success).toBe(false);
    expect(result.error).toBe("spawn failed");
  });
});

describe("withExitCodeAsync", () => {
  it("wraps a successful async function", async () => {
    const fn = async (): Promise<SubprocessResult> => ({
      stdout: '{"success": true}',
      stderr: "",
      exitCode: 0,
    });

    const result = await withExitCodeAsync<{ success: boolean }>(fn);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ success: true });
  });

  it("propagates BlockedByExit2Error from the wrapped async function", async () => {
    const fn = async (): Promise<SubprocessResult> => ({
      stdout: "",
      stderr: "Permission required",
      exitCode: 2,
    });

    await expect(withExitCodeAsync(fn, true, true)).rejects.toThrow(BlockedByExit2Error);
  });

  it("handles exceptions from the wrapped async function", async () => {
    const fn = async (): Promise<SubprocessResult> => {
      throw new Error("async spawn failed");
    };

    const result = await withExitCodeAsync(fn);
    expect(result.success).toBe(false);
    expect(result.error).toBe("async spawn failed");
  });
});

describe("BlockedByExit2Error", () => {
  it("has correct name and message", () => {
    const error = new BlockedByExit2Error("test message", "out", "err");
    expect(error.name).toBe("BlockedByExit2Error");
    expect(error.message).toBe("test message");
  });

  it("captures stdout, stderr, and optional command", () => {
    const error = new BlockedByExit2Error("msg", "stdout-content", "stderr-content", "my-command");
    expect(error.stdout).toBe("stdout-content");
    expect(error.stderr).toBe("stderr-content");
    expect(error.command).toBe("my-command");
  });
});
