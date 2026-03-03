/**
 * Skills System — Claude Code / AgentSkills.io Standard
 * ─────────────────────────────────────────────────────
 * 
 * Implements the Claude Code Skills standard:
 * - YAML frontmatter parsing (name, description, disable-model-invocation, etc.)
 * - /skill-name slash invocation
 * - context: fork subagent execution
 * - Dynamic context injection (!command)
 * - Scope resolution (enterprise > personal > project)
 * 
 * Skills are stored in:
 * - .pakalon/skills/<name>/SKILL.md (project scope)
 * - ~/.config/pakalon/skills/<name>/SKILL.md (personal scope)
 * - /etc/pakalon/skills/<name>/SKILL.md (enterprise scope)
 * 
 * Example SKILL.md:
 * ```yaml
 * ---
 * name: deploy
 * description: Deploy the current project to production
 * disable-model-invocation: true
 * user-invocable: true
 * context: fork
 * allowed-tools:
 *   - bash
 *   - readFile
 * model: claude-sonnet-4-20250514
 * hooks:
 *   - PreToolUse:
 *       - command: ./hooks/pre-deploy.sh
 * ---
 * 
 * # Deploy Skill
 * 
 * This skill deploys the current project to production.
 * 
 * ## Usage
 * 
 * /deploy production
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  /** Skill name (used for /skill-name invocation) */
  name: string;
  /** Human-readable description for auto-discovery */
  description: string;
  /** If true, Claude will NOT auto-invoke this skill */
  disableModelInvocation?: boolean;
  /** If false, hides from / menu but allows Claude auto-loading */
  userInvocable?: boolean;
  /** Run in isolated subagent context */
  context?: "fork" | "continue";
  /** Allowed tools for this skill */
  allowedTools?: string[];
  /** Model to use for this skill */
  model?: string;
  /** Hooks to run during skill execution */
  hooks?: Record<string, unknown[]>;
}

export interface Skill {
  /** Parsed frontmatter */
  frontmatter: SkillFrontmatter;
  /** Full skill content (markdown) */
  content: string;
  /** Absolute path to skill directory */
  dirPath: string;
  /** Scope: project | personal | enterprise */
  scope: "project" | "personal" | "enterprise";
  /** Supporting files in skill directory */
  supportingFiles?: string[];
}

export interface SkillInvocation {
  skill: Skill;
  args: string;
  userInvoked: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all skills in a given directory
 */
function discoverSkillsInDir(dir: string, scope: "project" | "personal" | "enterprise"): Skill[] {
  const skills: Skill[] = [];
  
  if (!fs.existsSync(dir)) return skills;
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const skillPath = path.join(dir, entry.name);
      const skillFile = path.join(skillPath, "SKILL.md");
      
      if (fs.existsSync(skillFile)) {
        const skill = parseSkillFile(skillFile, scope);
        if (skill) {
          skills.push(skill);
        }
      }
    }
  } catch (err) {
    logger.warn("[Skills] Failed to discover skills", { dir, error: String(err) });
  }
  
  return skills;
}

/**
 * Parse a SKILL.md file and extract frontmatter
 */
function parseSkillFile(skillFile: string, scope: "project" | "personal" | "enterprise"): Skill | null {
  try {
    const content = fs.readFileSync(skillFile, "utf-8");
    const dirPath = path.dirname(skillFile);
    
    // Parse YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    
    if (!frontmatterMatch) {
      logger.warn("[Skills] Missing frontmatter", { skillFile });
      return null;
    }
    
    const frontmatterYaml = frontmatterMatch[1];
    const frontmatter = parseYamlFrontmatter(frontmatterYaml);
    
    if (!frontmatter.name) {
      logger.warn("[Skills] Missing name in frontmatter", { skillFile });
      return null;
    }
    
    // Extract markdown content (everything after frontmatter)
    const markdownContent = content.slice(frontmatterMatch[0].length).trim();
    
    // Discover supporting files
    const supportingFiles = discoverSupportingFiles(dirPath);
    
    return {
      frontmatter,
      content: markdownContent,
      dirPath,
      scope,
      supportingFiles,
    };
  } catch (err) {
    logger.warn("[Skills] Failed to parse skill file", { skillFile, error: String(err) });
    return null;
  }
}

/**
 * Simple YAML frontmatter parser (handles basic key: value pairs)
 */
function parseYamlFrontmatter(yaml: string): SkillFrontmatter {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    
    // Parse value based on type
    if (value === "true") {
      result[key] = true;
    } else if (value === "false") {
      result[key] = false;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      // Array
      const arrContent = value.slice(1, -1);
      result[key] = arrContent.split(",").map(s => s.trim()).filter(Boolean);
    } else if (value) {
      result[key] = value;
    }
  }
  
  return result as SkillFrontmatter;
}

