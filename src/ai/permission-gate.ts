/**
 * Permission Gate — HIL (Human-in-the-Loop) permission system.
 *
 * When the AI agent wants to perform a destructive action (write, delete, bash),
 * it calls `requestPermission()` which:
 *   1. Emits a structured `PermissionRequest` with what/why/risk/affected fields
 *   2. Awaits a user decision from the TUI dialog
 *   3. Returns `PermissionDecision` — approved | denied | approvedForSession
 *
 * Approval modes:
 *   - "once"       → allow this single request only
 *   - "session"    → auto-allow all future requests for the same tool in this session
 *   - "deny"       → block this request (agent receives false)
 *
 * The TUI listens for `permission_request` events via `permissionGate.onRequest()` and
 * calls `permissionGate.resolve()` with one of those modes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Risk level for a permission request. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** Structured permission request payload. */
export interface PermissionRequest {
  id: string;
  /** Tool name: "bash", "writeFile", "deleteFile", etc. */
  tool: string;
  /** Human-readable description of the ACTION being requested. */
  what: string;
  /** Why the AI needs to do this (from tool context). */
  why: string;
  /** Risk level for the action. */
  risk: RiskLevel;
  /** Files that will be created/modified/deleted. */
  affectedFiles: string[];
  /** Raw tool params for advanced display. */
  params: Record<string, unknown>;
  /** Optional agent ID that triggered the request. */
  agentId?: string;
}

/** Decision returned from a resolved permission request. */
export type PermissionDecisionMode = "once" | "session" | "deny";

export interface PermissionDecision {
  allowed: boolean;
  mode: PermissionDecisionMode;
}

type PermissionListener = (request: PermissionRequest) => void;

// ---------------------------------------------------------------------------
// Risk inference helpers
// ---------------------------------------------------------------------------

function _inferRisk(tool: string, params: Record<string, unknown>): RiskLevel {
  if (tool === "deleteFile") return "critical";
  if (tool === "bash") {
    const cmd = String(params.command ?? params.cmd ?? "");
    if (/rm -rf|sudo|chmod 777|dd if=|mkfs/.test(cmd)) return "critical";
    if (/rm |curl .* \| bash|wget .* \| sh/.test(cmd)) return "high";
    return "medium";
  }
  if (tool === "writeFile" || tool === "editFile" || tool === "patchFile") {
    const p = String(params.path ?? params.filePath ?? "");
    if (/\.(env|pem|key|crt|pfx|p12)$/.test(p)) return "high";
    return "low";
  }
  return "low";
}

function _inferAffectedFiles(tool: string, params: Record<string, unknown>): string[] {
  const candidates = [params.path, params.filePath, params.file, params.target];
  const files = candidates
    .filter(Boolean)
    .map((f) => String(f));
  if (files.length) return files;
  // For bash, we can't know, but we indicate the command as relevant
  if (tool === "bash") {
    return [`[bash] ${String(params.command ?? params.cmd ?? "").slice(0, 80)}`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Singleton gate
// ---------------------------------------------------------------------------

class PermissionGate {
  private pending: Map<string, { request: PermissionRequest; resolve: (d: PermissionDecision) => void }> = new Map();
  private listeners: Set<PermissionListener> = new Set();

  /** Per-agent tool allowlists. If an agent has a policy, only listed tools are auto-allowed. */
  private agentToolPolicies: Map<string, string[]> = new Map();

  /**
   * Per-session auto-approvals: { tool → true }.
   * Set when user chooses "approve for session".
   */
  private sessionApprovals: Map<string, boolean> = new Map();

  // ── Core request/resolve API ─────────────────────────────────────

  /**
   * Request permission for a destructive action.
   * Blocks until the user accepts or declines via the TUI.
   *
   * @param what  Human-readable description of the action
   * @param why   Reason the AI is requesting this
   * @param tool  Tool identifier
   * @param params Raw tool parameters for display
   * @param agentId Optional agent ID for per-agent policy enforcement
   * @returns `true` if the user accepted, `false` if declined.
   */
  async requestPermission(
    tool: string,
    what: string,
    params: Record<string, unknown>,
    agentId?: string,
    why: string = "",
  ): Promise<boolean> {
    // Per-agent allowlist check: auto-deny if tool not in agent policy
    if (agentId && this.agentToolPolicies.has(agentId)) {
      const allowed = this.agentToolPolicies.get(agentId)!;
      if (!allowed.includes(tool)) return false;
    }

    // Session-level auto-approval
    if (this.sessionApprovals.get(tool)) return true;

    const id = crypto.randomUUID();
    const risk = _inferRisk(tool, params);
    const affectedFiles = _inferAffectedFiles(tool, params);

    const request: PermissionRequest = {
      id,
      tool,
      what,
      why,
      risk,
      affectedFiles,
      params,
      agentId,
    };

    return new Promise<boolean>((resolve) => {
      this.pending.set(id, {
        request,
        resolve: (decision) => {
          if (decision.mode === "session" && decision.allowed) {
            this.sessionApprovals.set(tool, true);
          }
          resolve(decision.allowed);
        },
      });
      for (const listener of this.listeners) {
        try { listener(request); } catch { /* ignore */ }
      }
    });
  }

  /**
   * Resolve a pending request with a full decision object.
   * `mode` can be "once", "session", or "deny".
   */
  resolve(id: string, mode: PermissionDecisionMode): void {
    const handler = this.pending.get(id);
    if (!handler) return;
    this.pending.delete(id);
    handler.resolve({ allowed: mode !== "deny", mode });
  }

  /** Shorthand: accept once */
  accept(id: string): void {
    this.resolve(id, "once");
  }

  /** Shorthand: accept for the rest of this session */
  acceptForSession(id: string): void {
    this.resolve(id, "session");
  }

  /** Shorthand: deny */
  deny(id: string): void {
    this.resolve(id, "deny");
  }

  // ── Listener API ─────────────────────────────────────────────────

  onRequest(listener: PermissionListener): void {
    this.listeners.add(listener);
  }

  offRequest(listener: PermissionListener): void {
    this.listeners.delete(listener);
  }

  // ── Query API ────────────────────────────────────────────────────

  /** Returns the first pending request (for TUI display), or null. */
  getPendingRequest(): PermissionRequest | null {
    const first = this.pending.entries().next();
    if (first.done) return null;
    return first.value[1].request;
  }

  /** True if there are any pending requests */
  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** True when `tool` is auto-approved for the rest of this session. */
  isSessionApproved(tool: string): boolean {
    return this.sessionApprovals.get(tool) === true;
  }

  /** Clear all session-level approvals (e.g. on logout or mode change). */
  clearSessionApprovals(): void {
    this.sessionApprovals.clear();
  }

  // ── Per-agent policy API ─────────────────────────────────────────

  setAgentPolicy(agentId: string, allowedTools: string[]): void {
    this.agentToolPolicies.set(agentId, allowedTools);
  }

  clearAgentPolicy(agentId: string): void {
    this.agentToolPolicies.delete(agentId);
  }

  isToolAllowedForAgent(agentId: string, tool: string): boolean {
    if (!this.agentToolPolicies.has(agentId)) return true;
    return this.agentToolPolicies.get(agentId)!.includes(tool);
  }
}

export const permissionGate = new PermissionGate();
