/**
 * /penpot command — Live Penpot sync management.
 */
import path from "path";
import fs from "fs";
import { execFile, spawn } from "child_process";
import { fileURLToPath } from "url";
import { debugLog } from "@/utils/logger.js";
import { resolvePenpotProjectState } from "@/utils/penpot-state.js";
import { useStore } from "@/store/index.js";

const BRIDGE_URL = process.env.PAKALON_BRIDGE_URL ?? "http://127.0.0.1:7432";

export interface PenpotSyncStatus {
  connected: boolean;
  message: string;
  sync_status: {
    status: string;
    last_sync: string | null;
    direction: string;
    conflicts_count: number;
    local_version: string;
    remote_version: string;
    error: string | null;
  };
  files?: Array<{
    name: string;
    path: string;
    size: number;
    modified: string;
  }>;
}

/**
 * Test connection to Penpot and get sync status.
 */
export async function cmdPenpotStatus(): Promise<PenpotSyncStatus> {
  const { token } = useStore.getState();

  try {
    const res = await fetch(`${BRIDGE_URL}/penpot/status`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      return await res.json() as PenpotSyncStatus;
    }

    return {
      connected: false,
      message: `HTTP ${res.status}`,
      sync_status: {
        status: "error",
        last_sync: null,
        direction: "bidirectional",
        conflicts_count: 0,
        local_version: "",
        remote_version: "",
        error: `HTTP ${res.status}`,
      },
    };
  } catch (err) {
    debugLog(`[penpot] Status failed: ${err}`);
    return {
      connected: false,
      message: `Connection failed: ${err}`,
      sync_status: {
        status: "disconnected",
        last_sync: null,
        direction: "bidirectional",
        conflicts_count: 0,
        local_version: "",
        remote_version: "",
        error: String(err),
      },
    };
  }
}

/**
 * Start Penpot sync.
 */
export async function cmdPenpotSyncStart(
  direction: "import" | "export" | "bidirectional" = "bidirectional"
): Promise<{ status: string; direction: string }> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/penpot/sync/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ direction }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to start sync: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Stop Penpot sync.
 */
export async function cmdPenpotSyncStop(): Promise<{ status: string }> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/penpot/sync/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to stop sync: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Import designs from Penpot.
 */
export async function cmdPenpotImport(): Promise<{
  status: string;
  files: Array<{ name: string; path: string; size: number; modified: string }>;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/penpot/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to import: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Export designs to Penpot.
 */
export async function cmdPenpotExport(): Promise<{
  status: string;
  files: Array<{ name: string; path: string; size: number; modified: string }>;
}> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/penpot/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to export: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Configure Penpot connection.
 */
export async function cmdPenpotConfigure(options: {
  apiUrl?: string;
  apiToken?: string;
  projectId?: string;
}): Promise<{ status: string; message: string }> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/penpot/configure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(options),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to configure: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Open Penpot in browser - opens the design for the current project session.
 *
 * Resolution order for fileId / URL:
 *  1. Caller supplies explicit fileId
 *  2. Read the canonical project state from .pakalon/penpot.json
 *  3. Fall back to legacy phase-2 manifests for backward compatibility
 *  3. Fall back to Penpot workspace root (http://localhost:3449)
 *
 * Also launches sync.js in --lifecycle mode so the sync bridge tracks the
 * Penpot container's state automatically for this project session.
 */
export async function cmdPenpotOpen(
  fileId?: string,
  projectDir?: string,
): Promise<{ status: string; url: string }> {
  const dir = projectDir ?? process.cwd();
  const resolvedState = resolvePenpotProjectState(dir);
  const penpotHost = (resolvedState?.baseUrl ?? process.env.PENPOT_HOST ?? process.env.PENPOT_BASE_URL ?? "http://localhost:3449").replace(/\/$/, "");
  const agentsDir = path.join(dir, ".pakalon-agents");
  const agentsInitialized = fs.existsSync(agentsDir);

  // 1. Try to resolve file ID from project metadata
  const resolvedFileId = fileId ?? resolvedState?.fileId ?? undefined;
  if (resolvedFileId) {
    debugLog(`[penpot] Resolved file ID from project state: ${resolvedFileId}`);
  }

  if (!agentsInitialized) {
    throw new Error("Penpot design is not ready yet. Initialize Pakalon and complete Phase 2 before opening Penpot.");
  }

  // 2. Build URL
  let url: string | null = null;
  if (fileId && resolvedState?.projectId) {
    url = `${penpotHost}/view/${resolvedState.projectId}/${fileId}`;
  } else if (resolvedFileId && resolvedState?.projectUrl) {
    url = resolvedState.projectUrl;
  } else if (resolvedFileId && resolvedState?.fileUrl) {
    url = resolvedState.fileUrl;
  } else if (resolvedFileId) {
    url = `${penpotHost}/view/${resolvedFileId}`;
  }

  if (!url) {
    throw new Error("No Penpot design metadata was found for this project yet. Finish Phase 2 or Phase 3 first so Pakalon can open the generated design directly.");
  }

  // 3. Open browser
  if (process.platform === "win32") {
    execFile("cmd", ["/c", "start", "", url]);
  } else if (process.platform === "darwin") {
    execFile("open", [url]);
  } else {
    execFile("xdg-open", [url]);
  }

  // 4. Launch sync.js in lifecycle mode (detached background process)
  //    This makes sync.js the owner of the Penpot container lifecycle.
  const syncStub = path.join(dir, ".pakalon-agents", "ai-agents", "sync.js");
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const cliSync  = path.join(
    currentDir,
    "..", "..", "python", "agents", "sync.js",
  );
  const syncScript = fs.existsSync(syncStub) ? syncStub : cliSync;

  if (fs.existsSync(syncScript)) {
    const syncArgs = ["--lifecycle", "--output", path.join(dir, ".pakalon-agents")];
    if (resolvedFileId) syncArgs.push("--file", resolvedFileId);

    const child = spawn(process.execPath, [syncScript, ...syncArgs], {
      detached: true,
      stdio: "ignore",
      cwd: dir,
      env: {
        ...process.env,
        PAKALON_AGENTS_DIR: path.join(dir, ".pakalon-agents"),
        PENPOT_HOST: penpotHost,
      },
    });
    child.unref(); // allow the parent process to exit independently
    debugLog(`[penpot] Launched sync.js lifecycle process (pid ${child.pid})`);
  } else {
    debugLog("[penpot] sync.js not found — skipping auto-launch");
  }

  return { status: "success", url };
}

/**
 * Start Penpot Docker container
 */
export async function cmdPenpotStart(): Promise<{ status: string; message: string }> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/penpot/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to start Penpot: HTTP ${res.status}`);
  }

  return await res.json();
}

/**
 * Stop Penpot Docker container
 */
export async function cmdPenpotStop(): Promise<{ status: string; message: string }> {
  const { token } = useStore.getState();

  const res = await fetch(`${BRIDGE_URL}/penpot/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to stop Penpot: HTTP ${res.status}`);
  }

  return await res.json();
}
