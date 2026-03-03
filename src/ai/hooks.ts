/**
 * Tool Hooks System (P6) — Claude Code Protocol Parity
 * ─────────────────────────────────────────────────────
 * Allows users to register pre/post hooks that run automatically around
 * tool executions (writeFile, editFile, patchFile, bash, etc.) as well as
 * lifecycle events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse).
 *
 * Claude Code-compatible hook protocol:
 *  - Hooks receive a JSON payload on stdin describing the event/tool context.
 *  - Hooks can output a JSON `HookDecision` to stdout to control execution.
 *  - Exit code 2 → deny (blocking). Exit 0 + valid JSON → parsed decision.
 *  - Exit 0 without JSON → allow (non-blocking informational hook).
 *  - `blockOnFail: true` elevates any non-zero exit to a deny decision.
 *
 * Example hooks.json:
 * ```json
 * {
 *   "PreToolUse": [
 *     {
 *       "match": "bash",
 *       "command": "node .pakalon/hooks/shell-guard.js",
 *       "blockOnFail": true
 *     }
 *   ],
 *   "SessionStart": [
 *     { "command": "node .pakalon/hooks/on-start.js" }
 *   ],
 *   "afterWrite": [
 *     { "match": "*.ts", "command": "npx eslint --fix {{filePath}}" }
 *   ]
 * }
 * ```
 *
 * All hook runs are stored in a ring buffer (last 100) accessible via
 * `getHookRunLog()` for diagnostics.
 */
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Legacy file-operation events (always non-blocking unless blockOnFail). */
export type LegacyHookEvent =
  | "beforeWrite"
  | "afterWrite"
  | "beforeEdit"
  | "afterEdit"
  | "beforePatch"
  | "afterPatch"
  | "beforeBash"
  | "afterBash"
  | "beforeDelete"
  | "afterDelete";

/**
 * Claude Code-compatible lifecycle events.
 * `PreToolUse` and `UserPromptSubmit` hooks CAN block execution via
 * `HookDecision.action = "deny"` or exit code 2.
 */
export type LifecycleHookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  // Claude Code extended events (T-A01 - T-A09)
  | "PermissionRequest"
  | "PostToolUseFailure"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "TeammateIdle"
  | "TaskCompleted"
  | "ConfigChange"
  | "WorktreeCreate"
  | "WorktreeRemove"
  | "PreCompact";

export type HookEvent = LegacyHookEvent | LifecycleHookEvent;

/** Events that support blocking/decision output. */
export const BLOCKING_EVENTS = new Set<HookEvent>([
  "PreToolUse",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
  "ConfigChange",
  "WorktreeCreate",
  "PreCompact",
  "beforeWrite",
  "beforeEdit",
  "beforePatch",
  "beforeBash",
  "beforeDelete",
]);

/**
 * JSON decision returned by Claude Code-protocol hooks.
 * Hook writes this to stdout; pakalon reads + acts on it.
 */
export interface HookDecision {
  /** "allow" proceeds, "deny" cancels the tool call, "ask" prompts the user. */
  action: "allow" | "deny" | "ask";
  /** Human-readable reason (shown in TUI when action !== "allow"). */
  reason?: string;
  /** Updated tool input to use instead of the original (allow only). */
  updatedInput?: Record<string, unknown>;
  /** Override the user prompt (UserPromptSubmit hooks only). */
  updatedPrompt?: string;
  /** Continue field for Stop hook - "stop" blocks session end, anything else allows */
  continue?: boolean;
  /** Additional context to inject into the conversation */
  additionalContext?: string;
}

/** Structured result of a single hook execution. */
export interface HookRunResult {
  event: HookEvent;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Present when the hook returned a valid JSON decision. */
  decision?: HookDecision;
  /** True when the hook blocked the action. */
  blocked: boolean;
}

/**
 * Payload sent to hooks on stdin (JSON-serialised).
 * Follows the Claude Code hook payload schema.
 */
export interface HookPayload {
  event: HookEvent;
  /** Tool name for PreToolUse/PostToolUse events. */
  tool_name?: string;
  /** Raw tool input object. */
  tool_input?: Record<string, unknown>;
  /** User prompt text for UserPromptSubmit events. */
  prompt?: string;
  /** Affected file path (if known). */
  file_path?: string;
  /** Shell command for bash hooks. */
  command?: string;
  /** Current working directory. */
  cwd: string;
  /** ISO timestamp. */
  timestamp: string;
  /** pakalon session ID (if available). */
  session_id?: string;
}

