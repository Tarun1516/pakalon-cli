/**
 * /workflow-editor command — Custom workflow editor management.
 */
import { debugLog } from "@/utils/logger.js";
import { useStore } from "@/store/index.js";

const BRIDGE_URL = process.env.PAKALON_BRIDGE_URL ?? "http://127.0.0.1:7432";

export interface WorkflowInfo {
  name: string;
  file: string;
  updated_at: string;
}

/**
 * List all workflows.
 */
export async function cmdWorkflowList(): Promise<{
  workflows: WorkflowInfo[];
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/workflows/list`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to list workflows: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Create a new workflow.
 */
export async function cmdWorkflowCreate(
  name: string,
  description?: string
): Promise<{
  status: string;
  workflow: string;
  file: string;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/workflows/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ name, description }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to create workflow: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Validate a workflow.
 */
export async function cmdWorkflowValidate(
  filename: string
): Promise<{
  valid: boolean;
  errors: string[];
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/workflows/validate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ filename }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to validate workflow: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Dry run a workflow - preview what it will do.
 */
export async function cmdWorkflowDryRun(
  filename: string
): Promise<{
  workflow: string;
  preview: string;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/workflows/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ filename }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to dry-run workflow: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Generate a workflow from a template.
 */
export async function cmdWorkflowGenerateTemplate(
  template: "node" | "python" | "fullstack" | "deploy"
): Promise<{
  status: string;
  workflow: string;
  file: string;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/workflows/generate-template`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ template }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to generate template: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Add a job to a workflow.
 */
export async function cmdWorkflowAddJob(
  filename: string,
  jobId: string,
  jobName: string,
  runsOn: string = "ubuntu-latest"
): Promise<{
  status: string;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/workflows/add-job`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ filename, job_id: jobId, job_name: jobName, runs_on: runsOn }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to add job: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Add a step to a job in a workflow.
 */
export async function cmdWorkflowAddStep(
  filename: string,
  jobId: string,
  stepId: string,
  stepName: string,
  action: string,
  config?: Record<string, unknown>
): Promise<{
  status: string;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/workflows/add-step`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      filename,
      job_id: jobId,
      step_id: stepId,
      step_name: stepName,
      action,
      config,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to add step: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Save a workflow after editing.
 */
export async function cmdWorkflowSave(
  filename: string
): Promise<{
  status: string;
  file: string;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/workflows/save`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ filename }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to save workflow: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Delete a workflow.
 */
export async function cmdWorkflowDelete(
  filename: string
): Promise<{
  status: string;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/workflows/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ filename }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to delete workflow: HTTP ${res.status}`);
  }

  return await res.json();
}
