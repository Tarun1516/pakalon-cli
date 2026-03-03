/**
 * Permissions System — Per-tool allow/deny rules
 * ─────────────────────────────────────────────────
 * 
 * T-A43: /permissions interactive TUI menu
 * 
 * Allows users to configure per-tool permission rules like:
 * - Bash(npm *) - allow npm commands
 * - WriteFile(*.test.ts) - allow test files
 * - Skill(deploy *) - allow deploy skills
 * 
 * Rules are stored in .pakalon/settings.json
 */

import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

// Lazily fire ConfigChange hook without blocking permission writes
function _fireConfigChangeHook(configPath: string): void {
  import("@/ai/hooks.js").then(({ runHooks }) => {
    runHooks("ConfigChange", { filePath: configPath }, path.dirname(configPath)).catch(() => {});
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type PermissionAction = "allow" | "deny";

export interface PermissionRule {
  /** Tool name or pattern (e.g., "bash", "WriteFile", "Skill(deploy *)") */
  tool: string;
  /** Glob pattern for the tool's input (e.g., "*.ts", "npm *") */
  pattern?: string;
  /** Allow or deny */
  action: PermissionAction;
  /** Optional description */
  description?: string;
  /** Scope: user (global) or project */
  scope: "user" | "project";
}

export interface PermissionConfig {
  rules: PermissionRule[];
  /** Default action when no rule matches */
  defaultAction: PermissionAction;
}

// ─────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────

function getPermissionConfigPath(scope: "user" | "project", projectDir?: string): string {
  if (scope === "project") {
    return path.join(projectDir ?? process.cwd(), ".pakalon", "settings.json");
  }
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".config", "pakalon", "settings.json");
}

function _loadPermissionConfig(scope: "user" | "project", projectDir?: string): PermissionConfig {
  const configPath = getPermissionConfigPath(scope, projectDir);
  
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        rules: parsed.permissionRules ?? [],
        defaultAction: parsed.defaultPermissionAction ?? "ask",
      };
    }
  } catch (err) {
    logger.warn("[Permissions] Failed to load config", { scope, error: String(err) });
  }
  
  return { rules: [], defaultAction: "ask" };
}

function _savePermissionConfig(config: PermissionConfig, scope: "user" | "project", projectDir?: string): void {
  const configPath = getPermissionConfigPath(scope, projectDir);
  
  // Load existing settings
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Ignore
  }
  
  // Merge and save
  existing.permissionRules = config.rules;
  existing.defaultPermissionAction = config.defaultAction;
  
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf-8");
  // T-HK-10: fire ConfigChange hook so hooks can react to settings changes
  _fireConfigChangeHook(configPath);
}

// ─────────────────────────────────────────────────────────────────────────
// Permission Checking
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check if a tool action is allowed based on permission rules
 */
export function checkPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string
): { allowed: boolean; reason?: string } {
  // Load both user and project rules (project overrides user)
  const userConfig = _loadPermissionConfig("user");
  const projectConfig = _loadPermissionConfig("project", projectDir);
  
  // Combine rules (project rules take precedence)
  const allRules = [...userConfig.rules, ...projectConfig.rules];
  
  // Find matching rule
  for (const rule of allRules) {
    if (matchesToolRule(rule, toolName, toolInput)) {
      return {
        allowed: rule.action === "allow",
        reason: rule.description ?? `Matched rule: ${rule.tool}${rule.pattern ? `(${rule.pattern})` : ""}`,
      };
    }
  }
  
  // No matching rule - use default
  const defaultAction = projectConfig.defaultAction || userConfig.defaultAction || "ask";
  return {
    allowed: defaultAction === "allow",
    reason: defaultAction === "ask" ? "No matching rule - confirmation required" : undefined,
  };
}

/**
 * Check if a tool matches a permission rule
 */
