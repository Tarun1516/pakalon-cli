/**
 * enterprise.ts — /enterprise CLI command
 * ──────────────────────────────────────────
 * Routes enterprise integration sub-commands: notion, jira.
 *
 * CLI surface:
 *   pakalon enterprise notion setup --token <tok> [--workspace <name>] [--scope project]
 *   pakalon enterprise notion remove [--scope project]
 *   pakalon enterprise notion status
 *
 *   pakalon enterprise jira setup --token <tok> --workspace <site> [--email <e>] [--scope project]
 *   pakalon enterprise jira remove [--scope project]
 *   pakalon enterprise jira status
 *
 * Slash-command routing (from InputBar /enterprise):
 *   /enterprise notion setup
 *   /enterprise jira status
 */

import {
  setupNotionMcp,
  removeNotionMcp,
  notionStatus,
  type NotionSetupOptions,
} from "@/mcp/enterprise/notion.js";

import {
  setupJiraMcp,
  removeJiraMcp,
  jiraStatus,
  type JiraSetupOptions,
} from "@/mcp/enterprise/jira.js";

import type { McpScope } from "@/mcp/manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnterpriseService = "notion" | "jira";
export type EnterpriseAction = "setup" | "remove" | "status";

export interface EnterpriseOptions {
  /** API / PAT token for authentication */
  token?: string;
  /** Workspace name or Atlassian cloud subdomain */
  workspace?: string;
  /** User email (Jira Cloud only) */
  email?: string;
  /** Jira Server/DC full URL */
  server?: string;
  /** MCP scope: "global" (default) or "project" */
  scope?: McpScope;
  /** Project CWD for project-scope entries */
  cwd?: string;
}

export interface EnterpriseResult {
  ok: boolean;
  message: string;
  service: EnterpriseService;
  action: EnterpriseAction;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch an enterprise sub-command.
 *
 * @example
 * await cmdEnterprise("notion", "setup", { token: "secret_xxx", workspace: "My Team" });
 * await cmdEnterprise("jira", "status", {});
 */
export async function cmdEnterprise(
  service: EnterpriseService,
  action: EnterpriseAction,
  opts: EnterpriseOptions = {}
): Promise<EnterpriseResult> {
  const scope: McpScope = opts.scope ?? "global";
  const cwd = opts.cwd ?? process.cwd();

  switch (service) {
    // ── Notion ──────────────────────────────────────────────────────────────
    case "notion": {
      if (action === "setup") {
        if (!opts.token) {
          return {
            ok: false,
            message: "Missing required --token (Notion Integration Token).",
            service,
            action,
          };
        }
        const notionOpts: NotionSetupOptions = {
          token: opts.token,
          workspace: opts.workspace,
          scope,
          cwd,
        };
        const result = await setupNotionMcp(notionOpts);
        return { ...result, service, action };
      }

      if (action === "remove") {
        const result = removeNotionMcp(scope, cwd);
        return { ...result, service, action };
      }

      if (action === "status") {
        const st = notionStatus(cwd);
        return {
          ok: true,
          message: st.configured
            ? `Notion MCP connected (workspace: ${st.workspace ?? "unknown"})`
            : "Notion MCP not connected.",
          service,
          action,
          data: st as unknown as Record<string, unknown>,
        };
      }
      break;
    }

    // ── Jira ───────────────────────────────────────────────────────────────
    case "jira": {
      if (action === "setup") {
        if (!opts.token) {
          return {
            ok: false,
            message: "Missing required --token (Jira PAT or API token).",
            service,
            action,
          };
        }
        const jiraOpts: JiraSetupOptions = {
          token: opts.token,
          workspace: opts.workspace,
          server: opts.server,
          email: opts.email,
          scope,
          cwd,
        };
        const result = await setupJiraMcp(jiraOpts);
        return { ...result, service, action };
      }

      if (action === "remove") {
        const result = removeJiraMcp(scope, cwd);
        return { ...result, service, action };
      }

      if (action === "status") {
        const st = jiraStatus(cwd);
        return {
          ok: true,
          message: st.configured
            ? `Jira MCP connected (${st.type === "cloud" ? "Cloud" : "Server"}: ${st.baseUrl ?? ""})`
            : "Jira MCP not connected.",
          service,
          action,
          data: st as unknown as Record<string, unknown>,
        };
      }
      break;
    }

    default:
      return {
        ok: false,
        message: `Unknown enterprise service: ${service as string}. Use "notion" or "jira".`,
        service: service as EnterpriseService,
        action,
      };
  }

  return {
    ok: false,
    message: `Unknown action "${action}" for service "${service}". Use setup / remove / status.`,
    service,
    action,
  };
}

// ---------------------------------------------------------------------------
// Print-mode (used by CLI yargs handler)
// ---------------------------------------------------------------------------

export async function cmdEnterprisePrint(
  service: EnterpriseService,
  action: EnterpriseAction,
  opts: EnterpriseOptions
): Promise<void> {
  const result = await cmdEnterprise(service, action, opts);
  if (result.ok) {
    console.log(`✓ ${result.message}`);
    if (result.data && action === "status") {
      console.log(JSON.stringify(result.data, null, 2));
    }
  } else {
    console.error(`✗ ${result.message}`);
    process.exit(1);
  }
}
