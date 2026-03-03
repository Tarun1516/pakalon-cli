/**
 * /workflows command — save and replay prompt sequences.
 * T-CLI-P13: Full CRUD + run + schedule + step types.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { debugLog } from "@/utils/logger.js";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/db.js";
import { workflows as workflowsTable } from "@/db/schema.js";

export type StepType = "prompt" | "shell" | "mcp" | "tool";

export interface WorkflowStep {
  /** How to categorise this step. */
  type: StepType;
  /** For "prompt" steps — the text sent to the AI. */
  content?: string;
  /** For "shell" steps — the command to run. */
  command?: string;
  /** For "mcp" / "tool" steps — tool name. */
  tool?: string;
  /** Optional display label. */
  label?: string;
}

export interface WorkflowSchedule {
  /** cron expression, e.g. "0 9 * * 1-5" */
  cron: string;
  /** Human-readable description */
  description?: string;
  /** Enabled flag */
  enabled: boolean;
  /** ISO timestamp of last run */
  lastRun?: string;
  /** ISO timestamp of next scheduled run (informational) */
  nextRun?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  /** Ordered list of steps to execute */
  steps: WorkflowStep[];
  /** Legacy: simple prompt list (kept for backwards compat) */
  prompts: string[];
  /** Optional cron schedule */
  schedule?: WorkflowSchedule;
  /** Additional tags for filtering */
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  lastUsedAt?: string;
}

/** Migrate a legacy workflow (prompts[]) to steps[]. */
function migrateWorkflow(wf: Workflow): Workflow {
  if (!wf.steps?.length && wf.prompts?.length) {
    return {
      ...wf,
      steps: wf.prompts.map((p) => ({ type: "prompt" as StepType, content: p, label: p.slice(0, 60) })),
    };
  }
  return wf;
}

function workflowsPath(): string {
  return path.join(os.homedir(), ".config", "pakalon", "workflows.json");
}

function readWorkflows(): Workflow[] {
  try {
    const raw = fs.readFileSync(workflowsPath(), "utf-8");
    const list = JSON.parse(raw) as Workflow[];
    return list.map(migrateWorkflow);
  } catch {
    return [];
  }
}

function writeWorkflows(workflows: Workflow[]): void {
  const filePath = workflowsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(workflows, null, 2), "utf-8");
}

/**
 * Upsert a single workflow to the local SQLite database.
 * Runs fire-and-forget so a SQLite failure never blocks the CLI.
 */
function syncWorkflowToDb(wf: Workflow): void {
  try {
    const db = getDb();
    db.insert(workflowsTable)
      .values({
        id: wf.id,
        name: wf.name,
        description: wf.description ?? "",
        steps: JSON.stringify(wf.steps ?? []),
        createdAt: wf.createdAt,
        updatedAt: wf.updatedAt ?? new Date().toISOString(),
        lastUsedAt: wf.lastUsedAt ?? null,
        schedule: wf.schedule ? JSON.stringify(wf.schedule) : "",
        tags: JSON.stringify(wf.tags ?? []),
        prompts: JSON.stringify(wf.prompts ?? []),
      })
      .onConflictDoUpdate({
        target: workflowsTable.id,
        set: {
          name: wf.name,
          description: wf.description ?? "",
          steps: JSON.stringify(wf.steps ?? []),
          updatedAt: wf.updatedAt ?? new Date().toISOString(),
          lastUsedAt: wf.lastUsedAt ?? null,
          schedule: wf.schedule ? JSON.stringify(wf.schedule) : "",
          tags: JSON.stringify(wf.tags ?? []),
          prompts: JSON.stringify(wf.prompts ?? []),
        },
      })
      .run();
    debugLog(`[workflows] SQLite upsert: ${wf.name}`);
  } catch (err: any) {
    debugLog(`[workflows] SQLite sync failed (non-fatal): ${err?.message}`);
  }
}