export interface HookDefinition {
  /** Hook type: "command" (default), "http", "prompt", or "agent" */
  type?: "command" | "http" | "prompt" | "agent";
  /** Glob pattern to match the filePath or tool_name (ignored for bash hooks). */
  match?: string;
  /** Shell command to run (for type: "command"). Use {{filePath}} and {{cwd}} as placeholders. */
  command?: string;
  /** URL to POST to (for type: "http") */
  url?: string;
  /** HTTP method (default: POST) */
  method?: "GET" | "POST";
  /** Headers for HTTP hook (for type: "http") */
  headers?: Record<string, string>;
  /** Model to use for prompt/agent hooks (default: fast model) */
  model?: string;
  /** System message for prompt/agent hooks */
  systemMessage?: string;
  /** Maximum turns for agent hooks (default: 50) */
  maxTurns?: number;
  /** Allowed tools for agent hooks */
  allowedTools?: string[];
  /** Timeout in ms (default 10 000). */
  timeoutMs?: number;
  /**
   * If true, hook runs in background without blocking Claude's response.
   * Results delivered on next turn via additionalContext.
   */
  async?: boolean;
  /**
   * If true, any non-zero exit code is treated as a deny decision.
   * Only applies to blocking events; ignored for informational events.
   */
  blockOnFail?: boolean;
}

export type HooksConfig = Partial<Record<HookEvent, HookDefinition[]>>;

export interface HookContext {
  filePath?: string;
  command?: string;
  cwd?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  prompt?: string;
  sessionId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics ring buffer
// ─────────────────────────────────────────────────────────────────────────────

const HOOK_LOG_MAX = 100;
const _hookRunLog: HookRunResult[] = [];

/** Append a result to the diagnostics ring buffer. */
function _logHookResult(result: HookRunResult): void {
  if (_hookRunLog.length >= HOOK_LOG_MAX) _hookRunLog.shift();
  _hookRunLog.push(result);
}

/** Return the last N hook run results (most recent last). */
export function getHookRunLog(limit = 20): HookRunResult[] {
  return _hookRunLog.slice(-limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Config loading
// ─────────────────────────────────────────────────────────────────────────────

let _hooksConfig: HooksConfig | null = null;
let _hooksConfigPath: string | null = null;

/**
 * Load (or reload) hooks.json from `.pakalon/hooks.json`.
 * Falls back to an empty config if the file does not exist.
 */
export function loadHooksConfig(projectDir?: string): HooksConfig {
  const cwd = projectDir ?? process.cwd();
  const configPath = path.join(cwd, ".pakalon", "hooks.json");

  // Only reload if the path changed or first run
  if (_hooksConfigPath !== configPath) {
    _hooksConfig = null;
    _hooksConfigPath = configPath;
  }

  if (_hooksConfig) return _hooksConfig;

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      _hooksConfig = JSON.parse(raw) as HooksConfig;
      logger.debug("[Hooks] Loaded hooks.json", { configPath });
    } else {
      _hooksConfig = {};
    }
  } catch (err) {
    logger.warn("[Hooks] Failed to parse hooks.json", { err: String(err) });
    _hooksConfig = {};
  }

  return _hooksConfig;
}

/** Invalidate the cached config (call after editing hooks.json). */
export function reloadHooksConfig(): void {
  _hooksConfig = null;
}

/**
 * T-HK-13: Add a hook entry to `.pakalon/hooks.json`.
 * Creates the file if it doesn't exist.
 * @returns The config file path.
 */
export function addHook(
  event: string,
  hookDef: Record<string, unknown>,
  scope: "project" | "global" = "project",
  projectDir?: string,
): string {
  const dir = scope === "global"
    ? path.join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? "~", ".pakalon")
    : path.join(projectDir ?? process.cwd(), ".pakalon");
  const configPath = path.join(dir, "hooks.json");

  let config: HooksConfig = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as HooksConfig; } catch { /* ignore */ }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  const existing = (config[event] ?? []) as unknown[];
  (config as Record<string, unknown>)[event] = [...existing, hookDef];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  _hooksConfig = null; // invalidate cache
  return configPath;
}

/**
 * T-HK-13: Remove a hook entry from `.pakalon/hooks.json` by index (0-based within event).
 * @returns true if removed, false if index out of range.
 */
