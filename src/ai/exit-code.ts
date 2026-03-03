/**
 * exit-code.ts — Exit code parsing middleware for subprocess output.
 *
 * Spec (CLI-req.md T-CLI-11):
 *  - Exit 0  → success, parse JSON from stdout
 *  - Exit 2  → permission / user-action required — block and surface to user
 *  - Other   → unexpected failure, raw stderr forwarded
 */

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ParsedResult<T = unknown> {
  success: boolean;
  exitCode: number;
  data?: T;
  error?: string;
  raw?: string;
  /** Set to true when exitCode === 2 — means the command hit a permission wall */
  requiresPermission?: boolean;
}

/**
 * Thrown when a command exits with code 2 and the caller opts into strict
 * blocking (throwOnExit2 = true). Catch this in the bash tool to surface a
 * permission-request event to the TUI.
 */
export class BlockedByExit2Error extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly command?: string;

  constructor(message: string, stdout: string, stderr: string, command?: string) {
    super(message);
    this.name = "BlockedByExit2Error";
    this.stdout = stdout;
    this.stderr = stderr;
    this.command = command;
  }
}

/**
 * Parse the result of a subprocess call using exit code conventions.
 *
 * @param result - Raw subprocess output (stdout, stderr, exitCode)
 * @param jsonParse - Whether to JSON-parse stdout on success (default true)
 * @param throwOnExit2 - When true, throws BlockedByExit2Error on exit code 2
 *                       so the bash tool can surface a permission-request event.
 */
export function parseExitCode<T = unknown>(
  result: SubprocessResult,
  jsonParse = true,
  throwOnExit2 = false
): ParsedResult<T> {
  const { stdout, stderr, exitCode } = result;

  if (exitCode === 0) {
    // Success path — attempt to parse JSON from stdout
    if (jsonParse && stdout.trim()) {
      try {
        const data = JSON.parse(stdout.trim()) as T;
        return { success: true, exitCode, data };
      } catch {
        // Not JSON — return raw string as data
        return { success: true, exitCode, data: stdout as unknown as T };
      }
    }
    return { success: true, exitCode, data: stdout as unknown as T };
  }

  if (exitCode === 2) {
    // Permission / user-action required
    const message = stderr.trim() || "Command requires user permission (exit 2)";
    if (throwOnExit2) {
      throw new BlockedByExit2Error(message, stdout, stderr);
    }
    return { success: false, exitCode, error: message, requiresPermission: true };
  }

  // Unexpected failure (exit code 1, 127, etc.)
  const raw = stderr.trim() || stdout.trim();
  return {
    success: false,
    exitCode,
    error: `Command exited with code ${exitCode}`,
    raw,
  };
}

/**
 * Wrap execSync/spawnSync calls with exit code parsing.
 * Returns a consistent ParsedResult regardless of success or failure.
 *
 * @param throwOnExit2 - When true, propagates BlockedByExit2Error on exit 2.
 */
export function withExitCode<T = unknown>(
  fn: () => SubprocessResult,
  jsonParse = true,
  throwOnExit2 = false
): ParsedResult<T> {
  try {
    const result = fn();
    return parseExitCode<T>(result, jsonParse, throwOnExit2);
  } catch (err: unknown) {
    // Re-throw BlockedByExit2Error — the caller must handle it
    if (err instanceof BlockedByExit2Error) throw err;

    // execSync throws on non-zero exit; extract the error fields
    if (err && typeof err === "object") {
      const e = err as {
        stdout?: Uint8Array | string;
        stderr?: Uint8Array | string;
        status?: number;
        message?: string;
      };
      const exitCode = e.status ?? 1;
      const stdout = String(e.stdout ?? "");
      const stderr = String(e.stderr ?? e.message ?? "");
      return parseExitCode<T>({ stdout, stderr, exitCode }, jsonParse, throwOnExit2);
    }
    return {
      success: false,
      exitCode: 1,
      error: String(err),
    };
  }
}

/**
 * Async version — wraps async subprocess calls.
 *
 * @param throwOnExit2 - When true, propagates BlockedByExit2Error on exit 2.
 */
export async function withExitCodeAsync<T = unknown>(
  fn: () => Promise<SubprocessResult>,
  jsonParse = true,
  throwOnExit2 = false
): Promise<ParsedResult<T>> {
  try {
    const result = await fn();
    return parseExitCode<T>(result, jsonParse, throwOnExit2);
  } catch (err: unknown) {
    if (err instanceof BlockedByExit2Error) throw err;

    if (err && typeof err === "object") {
      const e = err as {
        stdout?: Uint8Array | string;
        stderr?: Uint8Array | string;
        status?: number;
        message?: string;
      };
      const exitCode = e.status ?? 1;
      const stdout = String(e.stdout ?? "");
      const stderr = String(e.stderr ?? e.message ?? "");
      return parseExitCode<T>({ stdout, stderr, exitCode }, jsonParse, throwOnExit2);
    }
    return {
      success: false,
      exitCode: 1,
      error: String(err),
    };
  }
}
