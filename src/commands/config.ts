/**
 * config.ts — /config command: read and write pakalon settings.
 *
 * Programmatic API (used by the TUI slash command handler and tests):
 *
 *   getSettings(projectDir?) → merged settings object (project overrides global)
 *   setSetting(key, value, scope, projectDir?) → write single key
 *   getSettingPath(scope, projectDir?) → absolute path to settings.json
 *
 * The TUI renders ConfigScreen which calls these helpers.
 */
import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettingsScope = "project" | "global";

export interface PakalonSettings {
  // General
  defaultModel?: string;
  fallbackModel?: string;
  permissionMode?: "plan" | "normal" | "auto-accept" | "orchestration" | "edit" | "bypass";
  verbose?: boolean;
  disableSlashCommands?: boolean;
  maxBudgetUsd?: number;
  autoCompact?: boolean;

  // Models
  thinkingEnabled?: boolean;
  promptCaching?: boolean;
  contextWindowFraction?: number;  // 0.8 = use 80% of ctx window

  // Privacy
  privacyMode?: boolean;
  telemetryEnabled?: boolean;
  shareUsageStats?: boolean;

  // Memory / PAKALON.md
  memory?: {
    autoSave?: boolean;
    autoSaveScope?: "project" | "personal";
    autoSaveInterval?: number; // minutes
  };

  // Hooks
  allowedHttpHookUrls?: string[];
  disableAllHooks?: boolean;

  // Git
  git?: {
    attribution?: boolean;       // Co-Authored-By trailer (default true)
    autoPush?: boolean;
    defaultBranch?: string;
  };

  // Status line
  statusLine?: {
    command?: string;
    intervalMs?: number;
  };

  // Agent pipeline
  agents?: {
    useWorktrees?: boolean;
    maxParallel?: number;
    defaultProvider?: string;
  };

  // MCP
  mcp?: {
    autoConnect?: boolean;
    servers?: string[];
  };

  // [key: string]: unknown — allow arbitrary extra keys
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getSettingPath(scope: SettingsScope, projectDir?: string): string {
  if (scope === "global") {
    const homeDir =
      process.env["HOME"] ?? process.env["USERPROFILE"] ?? process.cwd();
    return path.join(homeDir, ".config", "pakalon", "settings.json");
  }
  return path.join(projectDir ?? process.cwd(), ".pakalon", "settings.json");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function _readSettings(filePath: string): PakalonSettings {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as PakalonSettings;
  } catch {
    return {};
  }
}

/**
 * Return merged settings: global is the base, project overrides it.
 */
export function getSettings(projectDir?: string): PakalonSettings {
  const globalPath = getSettingPath("global");
  const projectPath = getSettingPath("project", projectDir);
  const global = _readSettings(globalPath);
  const project = _readSettings(projectPath);
  return { ...global, ...project };
}

export function getProjectSettings(projectDir?: string): PakalonSettings {
  return _readSettings(getSettingPath("project", projectDir));
}

export function getGlobalSettings(): PakalonSettings {
  return _readSettings(getSettingPath("global"));
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a single top-level key to settings.json in the given scope.
 * Deep-merges objects (one level), primitive values are overwritten.
 */
export function setSetting(
  key: string,
  value: unknown,
  scope: SettingsScope = "project",
  projectDir?: string,
): void {
  const filePath = getSettingPath(scope, projectDir);
  const existing = _readSettings(filePath);

  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof existing[key] === "object" &&
    existing[key] !== null &&
    !Array.isArray(existing[key])
  ) {
    // Shallow merge objects
    existing[key] = { ...(existing[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
  } else {
    existing[key] = value;
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
  logger.debug("[Config] wrote setting", { key, scope, filePath });
}

/**
 * Delete a key from settings.json.
 */
export function deleteSetting(
  key: string,
  scope: SettingsScope = "project",
  projectDir?: string,
): void {
  const filePath = getSettingPath(scope, projectDir);
  const existing = _readSettings(filePath);
  delete existing[key];
  if (Object.keys(existing).length === 0) return; // leave absent
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
}

/**
 * Dump the current settings as a formatted string for display.
 */
export function formatSettings(projectDir?: string): string {
  const merged = getSettings(projectDir);
  const globalPath = getSettingPath("global");
  const projectPath = getSettingPath("project", projectDir);
  const global = _readSettings(globalPath);
  const project = _readSettings(projectPath);

  const lines: string[] = [
    `**Global** (\`${globalPath}\`)`,
    Object.keys(global).length === 0
      ? "  _(no settings)_"
      : Object.entries(global)
          .map(([k, v]) => `  **${k}**: ${JSON.stringify(v)}`)
          .join("\n"),
    "",
    `**Project** (\`${projectPath}\`)`,
    Object.keys(project).length === 0
      ? "  _(no settings)_"
      : Object.entries(project)
          .map(([k, v]) => `  **${k}**: ${JSON.stringify(v)}`)
          .join("\n"),
    "",
    `**Merged (effective)**`,
    Object.keys(merged).length === 0
      ? "  _(no settings)_"
      : Object.entries(merged)
          .map(([k, v]) => `  **${k}**: ${JSON.stringify(v)}`)
          .join("\n"),
  ];
  return lines.join("\n");
}