export function removeHook(
  event: string,
  index: number,
  scope: "project" | "global" = "project",
  projectDir?: string,
): boolean {
  const dir = scope === "global"
    ? path.join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? "~", ".pakalon")
    : path.join(projectDir ?? process.cwd(), ".pakalon");
  const configPath = path.join(dir, "hooks.json");

  if (!fs.existsSync(configPath)) return false;
  let config: HooksConfig = {};
  try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as HooksConfig; } catch { return false; }

  const hooks = (config[event] ?? []) as unknown[];
  if (index < 0 || index >= hooks.length) return false;

  hooks.splice(index, 1);
  (config as Record<string, unknown>)[event] = hooks;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  _hooksConfig = null;
  return true;
}

/**
 * T-HK-13: Set `disableAllHooks` flag in `.pakalon/hooks.json`.
 */
export function setHooksDisabled(
  disabled: boolean,
  projectDir?: string,
): void {
  const dir = path.join(projectDir ?? process.cwd(), ".pakalon");
  const configPath = path.join(dir, "hooks.json");
  let config: HooksConfig & { disableAllHooks?: boolean } = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as typeof config; } catch { /* ignore */ }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  config.disableAllHooks = disabled;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  _hooksConfig = null;
}

/** Write a hooks.json skeleton to `.pakalon/hooks.json` if it doesn't exist. */
export function initHooksConfig(projectDir?: string): string {
  const cwd = projectDir ?? process.cwd();
  const dir = path.join(cwd, ".pakalon");
  const configPath = path.join(dir, "hooks.json");

  if (fs.existsSync(configPath)) return configPath;

  const skeleton: HooksConfig = {
    // Claude Code-compatible lifecycle hooks
    SessionStart: [
      // { "command": "node .pakalon/hooks/on-start.js" }
    ],
    UserPromptSubmit: [
      // Block prompts matching a forbidden pattern:
      // { "command": "node .pakalon/hooks/prompt-guard.js", "blockOnFail": true }
    ],
    PreToolUse: [
      // Guard shell commands before execution:
      // { "match": "bash", "command": "node .pakalon/hooks/shell-guard.js", "blockOnFail": true }
    ],
    PostToolUse: [],
    // Legacy file operation hooks
    afterWrite: [
      { match: "*.ts", command: "npx eslint --fix {{filePath}} --quiet", timeoutMs: 15000 },
    ],
    afterEdit: [
      { match: "*.py", command: "black {{filePath}}", timeoutMs: 10000 },
    ],
    beforeWrite: [],
    afterBash: [],
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(skeleton, null, 2), "utf-8");
  reloadHooksConfig();
  return configPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "##DSTAR##")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/##DSTAR##/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function _matchesHook(hook: HookDefinition, event: HookEvent, ctx: HookContext): boolean {
  if (!hook.match) return true;
  const matchTarget =
    (["PreToolUse", "PostToolUse"].includes(event) ? ctx.toolName : ctx.filePath) ?? "";
  const basename = path.basename(matchTarget);
  let re: RegExp;
  try {
    re = hook.match.startsWith("^") || hook.match.includes("|")
      ? new RegExp(hook.match)
      : _globToRegex(hook.match);
  } catch {
    re = _globToRegex(hook.match);
  }
  return re.test(matchTarget) || re.test(basename);
}

/**
 * Run a single hook command, optionally feeding a JSON payload on stdin.
 * Returns a structured `HookRunResult`.
 */