/** Returns all workflows for use in TUI */
export function getWorkflowsList(): Workflow[] {
  return readWorkflows();
}

export function cmdListWorkflows(): void {
  const workflows = readWorkflows();

  if (workflows.length === 0) {
    console.log("\nNo workflows saved.");
    console.log("Save a workflow with: /workflows save <name>\n");
    return;
  }

  console.log(`\n── Saved Workflows (${workflows.length}) ─────────────────────\n`);
  for (const wf of workflows) {
    const lastUsed = wf.lastUsedAt
      ? new Date(wf.lastUsedAt).toLocaleDateString()
      : "Never";
    console.log(`  ${wf.name.padEnd(30)} ${wf.prompts.length} steps  Last used: ${lastUsed}`);
    if (wf.description) {
      console.log(`    ${wf.description}`);
    }
    console.log();
  }
}

export function cmdSaveWorkflow(name: string, description: string, prompts: string[]): void {
  const workflows = readWorkflows();
  const existing = workflows.findIndex((w) => w.name.toLowerCase() === name.toLowerCase());

  const steps: WorkflowStep[] = prompts.map((p) => ({
    type: "prompt" as StepType,
    content: p,
    label: p.slice(0, 60),
  }));

  const workflow: Workflow = {
    id: existing >= 0 ? workflows[existing]!.id : `wf_${Date.now()}`,
    name,
    description,
    prompts,
    steps,
    createdAt: existing >= 0 ? workflows[existing]!.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    workflows[existing] = workflow;
    console.log(`✓ Workflow "${name}" updated (${steps.length} steps).`);
  } else {
    workflows.push(workflow);
    console.log(`✓ Workflow "${name}" saved (${steps.length} steps).`);
  }

  writeWorkflows(workflows);
  syncWorkflowToDb(workflow);
  debugLog(`[workflows] Saved workflow: ${name}`);
}

/** Create or update a workflow from an explicit step list. */
export function cmdCreateWorkflow(
  name: string,
  description: string,
  steps: WorkflowStep[],
  tags?: string[],
): Workflow {
  const workflows = readWorkflows();
  const existing = workflows.findIndex((w) => w.name.toLowerCase() === name.toLowerCase());

  const workflow: Workflow = {
    id: existing >= 0 ? workflows[existing]!.id : `wf_${Date.now()}`,
    name,
    description,
    steps,
    prompts: steps.filter((s) => s.type === "prompt").map((s) => s.content ?? ""),
    tags,
    createdAt: existing >= 0 ? workflows[existing]!.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    workflows[existing] = workflow;
  } else {
    workflows.push(workflow);
  }

  writeWorkflows(workflows);
  syncWorkflowToDb(workflow);
  debugLog(`[workflows] Created workflow: ${name}`);
  return workflow;
}

