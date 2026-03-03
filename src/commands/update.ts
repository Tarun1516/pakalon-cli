/**
 * /update command — targeted update via agentic mode (T-CLI-10).
 *
 * U: Update guardrails:
 * 1. Creates a named checkpoint (snapshot) before the update begins
 * 2. Generates a structured update plan (what files change, why, risk level)
 * 3. Validates scope after update (warns if > 10 files changed)
 * 4. Runs post-verify steps (type check / lint / tests — if configured)
 * 5. On failure: auto-rollback to pre-update snapshot
 */
import * as path from "path";
import { useStore } from "@/store/index.js";
import { undoManager } from "@/ai/undo-manager.js";
import { debugLog } from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

export type UpdateRisk = "low" | "medium" | "high";

export interface UpdatePlan {
  instruction: string;
  estimatedFiles: string[];
  riskLevel: UpdateRisk;
  riskReasons: string[];
  checkpointId: string;
  createdAt: string;
}

/** Infer rough risk level from the instruction text */
function inferRisk(instruction: string): { level: UpdateRisk; reasons: string[] } {
  const reasons: string[] = [];
  const low = instruction.toLowerCase();

  if (/delete|remove|drop|destroy/i.test(low)) {
    reasons.push("Instruction involves deletion");
  }
  if (/database|migration|schema|alembic/i.test(low)) {
    reasons.push("Touches database schema or migrations");
  }
  if (/auth|authentication|password|token|secret|permission/i.test(low)) {
    reasons.push("Touches authentication or security-sensitive code");
  }
  if (/deploy|ci|cd|pipeline|infrastructure/i.test(low)) {
    reasons.push("Touches deployment or CI/CD configuration");
  }
  if (/config|env|environment|\.env/i.test(low)) {
    reasons.push("Modifies configuration or environment variables");
  }
  if (/refactor|rewrite|restructure/i.test(low)) {
    reasons.push("Broad refactor — risk of unintended changes");
  }

  const level: UpdateRisk =
    reasons.length >= 3 ? "high"
    : reasons.length >= 1 ? "medium"
    : "low";

  return { level, reasons };
}

// ---------------------------------------------------------------------------
// Update plan generation
// ---------------------------------------------------------------------------

/**
 * Generate a structured update plan and create a checkpoint.
 * The plan is stored in-memory; the checkpoint allows rollback.
 */
export function createUpdatePlan(instruction: string): UpdatePlan {
  const { level, reasons } = inferRisk(instruction);
  const checkpointId = undoManager.createNamedCheckpoint(`before /update: ${instruction.slice(0, 80)}`);
  debugLog(`[update] Checkpoint created: ${checkpointId} (risk=${level})`);

  return {
    instruction,
    estimatedFiles: [],     // populated after update by validateUpdateScope
    riskLevel: level,
    riskReasons: reasons,
    checkpointId,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scope validation
// ---------------------------------------------------------------------------

/**
 * Check if a set of changed files looks targeted.
 * Returns warning message if suspiciously broad.
 */
export function validateUpdateScope(
  instruction: string,
  changedFiles: string[]
): { ok: boolean; warning?: string } {
  if (changedFiles.length === 0) {
    return { ok: true };
  }

  // Warn if more than 10 files changed (likely too broad)
  if (changedFiles.length > 10) {
    return {
      ok: false,
      warning: `⚠ Update affected ${changedFiles.length} files. This seems broad for: "${instruction}"\n\nContinue anyway? The changes will be listed below.`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Post-verify steps
// ---------------------------------------------------------------------------

export interface PostVerifyResult {
  passed: boolean;
  steps: { name: string; passed: boolean; output: string }[];
}

/**
 * Run post-update verification (type check, lint, tests).
 * Failures are collected but do NOT throw — caller decides whether to rollback.
 */
export async function runPostVerify(projectDir: string = process.cwd()): Promise<PostVerifyResult> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { existsSync } = await import("fs");
  const execFileAsync = promisify(execFile);

  const steps: PostVerifyResult["steps"] = [];

  const runStep = async (name: string, cmd: string, args: string[]): Promise<void> => {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: projectDir,
        timeout: 30_000,
        env: process.env,
      });
      steps.push({ name, passed: true, output: (stdout + stderr).slice(0, 500) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ name, passed: false, output: msg.slice(0, 500) });
    }
  };

  // TypeScript type check (if tsconfig.json exists)
  const tsconfigPath = path.join(projectDir, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    await runStep("TypeScript type check", "npx", ["tsc", "--noEmit", "--skipLibCheck"]);
  }

  // ESLint (if eslint config exists)
  const eslintConfigs = [".eslintrc", ".eslintrc.json", ".eslintrc.js", "eslint.config.js"];
  if (eslintConfigs.some((f) => existsSync(path.join(projectDir, f)))) {
    await runStep("ESLint", "npx", ["eslint", "src", "--max-warnings", "0"]);
  }

  // Tests (if vitest/jest config exists)
  const vitestConfig = path.join(projectDir, "vitest.config.ts");
  const jestConfig = path.join(projectDir, "jest.config.js");
  if (existsSync(vitestConfig)) {
    await runStep("Vitest unit tests", "npx", ["vitest", "run", "--reporter=verbose"]);
  } else if (existsSync(jestConfig)) {
    await runStep("Jest unit tests", "npx", ["jest", "--passWithNoTests"]);
  }

  const passed = steps.every((s) => s.passed);
  return { passed, steps };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Roll back all changes made since a named checkpoint.
 * Returns the list of files reverted.
 */
export function rollbackUpdate(checkpointId: string): string[] {
  const reverted = undoManager.rollbackToCheckpoint(checkpointId);
  debugLog(`[update] Rolled back ${reverted.length} changes to checkpoint ${checkpointId}`);
  return reverted.map((s) => s.path);
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a targeted update prompt for the agentic mode.
 */
export function getUpdatePrompt(instruction: string, plan?: UpdatePlan): string {
  const riskNote = plan
    ? `\n**Risk Level**: ${plan.riskLevel.toUpperCase()}${plan.riskReasons.length ? ` — ${plan.riskReasons.join("; ")}` : ""}`
    : "";

  return `Make a targeted, surgical update to implement the following instruction:

**Instruction**: ${instruction}${riskNote}

**CRITICAL CONSTRAINTS**:
1. Modify ONLY files that are directly relevant to this instruction
2. Do NOT change code that is unrelated to this instruction
3. Do NOT refactor or "clean up" other code
4. Do NOT add features that weren't asked for
5. Before modifying any file, verify it's necessary for this instruction
6. Keep changes minimal — prefer the simplest correct solution

If you realize a change to an unrelated file is needed, STOP and ask for confirmation first.

${plan?.riskLevel === "high" ? "⚠ HIGH RISK UPDATE — be especially careful about side effects and data integrity.\n" : ""}
Proceed with the targeted update now:`;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Wire /update command to agentic mode.
 * Creates a checkpoint, builds a structured plan, and returns the update prompt.
 * Use rollbackUpdate(plan.checkpointId) on failure to revert all changes.
 */
export function cmdUpdate(instruction: string): { prompt: string; plan: UpdatePlan } {
  debugLog(`[update] Switching to agent mode for update: ${instruction}`);

  // Create checkpoint BEFORE any changes
  const plan = createUpdatePlan(instruction);

  // Switch to agent mode
  useStore.getState().setMode("agent");

  const prompt = getUpdatePrompt(instruction, plan);
  return { prompt, plan };
}