/**
 * Discover supporting files in skill directory
 */
function discoverSupportingFiles(dirPath: string): string[] {
  const supporting: string[] = [];
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isFile() && entry.name !== "SKILL.md") {
        supporting.push(path.join(dirPath, entry.name));
      }
    }
  } catch {
    // Ignore errors
  }
  
  return supporting;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Resolution
// ─────────────────────────────────────────────────────────────────────────────

let _cachedSkills: Skill[] | null = null;

/**
 * Get all available skills with proper scope resolution (enterprise > personal > project)
 */
export function getAllSkills(projectDir?: string): Skill[] {
  if (_cachedSkills) return _cachedSkills;
  
  const projectSkillsPath = projectDir 
    ? path.join(projectDir, ".pakalon", "skills")
    : path.join(process.cwd(), ".pakalon", "skills");
    
  const personalSkillsPath = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".config", "pakalon", "skills"
  );
  
  const enterpriseSkillsPath = "/etc/pakalon/skills";
  
  // Discover skills in each scope
  const projectSkills = discoverSkillsInDir(projectSkillsPath, "project");
  const personalSkills = discoverSkillsInDir(personalSkillsPath, "personal");
  const enterpriseSkills = discoverSkillsInDir(enterpriseSkillsPath, "enterprise");
  
  // Combine with scope priority (later scopes override earlier)
  const skillsMap = new Map<string, Skill>();
  
  for (const skill of [...projectSkills, ...personalSkills, ...enterpriseSkills]) {
    // Later scopes override
    const existing = skillsMap.get(skill.frontmatter.name);
    if (!existing || getScopePriority(skill.scope) > getScopePriority(existing.scope)) {
      skillsMap.set(skill.frontmatter.name, skill);
    }
  }
  
  _cachedSkills = Array.from(skillsMap.values());
  return _cachedSkills;
}

function getScopePriority(scope: "project" | "personal" | "enterprise"): number {
  switch (scope) {
    case "enterprise": return 3;
    case "personal": return 2;
    case "project": return 1;
  }
}

/**
 * Invalidate skill cache (call after modifying skills)
 */
export function reloadSkills(): void {
  _cachedSkills = null;
}

/**
 * Find a skill by name
 */
export function findSkill(name: string, projectDir?: string): Skill | undefined {
  const skills = getAllSkills(projectDir);
  return skills.find(s => s.frontmatter.name === name);
}

/**
 * Find skills that match a description (for auto-invocation)
 */
