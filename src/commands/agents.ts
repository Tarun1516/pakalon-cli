/**
 * /agents command — create, list, and invoke specialist sub-agents.
 * Supports parallel execution of multiple named agents using Promise.all.
 * Agent definitions are persisted both locally (~/.config/pakalon/agents.json)
 * and in Mem0 (via the bridge server) for cross-machine / cross-session recall.
 */
import fs from "fs";
import path from "path";
import { debugLog } from "@/utils/logger.js";
import { useStore } from "@/store/index.js";

const BRIDGE_URL = process.env.PAKALON_BRIDGE_URL ?? "http://127.0.0.1:7432";
const MEM0_MEMORY_KEY = "pakalon_agent_definitions";

export interface AgentTeam {
  id: string;
  name: string;
  systemPrompt: string;
  description: string;
  color: string;
  allowedTools: string[];
  /** Epic C-01: optional parent agent ID for hierarchical teams */
  parentId?: string;
  createdAt: string;
}

const COLORS = ["blue", "green", "yellow", "magenta", "cyan", "red", "white"];

const DEFAULT_TOOLS = ["read_file", "write_file", "list_dir", "bash"];

function agentsConfigPath(): string {
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".config", "pakalon", "agents.json");
}

function readAgents(): AgentTeam[] {
  try {
    const raw = fs.readFileSync(agentsConfigPath(), "utf-8");
    return JSON.parse(raw) as AgentTeam[];
  } catch {
    return [];
  }
}

