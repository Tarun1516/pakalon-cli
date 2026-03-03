/**
 * /cicd command — Multi-environment CI/CD management.
 */
import { debugLog } from "@/utils/logger.js";
import { useStore } from "@/store/index.js";

const BRIDGE_URL = process.env.PAKALON_BRIDGE_URL ?? "http://127.0.0.1:7432";

export interface CICDStatus {
  environment: string;
  configured: boolean;
  url: string | null;
  branch: string | null;
  current_deployment: {
    id: string;
    status: string;
    commit_sha: string;
    deployed_at: string;
    duration_seconds: number;
    error: string | null;
  } | null;
}

/**
 * Get CI/CD status for all environments or a specific environment.
 */
export async function cmdCICDStatus(
  env?: string
): Promise<Record<string, CICDStatus> | CICDStatus> {
  const { token } = useStore.getState();

  const url = env
    ? `${BRIDGE_URL}/cicd/status?env=${encodeURIComponent(env)}`
    : `${BRIDGE_URL}/cicd/status`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to get CI/CD status: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Deploy to an environment.
 */
export async function cmdCICDDeploy(
  env: string,
  commitSha: string,
  branch?: string
): Promise<{
  id: string;
  environment: string;
  status: string;
  commit_sha: string;
  url: string | null;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/cicd/deploy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      env,
      commit_sha: commitSha,
      branch,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to deploy: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Promote from one environment to another.
 */
export async function cmdCICDPromote(
  fromEnv: string,
  toEnv: string
): Promise<{
  id: string;
  from: string;
  status: string;
  commit_sha: string;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/cicd/promote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      from_env: fromEnv,
      to_env: toEnv,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to promote: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Rollback an environment.
 */
export async function cmdCICDRollback(
  env: string,
  reason: string,
  deploymentId?: string
): Promise<{
  id: string;
  environment: string;
  status: string;
  commit_sha: string;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/cicd/rollback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      env,
      reason,
      deployment_id: deploymentId,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to rollback: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Configure an environment.
 */
export async function cmdCICDConfigure(
  env: string,
  url?: string,
  branch?: string,
  autoPromote?: boolean
): Promise<{
  status: string;
  environment: string;
  url: string | null;
  branch: string | null;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/cicd/configure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      env,
      url,
      branch,
      auto_promote: autoPromote,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to configure: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Get deployment history.
 */
export async function cmdCICDHistory(
  env?: string,
  limit: number = 10
): Promise<Array<{
  id: string;
  environment: string;
  status: string;
  commit_sha: string;
  deployed_at: string;
  duration_seconds: number;
}>> {
  const { token } = useStore.getState();

  const url = new URL(`${BRIDGE_URL}/cicd/history`);
  if (env) url.searchParams.set("env", env);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to get history: HTTP ${res.status}`);
  }

  return await res.json();
}