export function findSkillsByDescription(
  description: string,
  projectDir?: string
): Skill[] {
  const skills = getAllSkills(projectDir);
  const lowerDesc = description.toLowerCase();
  
  return skills.filter(skill => {
    if (skill.frontmatter.disableModelInvocation) return false;
    if (!skill.frontmatter.userInvocable && skill.frontmatter.userInvocable !== undefined) return false;
    return skill.frontmatter.description.toLowerCase().includes(lowerDesc);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Execution
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillExecutionContext {
  args: string;
  cwd: string;
  userInvoked: boolean;
}

/**
 * Execute a skill
 */
export async function executeSkill(
  skill: Skill,
  context: SkillExecutionContext,
  executor: SkillExecutor
): Promise<SkillExecutionResult> {
  logger.info("[Skills] Executing skill", { name: skill.frontmatter.name, args: context.args });
  
  // Handle context: fork
  if (skill.frontmatter.context === "fork") {
    return await _executeSkillInFork(skill, context, executor);
  }
  
  // Execute in current context
  return await _executeSkillInContext(skill, context, executor);
}

/**
 * Callback for skill execution (implemented by caller)
 */
export interface SkillExecutor {
  /**
   * Execute skill content with the LLM
   */
  executeWithLLM(
    systemPrompt: string,
    userMessage: string,
    options?: {
      model?: string;
      allowedTools?: string[];
    }
  ): Promise<string>;
  
  /**
   * Execute supporting files (templates, scripts, etc.)
   */
  loadSupportingFile(filePath: string): Promise<string>;
}

export interface SkillExecutionResult {
  output: string;
  success: boolean;
  error?: string;
}

/**
 * Execute skill in forked subagent context
 */
async function _executeSkillInFork(
  skill: Skill,
  context: SkillExecutionContext,
  executor: SkillExecutor
): Promise<SkillExecutionResult> {
  try {
    const systemPrompt = buildSkillSystemPrompt(skill);
    const userMessage = `${skill.content}\n\n---\n\nUser request: ${context.args}`;
    
    const output = await executor.executeWithLLM(
      systemPrompt,
      userMessage,
      {
        model: skill.frontmatter.model,
        allowedTools: skill.frontmatter.allowedTools,
      }
    );
    
    return { output, success: true };
  } catch (err) {
    return { 
      output: "", 
      success: false, 
      error: err instanceof Error ? err.message : String(err) 
    };
  }
}

/**
 * Execute skill in current context
 */
async function _executeSkillInContext(
  skill: Skill,
  context: SkillExecutionContext,
  executor: SkillExecutor
): Promise<SkillExecutionResult> {
  try {
    const systemPrompt = buildSkillSystemPrompt(skill);
    const userMessage = `${skill.content}\n\n---\n\nUser request: ${context.args}`;
    
    const output = await executor.executeWithLLM(systemPrompt, userMessage);
    
    return { output, success: true };
  } catch (err) {
    return { 
      output: "", 
      success: false, 
      error: err instanceof Error ? err.message : String(err) 
    };
  }
}

/**
 * Build system prompt from skill content
 */
function buildSkillSystemPrompt(skill: Skill): string {
  const parts: string[] = [];
  
  parts.push(`# Skill: ${skill.frontmatter.name}`);
  parts.push(skill.frontmatter.description);
  parts.push("");
  parts.push(skill.content);
  
  if (skill.frontmatter.allowedTools) {
    parts.push("");
    parts.push(`## Allowed Tools`);
    parts.push(skill.frontmatter.allowedTools.join(", "));
  }
  
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Context Injection (!command)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process skill content and replace !command placeholders with command output
 */
export async function processDynamicContext(content: string, cwd: string): Promise<string> {
  const commandPattern = /`!([^`]+)`/g;
  let result = content;
  let match;
  
  while ((match = commandPattern.exec(content)) !== null) {
    const command = match[1];
    try {
      const output = execSync(command, {
        cwd,
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 1024 * 1024, // 1MB max
      });
      
      result = result.replace(match[0], output.trim());
    } catch (err) {
      logger.warn("[Skills] Dynamic command failed", { command, error: String(err) });
      result = result.replace(match[0], `[Command failed: ${command}]`);
    }
  }
  
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Installation (from agentskills.io / vercel-labs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Install a skill from a remote repository
 */
export async function installRemoteSkill(
  repoUrl: string,
  scope: "project" | "personal" = "personal"
): Promise<{ success: boolean; error?: string }> {
  const skillsDir = scope === "personal"
    ? path.join(process.env.HOME || process.env.USERPROFILE || "", ".config", "pakalon", "skills")
    : path.join(process.cwd(), ".pakalon", "skills");
  
  try {
    // Clone the skill repository
    const skillName = path.basename(repoUrl, ".git");
    const targetDir = path.join(skillsDir, skillName);
    
    if (fs.existsSync(targetDir)) {
      return { success: false, error: `Skill already exists: ${skillName}` };
    }
    
    fs.mkdirSync(skillsDir, { recursive: true });
    execSync(`git clone --depth 1 "${repoUrl}" "${targetDir}"`, {
      stdio: "pipe",
    });
    
    reloadSkills();
    return { success: true };
  } catch (err) {
    return { 
      success: false, 
      error: err instanceof Error ? err.message : String(err) 
    };
  }
}

/**
 * Update all installed skills from their remote sources
 */
export async function updateRemoteSkills(): Promise<{ updated: string[]; errors: string[] }> {
  const skills = getAllSkills();
  const updated: string[] = [];
  const errors: string[] = [];
  
  for (const skill of skills) {
    const gitDir = path.join(skill.dirPath, ".git");
    
    if (fs.existsSync(gitDir)) {
      try {
        execSync("git pull", { cwd: skill.dirPath, stdio: "pipe" });
        updated.push(skill.frontmatter.name);
      } catch {
        errors.push(skill.frontmatter.name);
      }
    }
  }
  
  reloadSkills();
  return { updated, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills CLI Command Support
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a skill invocation from user input
 */
export function parseSkillInvocation(input: string, projectDir?: string): SkillInvocation | null {
  // Match /skill-name args
  const match = input.match(/^\/(\S+)\s*(.*)$/);
  
  if (!match) return null;
  
  const skillName = match[1];
  const args = match[2] || "";
  
  const skill = findSkill(skillName, projectDir);
  
  if (!skill) return null;
  
  return {
    skill,
    args,
    userInvoked: true,
  };
}

/**
 * Get skills list formatted for display
 */
export function formatSkillsList(skills: Skill[]): string {
  const lines: string[] = ["Available Skills:", ""];
  
  for (const skill of skills) {
    const invocable = skill.frontmatter.userInvocable !== false ? "[user]" : "";
    const auto = !skill.frontmatter.disableModelInvocation ? "[auto]" : "";
    lines.push(`  /${skill.frontmatter.name} ${invocable} ${auto}`);
    lines.push(`    ${skill.frontmatter.description}`);
    lines.push("");
  }
  
  return lines.join("\n");
}
