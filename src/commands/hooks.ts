/**
 * Hooks Interactive Menu Command
 * ─────────────────────────────────────────────────
 * 
 * T-A15: /hooks interactive TUI menu
 * 
 * Allows users to view/add/delete hooks without editing JSON.
 * Displays hooks with labels: [User] / [Project] / [Local] per scope.
 */

import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

// Re-export types from hooks.ts
import type { HookEvent, HookDefinition, HooksConfig } from "@/ai/hooks.js";

export type { HookEvent, HookDefinition, HooksConfig };

/**
 * Load hooks config with scope information
 */
export interface HookWithScope {
  event: HookEvent;
  hook: HookDefinition;
  scope: "user" | "project" | "local";
}

function getHooksConfigPath(scope: "user" | "project" | "local", projectDir?: string): string {
  switch (scope) {
    case "user":
      return path.join(process.env.HOME || process.env.USERPROFILE || "", ".config", "pakalon", "hooks.json");
    case "project":
      return path.join(projectDir || process.cwd(), ".pakalon", "hooks.json");
    case "local":
      return path.join(process.cwd(), ".pakalon", "hooks.local.json");
  }
}

function loadHooksForScope(scope: "user" | "project" | "local", projectDir?: string): HookWithScope[] {
  const configPath = getHooksConfigPath(scope, projectDir);
  const hooks: HookWithScope[] = [];
  
  if (!fs.existsSync(configPath)) {
    return hooks;
  }
  
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as HooksConfig;
    
    for (const [event, definitions] of Object.entries(config)) {
      if (!definitions) continue;
      
      for (const hook of definitions) {
        hooks.push({
          event: event as HookEvent,
          hook,
          scope,
        });
      }
    }
  } catch (err) {
    logger.warn("[Hooks] Failed to load hooks config", { scope, error: String(err) });
  }
  
  return hooks;
}

/**
 * Get all hooks across all scopes
 */
export function getAllHooks(projectDir?: string): HookWithScope[] {
  return [
    ...loadHooksForScope("user", projectDir),
    ...loadHooksForScope("project", projectDir),
    ...loadHooksForScope("local", projectDir),
  ];
}

/**
 * Add a hook to the specified scope
 */
export function addHook(
  event: HookEvent,
  hook: HookDefinition,
  scope: "user" | "project" | "local" = "project",
  projectDir?: string
): { success: boolean; error?: string } {
  const configPath = getHooksConfigPath(scope, projectDir);
  
  // Ensure directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // Load existing config
  let config: HooksConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      config = JSON.parse(raw);
    } catch {
      // Start fresh if parse fails
    }
  }
  
  // Add hook to event
  if (!config[event]) {
    config[event] = [];
  }
  
  config[event]!.push(hook);
  
  // Save
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Remove a hook from the specified scope
 */