function matchesToolRule(rule: PermissionRule, toolName: string, toolInput: Record<string, unknown>): boolean {
  // Check tool name match
  const toolBase = rule.tool.replace(/\(.*$/, ""); // Remove pattern part
  if (toolBase !== toolName && toolBase !== "*") {
    return false;
  }
  
  // Check input pattern if specified
  if (rule.pattern) {
    const inputStr = JSON.stringify(toolInput);
    const regex = globToRegex(rule.pattern);
    if (!regex.test(inputStr)) {
      return false;
    }
  }
  
  return true;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(escaped, "i");
}

// ─────────────────────────────────────────────────────────────────────────
// Permission Management Commands
// ─────────────────────────────────────────────────────────────────────────

/**
 * Add a permission rule
 */
export function addPermissionRule(
  rule: PermissionRule,
  projectDir?: string
): { success: boolean; error?: string } {
  const scope = rule.scope || "project";
  const config = _loadPermissionConfig(scope, projectDir);
  
  // Check for duplicate
  const exists = config.rules.some(
    r => r.tool === rule.tool && r.pattern === rule.pattern && r.scope === scope
  );
  
  if (exists) {
    return { success: false, error: "Rule already exists. Use /permissions remove first." };
  }
  
  config.rules.push(rule);
  _savePermissionConfig(config, scope, projectDir);
  
  return { success: true };
}

/**
 * Remove a permission rule
 */
export function removePermissionRule(
  tool: string,
  pattern: string | undefined,
  scope: "user" | "project",
  projectDir?: string
): { success: boolean; error?: string } {
  const config = _loadPermissionConfig(scope, projectDir);
  
  const beforeCount = config.rules.length;
  config.rules = config.rules.filter(
    r => !(r.tool === tool && r.pattern === pattern && r.scope === scope)
  );
  
  if (config.rules.length === beforeCount) {
    return { success: false, error: "Rule not found" };
  }
  
  _savePermissionConfig(config, scope, projectDir);
  return { success: true };
}

/**
 * List all permission rules
 */
export function listPermissionRules(projectDir?: string): {
  user: PermissionRule[];
  project: PermissionRule[];
} {
  return {
    user: _loadPermissionConfig("user").rules,
    project: _loadPermissionConfig("project", projectDir).rules,
  };
}

/**
 * Set default permission action
 */
export function setDefaultPermissionAction(
  action: PermissionAction,
  scope: "user" | "project",
  projectDir?: string
): void {
  const config = _loadPermissionConfig(scope, projectDir);
  config.defaultAction = action;
  _savePermissionConfig(config, scope, projectDir);
}

// ─────────────────────────────────────────────────────────────────────────
// Interactive Menu (for TUI)
// ─────────────────────────────────────────────────────────────────────────

export interface PermissionMenuOption {
  id: string;
  label: string;
  description: string;
  action: () => void;
}

/**
 * Get permission menu options for TUI rendering
 */
export function getPermissionMenuOptions(projectDir?: string): PermissionMenuOption[] {
  const { user, project } = listPermissionRules(projectDir);
  
  const options: PermissionMenuOption[] = [
    {
      id: "list",
      label: "List Rules",
      description: `View all permission rules (${user.length + project.length} rules)`,
      action: () => {},
    },
    {
      id: "add-project",
      label: "Add Project Rule",
      description: "Add a rule scoped to current project",
      action: () => {},
    },
    {
      id: "add-user",
      label: "Add User Rule",
      description: "Add a rule scoped to all projects",
      action: () => {},
    },
    {
      id: "remove",
      label: "Remove Rule",
      description: "Remove an existing rule",
      action: () => {},
    },
    {
      id: "default-allow",
      label: "Default: Allow",
      description: "Allow tools by default when no rule matches",
      action: () => setDefaultPermissionAction("allow", "project", projectDir),
    },
    {
      id: "default-deny",
      label: "Default: Deny",
      description: "Deny tools by default when no rule matches",
      action: () => setDefaultPermissionAction("deny", "project", projectDir),
    },
    {
      id: "default-ask",
      label: "Default: Ask",
      description: "Ask for confirmation when no rule matches",
      action: () => setDefaultPermissionAction("ask", "project", projectDir),
    },
  ];
  
  return options;
}

/**
 * Format permission rules as markdown for display
 */
export function formatPermissionRulesForDisplay(projectDir?: string): string {
  const { user, project } = listPermissionRules(projectDir);
  
  const lines: string[] = [];
  lines.push("# Permission Rules");
  lines.push("");
  
  if (project.length > 0) {
    lines.push("## Project Rules");
    lines.push("");
    for (const rule of project) {
      const pattern = rule.pattern ? `(${rule.pattern})` : "";
      lines.push(`- **${rule.action.toUpperCase()}** ${rule.tool}${pattern}`);
      if (rule.description) {
        lines.push(`  ${rule.description}`);
      }
    }
    lines.push("");
  }
  
  if (user.length > 0) {
    lines.push("## User Rules (Global)");
    lines.push("");
    for (const rule of user) {
      const pattern = rule.pattern ? `(${rule.pattern})` : "";
      lines.push(`- **${rule.action.toUpperCase()}** ${rule.tool}${pattern}`);
      if (rule.description) {
        lines.push(`  ${rule.description}`);
      }
    }
    lines.push("");
  }
  
  if (project.length === 0 && user.length === 0) {
    lines.push("_No permission rules configured._");
    lines.push("");
    lines.push("Use `/permissions add` to create rules like:");
    lines.push("- `Bash(npm *)` - allow npm commands");
    lines.push("- `WriteFile(*.test.ts)` - allow test files");
    lines.push("- `Skill(deploy *)` - allow deploy skills");
  }
  
  return lines.join("\n");
}

/**
 * Parse permission rule from user input
 */
export function parsePermissionRule(input: string): PermissionRule | null {
  // Format: allow/deny tool(pattern) - description
  const match = input.match(/^(allow|deny)\s+(\S+)(?:\s*-\s*(.+))?$/i);
  
  if (!match) return null;
  
  const action = match[1].toLowerCase() as PermissionAction;
  const toolPart = match[2];
  const description = match[3];
  
  // Parse tool and pattern
  const toolMatch = toolPart.match(/^([^(]+)(?:\((.+)\))?$/);
  if (!toolMatch) return null;
  
  const tool = toolMatch[1].trim();
  const pattern = toolMatch[2]?.trim();
  
  return {
    tool,
    pattern,
    action,
    description,
    scope: "project", // Default to project scope
  };
}
