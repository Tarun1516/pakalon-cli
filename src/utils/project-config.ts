/**
 * Project-level configuration loader.
 *
 * Pakalon reads `.pakalon/config.json` (or `pakalon.config.json`) from the
 * project root and merges it into the runtime configuration.
 *
 * Priority (highest → lowest):
 *   1. CLI flags / env vars
 *   2. .pakalon/config.json  (project-level)
 *   3. ~/.config/pakalon/config.json  (global user-level)
 *   4. Built-in defaults
 *
 * Example .pakalon/config.json:
 * ```json
 * {
 *   "model": "anthropic/claude-3-5-sonnet",
 *   "fallbackModel": "openai/gpt-4o-mini",
 *   "permissionMode": "auto-accept",
 *   "allowedTools": ["readFile", "writeFile", "bash"],
 *   "disallowedTools": ["deleteFile"],
 *   "mcpServers": [
 *     { "name": "context7", "url": "npx @upstash/context7-mcp" }
 *   ],
 *   "privacy": true,
 *   "maxBudgetUsd": 5.0,
 *   "buildPhases": [1, 2, 3],
 *   "agentDefaults": {
 *     "thinkingEnabled": false,
 *     "autoCompact": true
 *   },
 *   "env": {
 *     "OPENAI_API_KEY": "${OPENAI_API_KEY}"
 *   }
 * }
 * ```
 */
import fs from "fs";
import path from "path";
import os from "os";
import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface McpServerOverride {
  name: string;
  /** URL (SSE) or command (stdio) for the MCP server */
  url: string;
  transport?: "sse" | "stdio";
  enabled?: boolean;
}

export interface AgentDefaults {
  thinkingEnabled?: boolean;
  autoCompact?: boolean;
  privacyMode?: boolean;
}

export interface ProjectConfig {
  /** Default AI model override */
  model?: string;
  /** Fallback model when default fails */
  fallbackModel?: string;
  /** Comma-separated or array of allowed tool names */
  allowedTools?: string | string[];
  /** Comma-separated or array of disallowed tool names */
  disallowedTools?: string | string[];
  /** Permission mode override */
  permissionMode?: "plan" | "normal" | "auto-accept" | "orchestration" | "edit" | "bypass";
  /** Additional MCP servers to register on startup */
  mcpServers?: McpServerOverride[];
  /** Enable privacy mode */
  privacy?: boolean;
  /** Max spend budget in USD */
  maxBudgetUsd?: number;
  /** Which build phases to run (1-6, default all) */
  buildPhases?: number[];
  /** Agent defaults */
  agentDefaults?: AgentDefaults;
  /** Custom system prompt (appended after default) */
  appendSystemPrompt?: string;
  /** Environment variable overrides (resolved at load time) */
  env?: Record<string, string>;
  /** Custom output directory for generated files */
  outputDir?: string;
  /** Figma PAT for Phase 1 import */
  figmaPat?: string;
  /** DAST target URL for Phase 4 (default: auto-discovered) */
  dastTargetUrl?: string;
}

// ---------------------------------------------------------------------------
// File locations
// ---------------------------------------------------------------------------

/** Candidate config file names in order of preference. */
const CONFIG_FILE_NAMES = [
  ".pakalon/config.json",
  ".pakalon/config.jsonc",
  "pakalon.config.json",
];

function globalConfigPath(): string {
  return path.join(os.homedir(), ".config", "pakalon", "config.json");
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a JSON or JSONC (JSON with comments) string.
 * Strips `//` line comments and `/* block comments *\/` before parsing.
 */
function parseLoose(raw: string): unknown {
  // Strip single-line comments (// ...) not inside strings
  const stripped = raw
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(stripped);
}

// ---------------------------------------------------------------------------
// Resolver helpers
// ---------------------------------------------------------------------------

/** Expand ${ENV_VAR} placeholders in a string value. */
function expandEnvVar(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name) => process.env[name] ?? "");
}

/** Resolve env overrides: sets them in process.env (project-scoped). */
function applyEnvOverrides(env: Record<string, string> | undefined): void {
  if (!env) return;
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === "string") {
      const resolved = expandEnvVar(val);
      if (resolved) process.env[key] = resolved;
    }
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * Load config from a specific file path.
 * Returns null if the file doesn't exist or is invalid JSON.
 */