async function _runSingleHook(
  event: HookEvent,
  hook: HookDefinition,
  ctx: HookContext,
  payload: HookPayload
): Promise<HookRunResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const filePath = ctx.filePath ?? "";
  const cmd = hook.command
    .replace(/\{\{filePath\}\}/g, filePath)
    .replace(/\{\{cwd\}\}/g, cwd)
    .replace(/\{\{toolName\}\}/g, ctx.toolName ?? "");

  const timeoutMs = hook.timeoutMs ?? 10000;
  const isBlocking = BLOCKING_EVENTS.has(event);
  const t0 = Date.now();

  return new Promise<HookRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(cmd, {
      shell: true,
      cwd,
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send payload on stdin for lifecycle events
    if (child.stdin) {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    }

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code: number | null) => {
      const exitCode = code ?? 1;
      const durationMs = Date.now() - t0;

      let decision: HookDecision | undefined;
      let blocked = false;

      // Parse JSON decision from stdout (Claude Code protocol)
      const trimmedOut = stdout.trim();
      if (trimmedOut.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmedOut) as Partial<HookDecision>;
          if (parsed.action === "allow" || parsed.action === "deny" || parsed.action === "ask") {
            decision = parsed as HookDecision;
          }
        } catch {
          // Not valid JSON — treat as informational output
        }
      }

      if (isBlocking) {
        if (exitCode === 2) {
          blocked = true;
          decision = decision ?? { action: "deny", reason: stderr.trim() || "Hook exited with code 2" };
        } else if (exitCode !== 0 && hook.blockOnFail) {
          blocked = true;
          decision = decision ?? { action: "deny", reason: stderr.trim() || `Hook failed (exit ${exitCode})` };
        } else if (decision?.action === "deny") {
          blocked = true;
        }
      }

      const result: HookRunResult = {
        event,
        command: cmd,
        exitCode,
        stdout: trimmedOut,
        stderr: stderr.trim(),
        durationMs,
        decision,
        blocked,
      };

      _logHookResult(result);

      if (blocked) {
        logger.warn(`[Hook:${event}] BLOCKED by hook`, {
          command: cmd,
          reason: decision?.reason,
          exitCode,
        });
      } else if (exitCode !== 0) {
        logger.warn(`[Hook:${event}] Hook failed (non-blocking): ${cmd}`, {
          exitCode,
          stderr: stderr.trim(),
        });
      } else {
        if (trimmedOut) logger.debug(`[Hook:${event}] ${cmd}\n${trimmedOut}`);
        if (stderr.trim()) logger.debug(`[Hook:${event}] stderr: ${stderr.trim()}`);
      }

      resolve(result);
    });

    child.on("error", (err: Error) => {
      const durationMs = Date.now() - t0;
      const result: HookRunResult = {
        event,
        command: cmd,
        exitCode: 1,
        stdout: "",
        stderr: err.message,
        durationMs,
        blocked: false,
      };
      _logHookResult(result);
      logger.warn(`[Hook:${event}] Spawn error: ${cmd}`, { error: err.message });
      resolve(result);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Hook Handler (T-A11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run an HTTP hook - POSTs JSON payload to URL, parses 2xx as allow
 */
async function _runHttpHook(
  event: HookEvent,
  hook: HookDefinition,
  ctx: HookContext,
  payload: HookPayload
): Promise<HookRunResult> {
  const t0 = Date.now();
  const url = hook.url;
  
  if (!url) {
    return {
      event,
      command: "http: " + (hook.url ?? "no-url"),
      exitCode: 1,
      stdout: "",
      stderr: "HTTP hook requires 'url' field",
      durationMs: 0,
      blocked: false,
    };
  }

  // T-HK-WHITELIST: Enforce allowedHttpHookUrls from settings.json
  // If the array is present and non-empty, the hook URL must start with one of the allowed prefixes.
  try {
    const settingsPaths = [
      path.join(ctx.cwd ?? process.cwd(), ".pakalon", "settings.json"),
      path.join(
        process.env["HOME"] ?? process.env["USERPROFILE"] ?? "",
        ".config", "pakalon", "settings.json",
      ),
    ];
    for (const sp of settingsPaths) {
      if (fs.existsSync(sp)) {
        const raw = fs.readFileSync(sp, "utf-8");
        const settings = JSON.parse(raw) as Record<string, unknown>;
        const allowedUrls = settings["allowedHttpHookUrls"] as string[] | undefined;
        if (Array.isArray(allowedUrls) && allowedUrls.length > 0) {
          const isAllowed = allowedUrls.some((prefix) => url.startsWith(prefix));
          if (!isAllowed) {
            return {
              event,
              command: url,
              exitCode: 1,
              stdout: "",
              stderr: `HTTP hook URL not in allowedHttpHookUrls: ${url}`,
              durationMs: 0,
              blocked: true,
              decision: { action: "deny", reason: `HTTP hook URL "${url}" is not in the allowedHttpHookUrls whitelist.` },
            };
          }
        }
        break; // use first settings file found
      }
    }
  } catch { /* settings read errors are non-fatal; allow the request */ }

  try {
    const response = await fetch(url, {
      method: hook.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        ...hook.headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(hook.timeoutMs ?? 10000),
    });

    const durationMs = Date.now() - t0;
    const is2xx = response.status >= 200 && response.status < 300;
    const responseText = await response.text();
    
    let decision: HookDecision | undefined;
    let blocked = false;
    
    // Try to parse JSON decision from response
    if (responseText.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(responseText) as Partial<HookDecision>;
        if (parsed.action === "allow" || parsed.action === "deny" || parsed.action === "ask") {
          decision = parsed as HookDecision;
        }
      } catch {
        // Not valid JSON
      }
    }

    const isBlocking = BLOCKING_EVENTS.has(event);
    
    if (isBlocking && !is2xx) {
      // Non-2xx = blocking by default for HTTP hooks
      blocked = true;
      decision = decision ?? { 
        action: "deny", 
        reason: `HTTP hook returned ${response.status}: ${responseText.slice(0, 100)}` 
      };
    } else if (isBlocking && decision?.action === "deny") {
      blocked = true;
    }

    return {
      event,
      command: url,
      exitCode: response.status,
      stdout: responseText,
      stderr: is2xx ? "" : `HTTP ${response.status}`,
      durationMs,
      decision,
      blocked,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    return {
      event,
      command: url,
      exitCode: 1,
      stdout: "",
      stderr: errorMsg,
      durationMs,
      blocked: false, // HTTP errors are non-blocking by default
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Hook Handler (T-A12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Callback type for LLM summarization (used by prompt hooks)
 */
export type LlmCallback = (prompt: string, systemMessage?: string) => Promise<string>;

let _llmCallback: LlmCallback | null = null;

/**
 * Register the LLM callback for prompt/agent hooks
 */
export function registerLlmCallback(cb: LlmCallback): void {
  _llmCallback = cb;
}

/**
 * Run a prompt hook - single-turn LLM evaluation returning { ok, reason }
 */
async function _runPromptHook(
  event: HookEvent,
  hook: HookDefinition,
  ctx: HookContext,
  payload: HookPayload
): Promise<HookRunResult> {
  const t0 = Date.now();
  
  if (!_llmCallback) {
    return {
      event,
      command: "prompt: no-llm-callback",
      exitCode: 1,
      stdout: "",
      stderr: "No LLM callback registered for prompt hooks",
      durationMs: 0,
      blocked: false,
    };
  }

  try {
    const systemMessage = hook.systemMessage ?? "You are a hook validator. Return {\"ok\": true} to allow or {\"ok\": false, \"reason\": \"...\"} to deny.";
    const userPrompt = `Evaluate this hook event and return a JSON decision:\n\n${JSON.stringify(payload, null, 2)}`;
    
    const result = await _llmCallback(userPrompt, systemMessage);
    const durationMs = Date.now() - t0;
    
    let decision: HookDecision | undefined;
    let blocked = false;
    
    // Parse { ok: boolean, reason?: string } from result
    try {
      const parsed = JSON.parse(result);
      if (parsed.ok === true) {
        decision = { action: "allow", reason: parsed.reason };
      } else if (parsed.ok === false) {
        decision = { action: "deny", reason: parsed.reason ?? "Prompt hook denied" };
        blocked = BLOCKING_EVENTS.has(event);
      }
    } catch {
      // Not valid JSON, treat as informational
    }

    return {
      event,
      command: `prompt: ${hook.model ?? "default"}`,
      exitCode: blocked ? 2 : 0,
      stdout: result,
      stderr: "",
      durationMs,
      decision,
      blocked,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    return {
      event,
      command: "prompt: error",
      exitCode: 1,
      stdout: "",
      stderr: errorMsg,
      durationMs,
      blocked: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Hook Handler (T-A13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Callback type for subagent execution (used by agent hooks)
 */
export type SubagentCallback = (systemMessage: string, allowedTools: string[], maxTurns: number) => Promise<string>;

let _subagentCallback: SubagentCallback | null = null;

/**
 * Register the subagent callback for agent hooks
 */
export function registerSubagentCallback(cb: SubagentCallback): void {
  _subagentCallback = cb;
}

/**
 * Run an agent hook - multi-turn subagent with tool access
 */
async function _runAgentHook(
  event: HookEvent,
  hook: HookDefinition,
  ctx: HookContext,
  payload: HookPayload
): Promise<HookRunResult> {
  const t0 = Date.now();
  
  if (!_subagentCallback) {
    return {
      event,
      command: "agent: no-subagent-callback",
      exitCode: 1,
      stdout: "",
      stderr: "No subagent callback registered for agent hooks",
      durationMs: 0,
      blocked: false,
    };
  }

  try {
    const systemMessage = hook.systemMessage ?? 
      `You are a hook agent. Evaluate this event and return a JSON decision: ${JSON.stringify(payload, null, 2)}`;
    const allowedTools = hook.allowedTools ?? ["Read", "Grep", "Glob"];
    const maxTurns = hook.maxTurns ?? 50;
    
    const result = await _subagentCallback(systemMessage, allowedTools, maxTurns);
    const durationMs = Date.now() - t0;
    
    let decision: HookDecision | undefined;
    let blocked = false;
    
    // Try to parse JSON decision from result
    try {
      const parsed = JSON.parse(result);
      if (parsed.action === "allow" || parsed.action === "deny" || parsed.action === "ask") {
        decision = parsed as HookDecision;
        if (parsed.action === "deny") {
          blocked = BLOCKING_EVENTS.has(event);
        }
      }
    } catch {
      // Not valid JSON, treat as additional context
      decision = { action: "allow", additionalContext: result };
    }

    return {
      event,
      command: `agent: ${hook.model ?? "default"}`,
      exitCode: blocked ? 2 : 0,
      stdout: result,
      stderr: "",
      durationMs,
      decision,
      blocked,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    return {
      event,
      command: "agent: error",
      exitCode: 1,
      stdout: "",
      stderr: errorMsg,
      durationMs,
      blocked: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all hooks registered for `event`.
 *
 * - Filters by `match` glob against `ctx.filePath` or `ctx.toolName`.
 * - Sends a structured JSON payload on stdin (Claude Code protocol).
 * - Returns `HookRunResult[]` with stdout/stderr/duration/decision per hook.
 * - If any hook sets `blocked = true`, subsequent hooks are skipped.
 *
 * Callers should check `results.some(r => r.blocked)` to decide whether
 * to proceed with the tool action.
 */
export async function runHooks(
  event: HookEvent,
  ctx: HookContext,
  projectDir?: string
): Promise<HookRunResult[]> {
  const config = loadHooksConfig(projectDir);
  const hooks = config[event];
  if (!hooks || hooks.length === 0) return [];

  const cwd = ctx.cwd ?? projectDir ?? process.cwd();
  const payload: HookPayload = {
    event,
    tool_name: ctx.toolName,
    tool_input: ctx.toolInput,
    prompt: ctx.prompt,
    file_path: ctx.filePath,
    command: ctx.command,
    cwd,
    timestamp: new Date().toISOString(),
    session_id: ctx.sessionId,
  };

  const results: HookRunResult[] = [];

  for (const hook of hooks) {
    if (!_matchesHook(hook, event, ctx)) continue;

    // Handle async hooks (T-A14) - run in background without blocking
    if (hook.async) {
      _runAsyncHook(event, hook, { ...ctx, cwd }, payload);
      continue;
    }

    // Dispatch to appropriate hook type handler
    let result: HookRunResult;
    switch (hook.type) {
      case "http":
        result = await _runHttpHook(event, hook, { ...ctx, cwd }, payload);
        break;
      case "prompt":
        result = await _runPromptHook(event, hook, { ...ctx, cwd }, payload);
        break;
      case "agent":
        result = await _runAgentHook(event, hook, { ...ctx, cwd }, payload);
        break;
      case "command":
      default:
        result = await _runSingleHook(event, hook, { ...ctx, cwd }, payload);
        break;
    }

    results.push(result);

    // Stop running further hooks if any blocked
    if (result.blocked) break;
  }

  return results;
}

/**
 * Run async hook in background - fire and forget, results delivered on next turn
 */
async function _runAsyncHook(
  event: HookEvent,
  hook: HookDefinition,
  ctx: HookContext,
  payload: HookPayload
): Promise<void> {
  try {
    let result: HookRunResult;
    
    switch (hook.type) {
      case "http":
        result = await _runHttpHook(event, hook, ctx, payload);
        break;
      case "prompt":
        result = await _runPromptHook(event, hook, ctx, payload);
        break;
      case "agent":
        result = await _runAgentHook(event, hook, ctx, payload);
        break;
      case "command":
      default:
        result = await _runSingleHook(event, hook, ctx, payload);
        break;
    }

    // If there's additionalContext from the async hook, emit event for next turn
    if (result.decision?.additionalContext) {
      contextEvents.emit("async_hook_result", {
        event,
        additionalContext: result.decision.additionalContext,
        sessionId: ctx.sessionId,
      });
    }
  } catch (err) {
    logger.warn("[AsyncHook] Failed", { event, error: String(err) });
  }
}

// Simple event emitter for async hook results
const _asyncHookListeners: Array<(payload: { event: string; additionalContext: string; sessionId?: string }) => void> = [];

export function onAsyncHookResult(
  callback: (payload: { event: string; additionalContext: string; sessionId?: string }) => void
): () => void {
  _asyncHookListeners.push(callback);
  return () => {
    const idx = _asyncHookListeners.indexOf(callback);
    if (idx >= 0) _asyncHookListeners.splice(idx, 1);
  };
}

// Emit async hook results to listeners
function emitAsyncHookResult(payload: { event: string; additionalContext: string; sessionId?: string }): void {
  for (const cb of _asyncHookListeners) {
    try { cb(payload); } catch { /* ignore */ }
  }
}

// Replace direct emit with function call
const contextEvents = {
  emit(event: string, payload: unknown) {
    if (event === "async_hook_result") {
      emitAsyncHookResult(payload as { event: string; additionalContext: string; sessionId?: string });
    }
  },
  on(event: string, handler: (payload: unknown) => void): () => void {
    // Simple implementation
    return () => {};
  }
};

/**
 * Fire a lifecycle event hook and return whether the action should be blocked.
 * Convenience wrapper for PreToolUse / UserPromptSubmit callers.
 */
export async function fireLifecycleHook(
  event: LifecycleHookEvent,
  ctx: HookContext,
  projectDir?: string
): Promise<{ blocked: boolean; reason?: string; decision?: HookDecision }> {
  const results = await runHooks(event, ctx, projectDir);
  const blocking = results.find((r) => r.blocked);
  const firstDecision = results.find((r) => r.decision)?.decision;
  const effectiveDecision = blocking?.decision ?? firstDecision;
  return {
    blocked: !!blocking,
    reason: effectiveDecision?.reason,
    decision: effectiveDecision,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience wrappers
// ─────────────────────────────────────────────────────────────────────────────

export async function runPreWriteHooks(filePath: string, projectDir?: string): Promise<HookRunResult[]> {
  return runHooks("beforeWrite", { filePath }, projectDir);
}

export async function runPostWriteHooks(filePath: string, projectDir?: string): Promise<HookRunResult[]> {
  return runHooks("afterWrite", { filePath }, projectDir);
}

export async function runPreEditHooks(filePath: string, projectDir?: string): Promise<HookRunResult[]> {
  return runHooks("beforeEdit", { filePath }, projectDir);
}

export async function runPostEditHooks(filePath: string, projectDir?: string): Promise<HookRunResult[]> {
  return runHooks("afterEdit", { filePath }, projectDir);
}

export async function runPrePatchHooks(filePath: string, projectDir?: string): Promise<HookRunResult[]> {
  return runHooks("beforePatch", { filePath }, projectDir);
}

export async function runPostPatchHooks(filePath: string, projectDir?: string): Promise<HookRunResult[]> {
  return runHooks("afterPatch", { filePath }, projectDir);
}

export async function runPreBashHooks(command: string, projectDir?: string): Promise<HookRunResult[]> {
  return runHooks("beforeBash", { command }, projectDir);
}

export async function runPostBashHooks(command: string, projectDir?: string): Promise<HookRunResult[]> {
  return runHooks("afterBash", { command }, projectDir);
}

/**
 * Convenience: fire Stop lifecycle hook after AI turn completes.
 * Returns `{ blocked, reason }` — if blocked, the calling code should
 * continue the session (hook says "don't stop").
 */
export async function runStopHook(
  projectDir?: string,
  sessionId?: string
): Promise<{ blocked: boolean; reason?: string; decision?: HookDecision }> {
  return fireLifecycleHook(
    "Stop",
    { cwd: projectDir, sessionId },
    projectDir
  );
}

/**
 * Convenience: fire SubagentStop lifecycle hook after a subagent finishes.
 */
export async function runSubagentStopHook(
  projectDir?: string,
  sessionId?: string
): Promise<{ blocked: boolean; reason?: string; decision?: HookDecision }> {
  return fireLifecycleHook(
    "SubagentStop",
    { cwd: projectDir, sessionId },
    projectDir
  );
}

/**
 * Convenience: fire PreToolUse lifecycle hook and return blocking result.
 * `toolName` should match the registered tool name (e.g. "bash", "writeFile").
 */
export async function runPreToolUseHook(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  sessionId?: string
): Promise<{ blocked: boolean; reason?: string; decision?: HookDecision }> {
  return fireLifecycleHook(
    "PreToolUse",
    { toolName, toolInput, cwd: projectDir, sessionId },
    projectDir
  );
}

/**
 * Convenience: fire PostToolUse informational hook (never blocks).
 */
export async function runPostToolUseHook(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  sessionId?: string
): Promise<void> {
  await runHooks("PostToolUse", { toolName, toolInput, cwd: projectDir, sessionId }, projectDir);
}

/**
 * Convenience: fire UserPromptSubmit lifecycle hook.
 * Returns `{ blocked, reason }` — caller should NOT send prompt to AI if blocked.
 */
export async function runUserPromptSubmitHook(
  prompt: string,
  projectDir?: string,
  sessionId?: string
): Promise<{ blocked: boolean; reason?: string; decision?: HookDecision }> {
  return fireLifecycleHook(
    "UserPromptSubmit",
    { prompt, cwd: projectDir, sessionId },
    projectDir
  );
}

/**
 * Convenience: fire SessionStart informational hook (non-blocking).
 */
export async function runSessionStartHook(
  projectDir?: string,
  sessionId?: string
): Promise<void> {
  const results = await runHooks("SessionStart", { cwd: projectDir, sessionId }, projectDir);

  // T-HK-14: PAKALON_ENV_FILE — collect KEY=value lines from hook stdout and
  // write them to the env file so all subsequent bash calls can source it.
  const envFilePath = process.env["PAKALON_ENV_FILE"];
  if (envFilePath && results.length > 0) {
    try {
      const fs = await import("fs");
      const envLines: string[] = [];
      for (const r of results) {
        if (r.stdout) {
          // Collect lines that look like KEY=value env var declarations
          for (const line of r.stdout.split("\n")) {
            if (/^[A-Z_][A-Z0-9_]*=/.test(line.trim())) {
              envLines.push(`export ${line.trim()}`);
            }
          }
        }
      }
      if (envLines.length > 0) {
        fs.default.writeFileSync(envFilePath, envLines.join("\n") + "\n", "utf8");
      }
    } catch { /* non-fatal */ }
  }
}

/**
 * T-HK-03: Wrap a ToolSet so every tool's execute() runs PreToolUse hooks first.
 * If a hook returns `decision.updatedInput`, those params replace the original
 * tool input before execution. If a hook blocks (action="deny" / exit 2), the
 * tool returns an error object instead.
 *
 * @param tools  The original merged ToolSet (allTools + MCP tools)
 * @param projectDir  Working directory for hook config lookup
 * @param sessionId   Session ID for audit/context
 */
export function wrapToolsWithPreToolUseHook<T extends Record<string, { execute?: (...args: any[]) => any }>>(
  tools: T,
  projectDir?: string,
  sessionId?: string
): T {
  const wrapped: Record<string, unknown> = {};
  for (const [toolName, toolDef] of Object.entries(tools)) {
    const originalExecute = (toolDef as any).execute;
    if (typeof originalExecute !== "function") {
      wrapped[toolName] = toolDef;
      continue;
    }
    wrapped[toolName] = {
      ...toolDef,
      execute: async (input: Record<string, unknown>, opts?: unknown) => {
        // Run PreToolUse lifecycle hook
        const hookResult = await fireLifecycleHook(
          "PreToolUse",
          { toolName, toolInput: input, cwd: projectDir, sessionId },
          projectDir
        );
        if (hookResult.blocked) {
          return {
            error: `Tool call blocked by PreToolUse hook: ${hookResult.reason ?? "no reason given"}`,
            blocked: true,
            toolName,
          };
        }
        // T-HK-03: Apply updatedInput if hook returned one
        const effectiveInput: Record<string, unknown> =
          hookResult.decision?.updatedInput ?? input;

        // Execute with (potentially) rewritten input
        let toolOutput: unknown;
        try {
          toolOutput = await originalExecute(effectiveInput, opts);
        } catch (err: unknown) {
          // T-HK-16: PostToolUseFailure — fire hook and feed stdout back as error context
          const errMsg = err instanceof Error ? err.message : String(err);
          const failureResults = await runHooks(
            "PostToolUseFailure",
            { toolName, toolInput: effectiveInput, error: errMsg, cwd: projectDir, sessionId },
            projectDir
          );
          // Collect hook stdout to feed back to AI as error context
          const hookFeedback = failureResults
            .map((r) => r.stdout?.trim())
            .filter(Boolean)
            .join("\n");
          const errorContext = hookFeedback
            ? `[Tool error: ${errMsg}]\n[Hook feedback]: ${hookFeedback}`
            : `[Tool error: ${errMsg}]`;
          return { error: errorContext, toolName };
        }

        // Fire PostToolUse (non-blocking, best-effort)
        runHooks(
          "PostToolUse",
          { toolName, toolInput: effectiveInput, toolOutput, cwd: projectDir, sessionId },
          projectDir
        ).catch(() => { /* non-fatal */ });

        return toolOutput;
      },
    };
  }
  return wrapped as T;
}