export function removeHook(
  event: HookEvent,
  index: number,
  scope: "user" | "project" | "local" = "project",
  projectDir?: string
): { success: boolean; error?: string } {
  const configPath = getHooksConfigPath(scope, projectDir);
  
  if (!fs.existsSync(configPath)) {
    return { success: false, error: "No hooks configuration found" };
  }
  
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as HooksConfig;
    
    if (!config[event] || !config[event]![index]) {
      return { success: false, error: "Hook not found at specified index" };
    }
    
    config[event]!.splice(index, 1);
    
    // Remove empty event arrays
    if (config[event]!.length === 0) {
      delete config[event];
    }
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Get available hook events for display
 */
export function getAvailableHookEvents(): HookEvent[] {
  return [
    // Lifecycle events
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "PostToolUseFailure",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "TeammateIdle",
    "TaskCompleted",
    "ConfigChange",
    "WorktreeCreate",
    "WorktreeRemove",
    "PreCompact",
    // Legacy file events
    "beforeWrite",
    "afterWrite",
    "beforeEdit",
    "afterEdit",
    "beforePatch",
    "afterPatch",
    "beforeBash",
    "afterBash",
    "beforeDelete",
    "afterDelete",
  ];
}

/**
 * Format hooks for display in TUI
 */
export function formatHooksForDisplay(projectDir?: string): string {
  const hooks = getAllHooks(projectDir);
  const events = getAvailableHookEvents();
  
  const lines: string[] = [];
  lines.push("# Hooks Configuration");
  lines.push("");
  
  // Group by event
  for (const event of events) {
    const eventHooks = hooks.filter(h => h.event === event);
    
    if (eventHooks.length > 0) {
      lines.push(`## ${event}`);
      lines.push("");
      
      for (let i = 0; i < eventHooks.length; i++) {
        const h = eventHooks[i];
        const scopeLabel = h.scope === "user" ? "[User]" : 
                          h.scope === "project" ? "[Project]" : "[Local]";
        
        lines.push(`${i}. ${scopeLabel}`);
        
        if (h.hook.type) {
          lines.push(`   Type: ${h.hook.type}`);
        }
        if (h.hook.command) {
          lines.push(`   Command: ${h.hook.command}`);
        }
        if (h.hook.url) {
          lines.push(`   URL: ${h.hook.url}`);
        }
        if (h.hook.match) {
          lines.push(`   Match: ${h.hook.match}`);
        }
        if (h.hook.async) {
          lines.push(`   Async: true`);
        }
        if (h.hook.blockOnFail) {
          lines.push(`   Block on Fail: true`);
        }
        lines.push("");
      }
    }
  }
  
  if (hooks.length === 0) {
    lines.push("_No hooks configured._");
    lines.push("");
    lines.push("Use `/hooks add` to create a new hook:");
    lines.push("- `/hooks add PreToolUse bash \"node hooks/shell-guard.js\"`");
    lines.push("- `/hooks add SessionStart --type http --url http://localhost:9000/hook`");
  }
  
  return lines.join("\n");
}

/**
 * Parse hook arguments from user input
 */
export function parseHookArgs(input: string): {
  event?: HookEvent;
  command?: string;
  type?: "command" | "http" | "prompt" | "agent";
  url?: string;
  match?: string;
  async?: boolean;
  blockOnFail?: boolean;
} | null {
  // Simple parser for: add <event> [options] <command|url>
  const parts = input.trim().split(/\s+/);
  
  if (parts.length < 2) {
    return null;
  }
  
  const event = parts[1] as HookEvent;
  const availableEvents = getAvailableHookEvents();
  
  if (!availableEvents.includes(event)) {
    return null;
  }
  
  const result: ReturnType<typeof parseHookArgs> = { event };
  
  // Parse options
  let i = 2;
  while (i < parts.length) {
    const part = parts[i];
    
    if (part === "--type" && i + 1 < parts.length) {
      result.type = parts[++i] as "command" | "http" | "prompt" | "agent";
    } else if (part === "--url" && i + 1 < parts.length) {
      result.url = parts[++i];
    } else if (part === "--match" && i + 1 < parts.length) {
      result.match = parts[++i];
    } else if (part === "--async") {
      result.async = true;
    } else if (part === "--block-on-fail") {
      result.blockOnFail = true;
    } else if (!part.startsWith("--")) {
      // This is the command
      result.command = parts.slice(i).join(" ");
      break;
    }
    
    i++;
  }
  
  return result;
}

/**
 * Get help text for /hooks command
 */
export function getHooksHelp(): string {
  return `
/hooks — Manage hooks interactively

Usage:
  /hooks                  — List all configured hooks
  /hooks add <event> [options] <command|url>  — Add a new hook
  /hooks remove <event> <index>              — Remove a hook
  /hooks help             — Show this help

Events:
  SessionStart, SessionEnd, UserPromptSubmit,
  PreToolUse, PostToolUse, PermissionRequest,
  PostToolUseFailure, Notification,
  SubagentStart, SubagentStop, Stop,
  TeammateIdle, TaskCompleted,
  ConfigChange, WorktreeCreate, WorktreeRemove, PreCompact,
  beforeWrite, afterWrite, beforeEdit, afterEdit,
  beforeBash, afterBash, beforeDelete, afterDelete

Options:
  --type <command|http|prompt|agent>  Hook type (default: command)
  --url <url>                URL for http type hooks
  --match <pattern>          Glob pattern to match tool/file
  --async                   Run hook asynchronously (non-blocking)
  --block-on-fail           Treat non-zero exit as deny

Examples:
  /hooks add PreToolUse --match "bash" node hooks/shell-guard.js
  /hooks add SessionStart --type http --url http://localhost:9000/hook
  /hooks add PreToolUse --async --match "*.py" python test_runner.py
  /hooks remove PreToolUse 0
`;
}