/** Set or clear a cron schedule on a workflow. */
export function cmdScheduleWorkflow(
  name: string,
  cron: string | null,
  scheduleDescription?: string,
): boolean {
  const workflows = readWorkflows();
  const idx = workflows.findIndex((w) => w.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return false;

  if (cron === null) {
    delete workflows[idx]!.schedule;
    console.log(`✓ Schedule removed from workflow "${name}".`);
  } else {
    workflows[idx]!.schedule = {
      cron,
      description: scheduleDescription,
      enabled: true,
    };
    console.log(`✓ Workflow "${name}" scheduled: ${cron}`);
  }

  writeWorkflows(workflows);
  return true;
}

/** Show detailed info about a single workflow. */
export function cmdShowWorkflow(name: string): void {
  const wf = getWorkflow(name);
  if (!wf) {
    console.error(`Workflow "${name}" not found.`);
    return;
  }

  console.log(`\n── Workflow: ${wf.name} ${"─".repeat(Math.max(0, 40 - wf.name.length))}\n`);
  console.log(`  ID:          ${wf.id}`);
  console.log(`  Description: ${wf.description || "(none)"}`);
  console.log(`  Tags:        ${(wf.tags ?? []).join(", ") || "(none)"}`);
  console.log(`  Created:     ${new Date(wf.createdAt).toLocaleString()}`);
  if (wf.updatedAt) console.log(`  Updated:     ${new Date(wf.updatedAt).toLocaleString()}`);
  if (wf.lastUsedAt) console.log(`  Last ran:    ${new Date(wf.lastUsedAt).toLocaleString()}`);
  if (wf.schedule) {
    console.log(`  Schedule:    ${wf.schedule.cron}${wf.schedule.enabled ? "" : " (disabled)"}  ${wf.schedule.description ?? ""}`);
    if (wf.schedule.lastRun) console.log(`  Last cron:   ${new Date(wf.schedule.lastRun).toLocaleString()}`);
  }
  console.log(`\n  Steps (${wf.steps.length}):`);
  wf.steps.forEach((step, i) => {
    const label = step.label || step.content?.slice(0, 70) || step.command || step.tool || "";
    console.log(`    ${String(i + 1).padStart(2)}. [${step.type.padEnd(6)}] ${label}`);
  });
  console.log();
}

export function getWorkflow(name: string): Workflow | null {
  const workflows = readWorkflows();
  return workflows.find((w) => w.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export function cmdDeleteWorkflow(name: string): void {
  const workflows = readWorkflows();
  const idx = workflows.findIndex((w) => w.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) {
    console.error(`Workflow "${name}" not found.`);
    return;
  }
  workflows.splice(idx, 1);
  writeWorkflows(workflows);
  console.log(`✓ Workflow "${name}" deleted.`);
}

export function markWorkflowUsed(name: string): void {
  const workflows = readWorkflows();
  const idx = workflows.findIndex((w) => w.name.toLowerCase() === name.toLowerCase());
  if (idx >= 0) {
    workflows[idx]!.lastUsedAt = new Date().toISOString();
    writeWorkflows(workflows);
    syncWorkflowToDb(workflows[idx]!);
  }
}

/**
 * Execute a workflow by returning its prompt steps as a string array.
 * Callers (ChatScreen) iterate these and submit them to the AI pipeline.
 * Shell steps are executed inline via child_process.
 */
export async function cmdRunWorkflow(
  name: string,
  onStep?: (step: WorkflowStep, index: number, total: number) => Promise<string | void>,
): Promise<{ ok: boolean; error?: string; results: string[] }> {
  const wf = getWorkflow(name);
  if (!wf) return { ok: false, error: `Workflow "${name}" not found.`, results: [] };

  markWorkflowUsed(name);
  const results: string[] = [];

  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i]!;
    try {
      if (step.type === "shell" && step.command) {
        // Execute shell step directly
        const { execSync } = await import("child_process");
        const out = execSync(step.command, { encoding: "utf-8", timeout: 30_000 });
        results.push(out.trim());
      } else {
        // Delegate to caller (AI prompt / tool call)
        const result = onStep ? await onStep(step, i, wf.steps.length) : undefined;
        if (typeof result === "string") results.push(result);
      }
    } catch (err: any) {
      results.push(`[error] Step ${i + 1}: ${err.message}`);
    }
  }

  return { ok: true, results };
}

/** Return workflows matching a tag. */
export function getWorkflowsByTag(tag: string): Workflow[] {
  return readWorkflows().filter((wf) => wf.tags?.includes(tag));
}

/** Return workflows that have a schedule enabled. */
export function getScheduledWorkflows(): Workflow[] {
  return readWorkflows().filter((wf) => wf.schedule?.enabled);
}

/** Update schedule lastRun timestamp. */
export function markScheduleRun(name: string): void {
  const workflows = readWorkflows();
  const idx = workflows.findIndex((w) => w.name.toLowerCase() === name.toLowerCase());
  if (idx >= 0 && workflows[idx]!.schedule) {
    workflows[idx]!.schedule!.lastRun = new Date().toISOString();
    writeWorkflows(workflows);
  }
}