function writeAgents(agents: AgentTeam[]): void {
  const filePath = agentsConfigPath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(agents, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Mem0 helpers — fire-and-forget; local JSON is the source of truth for reads
// ---------------------------------------------------------------------------

/** Push agent list to Mem0 via the bridge (non-blocking). */
function syncToMem0(agents: AgentTeam[]): void {
  const { token, userId } = useStore.getState();
  if (!token) return; // not authenticated — skip
  fetch(`${BRIDGE_URL}/memory/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId ?? "anonymous",
      key: MEM0_MEMORY_KEY,
      value: JSON.stringify(agents),
    }),
  }).catch((err) => {
    debugLog("[agents] Mem0 sync failed (non-fatal):", err);
  });
}

/**
 * Try to hydrate agents from Mem0.
 * Falls back to local JSON if the bridge is unavailable or returns nothing.
 * Merges Mem0 agents on top of local ones, preferring Mem0 for same IDs.
 */
async function hydrateFromMem0(): Promise<AgentTeam[]> {
  const { token, userId } = useStore.getState();
  if (!token) return readAgents();
  try {
    const res = await fetch(`${BRIDGE_URL}/memory/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId ?? "anonymous", key: MEM0_MEMORY_KEY }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return readAgents();
    const data = (await res.json()) as { value?: string | null };
    if (!data.value) return readAgents();
    const mem0Agents = JSON.parse(data.value) as AgentTeam[];
    // Merge: local agents that aren't in Mem0 are preserved, Mem0 wins on conflict
    const local = readAgents();
    const mem0Ids = new Set(mem0Agents.map((a) => a.id));
    const localOnly = local.filter((a) => !mem0Ids.has(a.id));
    const merged = [...mem0Agents, ...localOnly];
    // Persist merged list locally so future offline reads are up-to-date
    writeAgents(merged);
    return merged;
  } catch {
    return readAgents();
  }
}

export async function cmdListAgents(): Promise<void> {
  const agents = await hydrateFromMem0();

  if (agents.length === 0) {
    console.log("\nNo agents configured yet.");
    console.log("Create one with: /agents create <name>\n");
    return;
  }

  // Build parent → children map for tree rendering
  const childrenOf = new Map<string | undefined, AgentTeam[]>();
  for (const agent of agents) {
    const key = agent.parentId ?? undefined;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(agent);
  }

  const printNode = (agent: AgentTeam, prefix: string, isLast: boolean): void => {
    const branch = isLast ? "└─" : "├─";
    const atName = `@${agent.name.toLowerCase().replace(/\s+/g, "-")}`;
    console.log(`${prefix}${branch} ${atName}  (${agent.color})`);
    console.log(`${prefix}${isLast ? "  " : "│ "}   ${agent.description}`);
    console.log(`${prefix}${isLast ? "  " : "│ "}   Tools: ${agent.allowedTools.join(", ")}`);
    const children = childrenOf.get(agent.id) ?? [];
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    children.forEach((child, i) => printNode(child, childPrefix, i === children.length - 1));
  };

  console.log(`\n── Configured Agents (${agents.length}) ──────────────────────\n`);
  const roots = childrenOf.get(undefined) ?? agents.filter((a) => !a.parentId);
  roots.forEach((root, i) => printNode(root, "", i === roots.length - 1));
  console.log();
}

export async function cmdCreateAgent(options: {
  name?: string;
  systemPrompt?: string;
  description?: string;
  color?: string;
  allowedTools?: string[];
  /** Epic C-01: parent agent name or id */
  parent?: string;
}): Promise<void> {
  const agents = readAgents();

  const name = options.name ?? "Custom Agent";
  const description = options.description ?? "A custom AI agent";
  const systemPrompt =
    options.systemPrompt ??
    `You are ${name}, a specialist AI assistant. ${description}\n\nFocus only on tasks within your domain.`;
  const color = options.color ?? COLORS[agents.length % COLORS.length]!;
  const allowedTools = options.allowedTools ?? DEFAULT_TOOLS;

  // Resolve optional parent
  let parentId: string | undefined;
  if (options.parent) {
    const parentAgent = agents.find(
      (a) =>
        a.name.toLowerCase() === options.parent!.toLowerCase() ||
        a.id === options.parent
    );
    if (!parentAgent) {
      console.error(`Parent agent "${options.parent}" not found.`);
      process.exit(1);
    }
    parentId = parentAgent.id;
  }

  const id = `agent_${Date.now()}`;
  const agent: AgentTeam = {
    id,
    name,
    systemPrompt,
    description,
    color,
    allowedTools,
    parentId,
    createdAt: new Date().toISOString(),
  };

  agents.push(agent);
  writeAgents(agents);
  syncToMem0(agents);

  console.log(`\n✓ Agent "${name}" created successfully.`);
  if (parentId) console.log(`  Child of: ${options.parent}`);
  console.log(`  Invoke with: @${name.toLowerCase().replace(/\s+/g, "-")}`);
  console.log(`  Tools: ${allowedTools.join(", ")}`);

  debugLog(`[agents] Created agent: ${name} (${id})${parentId ? ` parent=${parentId}` : ""}`);
}

export async function cmdRemoveAgent(name: string): Promise<void> {
  const agents = readAgents();
  const idx = agents.findIndex(
    (a) => a.name.toLowerCase() === name.toLowerCase()
  );

  if (idx === -1) {
    console.error(`Agent "${name}" not found.`);
    process.exit(1);
  }

  const removed = agents[idx]!;

  // Re-parent any children to the removed agent's own parent (or make them root)
  for (const agent of agents) {
    if (agent.parentId === removed.id) {
      agent.parentId = removed.parentId;
    }
  }

  agents.splice(idx, 1);
  writeAgents(agents);
  syncToMem0(agents);
  console.log(`✓ Agent "${removed.name}" removed.`);
}

export async function cmdUpdateAgent(options: {
  name: string;
  newName?: string;
  systemPrompt?: string;
  description?: string;
  color?: string;
  allowedTools?: string[];
  parent?: string;
}): Promise<void> {
  const agents = readAgents();
  const idx = agents.findIndex(
    (a) =>
      a.name.toLowerCase() === options.name.toLowerCase() ||
      a.name.toLowerCase().replace(/\s+/g, "-") === options.name.toLowerCase()
  );

  if (idx === -1) {
    console.error(`Agent "${options.name}" not found.`);
    process.exit(1);
  }

  const current = agents[idx]!;

  let parentId = current.parentId;
  if (options.parent !== undefined) {
    if (options.parent.trim() === "" || options.parent.toLowerCase() === "none") {
      parentId = undefined;
    } else {
      const parentAgent = agents.find(
        (a) =>
          a.id !== current.id &&
          (
            a.name.toLowerCase() === options.parent!.toLowerCase() ||
            a.id === options.parent
          )
      );
      if (!parentAgent) {
        console.error(`Parent agent "${options.parent}" not found.`);
        process.exit(1);
      }
      parentId = parentAgent.id;
    }
  }

  const nextName = options.newName?.trim() || current.name;
  const duplicateName = agents.find(
    (a) => a.id !== current.id && a.name.toLowerCase() === nextName.toLowerCase()
  );
  if (duplicateName) {
    console.error(`Agent name "${nextName}" already exists.`);
    process.exit(1);
  }

  const nextColor = options.color ?? current.color;
  if (nextColor && !COLORS.includes(nextColor)) {
    console.error(`Invalid color "${nextColor}". Allowed: ${COLORS.join(", ")}`);
    process.exit(1);
  }

  agents[idx] = {
    ...current,
    name: nextName,
    systemPrompt: options.systemPrompt ?? current.systemPrompt,
    description: options.description ?? current.description,
    color: nextColor,
    allowedTools: options.allowedTools ?? current.allowedTools,
    parentId,
  };

  writeAgents(agents);
  syncToMem0(agents);
  debugLog(`[agents] Updated agent: ${current.name} -> ${nextName}`);
}

export function getAgent(name: string): AgentTeam | null {
  const agents = readAgents();
  return (
    agents.find(
      (a) =>
        a.name.toLowerCase() === name.toLowerCase() ||
        a.name.toLowerCase().replace(/\s+/g, "-") === name.toLowerCase()
    ) ?? null
  );
}

export function getAllAgents(): AgentTeam[] {
  return readAgents();
}

/** Async variant that hydrates from Mem0 first, then falls back to local JSON. */
export async function getAllAgentsHydrated(): Promise<AgentTeam[]> {
  return hydrateFromMem0();
}

// ---------------------------------------------------------------------------
// Parallel agent execution — T-CLI-25
// ---------------------------------------------------------------------------

/**
 * Run multiple agents concurrently using Promise.all.
 * Each agent gets its own task string and runs against the bridge server.
 *
 * T-CLI-WORKTREE: Each agent optionally gets a dedicated git worktree to
 * prevent cwd conflicts when parallel agents write files concurrently.
 * Set PAKALON_AGENTS_WORKTREES=1 (or pass useWorktrees: true) to enable.
 *
 * T-CLI-TOOL-RESTRICT: Each agent's allowedTools list is enforced — only
 * tools in the agent's definition are sent to the bridge for inference.
 */
export interface AgentRunRequest {
  agentName: string;
  task: string;
  projectDir?: string;
  /** Override worktree usage for this request */
  useWorktrees?: boolean;
}

export interface AgentRunResult {
  agentName: string;
  success: boolean;
  response?: string;
  error?: string;
  tokensUsed?: number;
  durationMs: number;
  /** Worktree path used for this agent (if worktrees enabled) */
  worktreePath?: string;
}

// ---------------------------------------------------------------------------
// T-CLI-WORKTREE: Git worktree management helpers
// ---------------------------------------------------------------------------

async function createWorktree(
  baseDir: string,
  agentId: string
): Promise<string | null> {
  const { execSync: _exec } = await import("child_process");
  const { existsSync: _exists } = await import("fs");
  const _path = await import("path");
  const worktreePath = _path.join(baseDir, ".pakalon-worktrees", `agent-${agentId}-${Date.now()}`);
  try {
    // Verify this is a git repo
    _exec("git rev-parse --is-inside-work-tree", { cwd: baseDir, stdio: "pipe" });
    const branch = `pakalon-agent-${agentId.replace(/[^a-zA-Z0-9-]/g, "-")}-${Date.now()}`;
    const _fs = await import("fs");
    _fs.mkdirSync(worktreePath, { recursive: true });
    _exec(`git worktree add "${worktreePath}" -b "${branch}"`, {
      cwd: baseDir,
      stdio: "pipe",
    });
    debugLog(`[agents] Created worktree ${worktreePath} for agent ${agentId}`);    // T-HK-11: Fire WorktreeCreate hook
    import("@/ai/hooks.js").then(({ runHooks }) => {
      runHooks("WorktreeCreate", { cwd: worktreePath, worktreePath, agentId }, baseDir).catch(() => {});
    }).catch(() => {});    return worktreePath;
  } catch (err) {
    debugLog(`[agents] Could not create worktree for agent ${agentId}: ${String(err)}`);
    return null;
  }
}

async function removeWorktree(
  baseDir: string,
  worktreePath: string
): Promise<void> {
  const { execSync: _exec } = await import("child_process");
  try {
    _exec(`git worktree remove "${worktreePath}" --force`, {
      cwd: baseDir,
      stdio: "pipe",
    });
    debugLog(`[agents] Removed worktree ${worktreePath}`);    // T-HK-11: Fire WorktreeRemove hook
    import("@/ai/hooks.js").then(({ runHooks }) => {
      runHooks("WorktreeRemove", { cwd: baseDir, worktreePath }, baseDir).catch(() => {});
    }).catch(() => {});  } catch (err) {
    debugLog(`[agents] Could not remove worktree ${worktreePath}: ${String(err)}`);
  }
}

export async function cmdRunAgentsParallel(
  requests: AgentRunRequest[]
): Promise<AgentRunResult[]> {
  const { token, selectedModel } = useStore.getState();

  // T-CLI-WORKTREE: Determine if we should use worktrees
  const useWorktreesDefault =
    process.env.PAKALON_AGENTS_WORKTREES === "1" || requests.some((r) => r.useWorktrees);

  const runOne = async (req: AgentRunRequest): Promise<AgentRunResult> => {
    const start = Date.now();
    const agent = getAgent(req.agentName);
    if (!agent) {
      return {
        agentName: req.agentName,
        success: false,
        error: `Agent "${req.agentName}" not found`,
        durationMs: Date.now() - start,
      };
    }

    const baseDir = req.projectDir ?? process.cwd();
    let worktreePath: string | null = null;

    // T-CLI-WORKTREE: Spin up a dedicated git worktree
    if (req.useWorktrees ?? useWorktreesDefault) {
      worktreePath = await createWorktree(baseDir, agent.id);
    }

    const agentDir = worktreePath ?? baseDir;

    // T-CLI-TOOL-RESTRICT: Build the restricted tool set from agent.allowedTools
    // Only tools listed in agent.allowedTools are forwarded to the bridge.
    const allowedToolNames = agent.allowedTools.length > 0 ? agent.allowedTools : DEFAULT_TOOLS;

    try {
      const res = await fetch(`${BRIDGE_URL}/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: `parallel-${agent.id}-${Date.now()}`,
          type: "agent_run",
          payload: {
            task: req.task,
            model: selectedModel,
            messages: [{ role: "system", content: agent.systemPrompt }],
            project_dir: agentDir,
            token: token ?? "",
            privacy_mode: false,
            // T-CLI-TOOL-RESTRICT: Enforce per-agent tool restriction
            allowed_tools: allowedToolNames,
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        return {
          agentName: req.agentName,
          success: false,
          error: `Bridge error: HTTP ${res.status}`,
          durationMs: Date.now() - start,
          worktreePath: worktreePath ?? undefined,
        };
      }

      const data = (await res.json()) as { success: boolean; data?: { response?: string; tokens_used?: number }; error?: string };
      return {
        agentName: req.agentName,
        success: data.success,
        response: data.data?.response,
        tokensUsed: data.data?.tokens_used,
        error: data.error,
        durationMs: Date.now() - start,
        worktreePath: worktreePath ?? undefined,
      };
    } catch (err) {
      return {
        agentName: req.agentName,
        success: false,
        error: String(err),
        durationMs: Date.now() - start,
        worktreePath: worktreePath ?? undefined,
      };
    } finally {
      // T-CLI-WORKTREE: Always clean up the worktree when done
      if (worktreePath) {
        await removeWorktree(baseDir, worktreePath).catch(() => {});
      }
    }
  };

  // T-HK-08: TeammateIdle — fire after each agent finishes; exit-code 2 re-runs the agent
  const runOneWithIdleHook = async (req: AgentRunRequest): Promise<AgentRunResult> => {
    let result = await runOne(req);
    try {
      const { runHooks } = await import("@/ai/hooks.js");
      const hookResults = await runHooks(
        "TeammateIdle",
        { cwd: req.projectDir ?? process.cwd(), agentName: req.agentName, success: result.success },
        req.projectDir
      );
      // Exit code 2 from a TeamateIdle hook means "keep working" — run the agent once more
      if (hookResults.some((r) => r.exitCode === 2)) {
        debugLog(`[agents] TeammateIdle hook exit 2 for ${req.agentName} — re-running`);
        result = await runOne(req);
      }
    } catch { /* hooks are non-blocking */ }
    return result;
  };

  debugLog(`[agents] Running ${requests.length} agents in parallel: ${requests.map((r) => r.agentName).join(", ")}${useWorktreesDefault ? " (worktrees: ON)" : ""}`);
  return Promise.all(requests.map(runOneWithIdleHook));
}