function loadConfigFile(filePath: string): ProjectConfig | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = parseLoose(raw) as ProjectConfig;
    logger.debug(`[project-config] Loaded: ${filePath}`);
    return parsed;
  } catch (err) {
    logger.warn(`[project-config] Failed to parse ${filePath}: ${String(err)}`);
    return null;
  }
}

/**
 * Find and load the project-level config file.
 * Searches CONFIG_FILE_NAMES in projectDir.
 * Returns null if not found.
 */
export function loadProjectConfig(projectDir: string): ProjectConfig | null {
  for (const name of CONFIG_FILE_NAMES) {
    const full = path.join(projectDir, name);
    const cfg = loadConfigFile(full);
    if (cfg) return cfg;
  }
  return null;
}

/**
 * Load the global user-level config file.
 * Returns null if not found.
 */
export function loadGlobalConfig(): ProjectConfig | null {
  return loadConfigFile(globalConfigPath());
}

/**
 * Merge configs: project overrides global, then CLI flags override project.
 * Shallow merge at top level; arrays from project config override globals.
 */
export function mergeConfigs(...configs: (ProjectConfig | null)[]): ProjectConfig {
  const merged: ProjectConfig = {};
  for (const cfg of configs) {
    if (!cfg) continue;
    Object.assign(merged, cfg);
    // Arrays: replace, not concat
    if (cfg.allowedTools !== undefined) merged.allowedTools = cfg.allowedTools;
    if (cfg.disallowedTools !== undefined) merged.disallowedTools = cfg.disallowedTools;
    if (cfg.mcpServers !== undefined) merged.mcpServers = cfg.mcpServers;
    if (cfg.buildPhases !== undefined) merged.buildPhases = cfg.buildPhases;
    if (cfg.env !== undefined) merged.env = { ...(merged.env ?? {}), ...cfg.env };
    if (cfg.agentDefaults !== undefined) {
      merged.agentDefaults = { ...(merged.agentDefaults ?? {}), ...cfg.agentDefaults };
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Main entry-point: resolveProjectConfig
// ---------------------------------------------------------------------------

/**
 * Load and resolve the project configuration for a given project directory.
 *
 * 1. Loads global ~/.config/pakalon/config.json
 * 2. Loads .pakalon/config.json in projectDir
 * 3. Merges them (project wins)
 * 4. Applies env overrides to process.env
 * 5. Returns the merged config
 *
 * This is called once at CLI startup.
 */
export function resolveProjectConfig(projectDir: string): ProjectConfig {
  const globalCfg = loadGlobalConfig();
  const projectCfg = loadProjectConfig(projectDir);
  const merged = mergeConfigs(globalCfg, projectCfg);

  // Apply env overrides immediately so downstream code sees them
  applyEnvOverrides(merged.env);

  return merged;
}

// ---------------------------------------------------------------------------
// Scaffold helper: write a starter config
// ---------------------------------------------------------------------------

const STARTER_CONFIG = `{
  // Pakalon project configuration
  // See https://pakalon.com/docs/config for full reference

  // "model": "anthropic/claude-3-5-sonnet",
  // "fallbackModel": "openai/gpt-4o-mini",
  // "permissionMode": "auto-accept",   // plan | normal | auto-accept | orchestration

  // Restrict which tools the AI may use:
  // "allowedTools": ["readFile", "writeFile", "bash", "search"],
  // "disallowedTools": ["deleteFile"],

  // Additional MCP servers (project-scoped):
  // "mcpServers": [
  //   { "name": "context7", "url": "npx @upstash/context7-mcp", "transport": "stdio" }
  // ],

  // Privacy mode — prevents model providers from retaining data:
  // "privacy": true,

  // Maximum spend budget in USD per session:
  // "maxBudgetUsd": 2.0,

  // Figma PAT for Phase 1 wireframe import:
  // "figmaPat": "figd_...",

  // Phase 4 DAST target (auto-detected if not set):
  // "dastTargetUrl": "http://localhost:3000"
}
`;

/**
 * Write a starter .pakalon/config.json to projectDir if none exists.
 * Returns the path written, or null if already exists.
 */
export function scaffoldProjectConfig(projectDir: string): string | null {
  const configPath = path.join(projectDir, ".pakalon", "config.json");
  if (fs.existsSync(configPath)) return null;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, STARTER_CONFIG, "utf-8");
  return configPath;
}
