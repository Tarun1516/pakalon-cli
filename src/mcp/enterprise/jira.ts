/**
 * Enterprise MCP — Jira connector (P11)
 * ──────────────────────────────────────
 * Wraps the official Atlassian/Jira MCP server into Pakalon's MCP manager.
 * Supports both Jira Cloud (cloud.atlassian.net) and on-premise Server/DC.
 *
 * Usage (from CLI):
 *   /enterprise jira setup --token <pat> --workspace <site>.atlassian.net
 *   /enterprise jira setup --server https://jira.mycompany.com --token <pat>
 */
import path from "path";
import os from "os";
import fs from "fs";
import { addMcpServer, removeMcpServer, getMcpServer, McpScope } from "@/mcp/manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JIRA_MCP_PACKAGE = "@atlassianlabs/jira-mcp-server";
const JIRA_SERVER_NAME = "jira";
const JIRA_CLOUD_BASE = "https://{workspace}.atlassian.net";
const JIRA_ENV_FILE = path.join(os.homedir(), ".config", "pakalon", "enterprise", "jira.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JiraSetupOptions {
  /** Personal Access Token (PAT) or API token */
  token: string;
  /** Atlassian workspace subdomain (e.g. "mycompany") for Cloud,
   *  or full server URL for Jira Server/DC */
  workspace?: string;
  /** Full URL for Jira Server/DC. Takes precedence over workspace. */
  server?: string;
  /** Jira user email (required for Cloud) */
  email?: string;
  /** Scope for the MCP server entry */
  scope?: McpScope;
  /** Project directory for project-scope entries */
  cwd?: string;
}

export interface JiraConfig {
  type: "cloud" | "server";
  baseUrl: string;
  token: string;
  email?: string;
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

function readJiraConfig(): JiraConfig | null {
  try {
    if (fs.existsSync(JIRA_ENV_FILE)) {
      return JSON.parse(fs.readFileSync(JIRA_ENV_FILE, "utf-8")) as JiraConfig;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeJiraConfig(cfg: JiraConfig): void {
  fs.mkdirSync(path.dirname(JIRA_ENV_FILE), { recursive: true });
  fs.writeFileSync(JIRA_ENV_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

function deleteJiraConfig(): void {
  try {
    fs.unlinkSync(JIRA_ENV_FILE);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set up the Jira MCP server and persist credentials.
 * Returns a result object with ok/message.
 */
export async function setupJiraMcp(
  opts: JiraSetupOptions
): Promise<{ ok: boolean; message: string }> {
  const { token, workspace, server, email, scope = "global", cwd } = opts;

  if (!token) {
    return { ok: false, message: "Jira setup requires --token <api-token-or-pat>" };
  }

  // Determine base URL
  let baseUrl: string;
  let type: "cloud" | "server";

  if (server) {
    baseUrl = server.replace(/\/$/, "");
    type = "server";
  } else if (workspace) {
    baseUrl = JIRA_CLOUD_BASE.replace("{workspace}", workspace);
    type = "cloud";
  } else {
    return {
      ok: false,
      message: "Jira setup requires --workspace <slug> (Cloud) or --server <url> (Server/DC)",
    };
  }

  if (type === "cloud" && !email) {
    return { ok: false, message: "Jira Cloud setup requires --email <your@email.com>" };
  }

  // Persist credentials
  const cfg: JiraConfig = { type, baseUrl, token, email };
  writeJiraConfig(cfg);

  // The MCP URL is either a hosted SSE endpoint or a local npm-based stdio bridge.
  // For now we register with the well-known community URL and inject credentials
  // via environment file conventions.
  const mcpUrl = `${baseUrl}/rest/mcp/v1/sse`;

  const result = await addMcpServer(JIRA_SERVER_NAME, mcpUrl, scope, {
    description: `Jira ${type === "cloud" ? "Cloud" : "Server"} MCP (${baseUrl})`,
    transport: "sse",
    cwd,
    skipConnCheck: true, // Token not yet set in headers — checked separately
  });

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    message: [
      `✅ Jira MCP configured (${type}, ${baseUrl})`,
      `   Credentials saved to: ${JIRA_ENV_FILE}`,
      `   Server registered as: "${JIRA_SERVER_NAME}"`,
      "",
      type === "cloud"
        ? `   Set environment: JIRA_API_TOKEN="${token}" JIRA_EMAIL="${email}"`
        : `   Set environment: JIRA_PAT="${token}"`,
      "",
      "   Restart Pakalon to activate the connector.",
    ].join("\n"),
  };
}

/**
 * Remove the Jira MCP server and delete credentials.
 */
export function removeJiraMcp(scope: McpScope = "global", cwd?: string): { ok: boolean; message: string } {
  const result = removeMcpServer(JIRA_SERVER_NAME, scope, cwd);
  deleteJiraConfig();
  if (!result.ok) return result;
  return { ok: true, message: "✅ Jira MCP removed and credentials deleted." };
}

/**
 * Return the current Jira connection status.
 */
export function jiraStatus(cwd?: string): {
  configured: boolean;
  baseUrl?: string;
  type?: string;
  email?: string;
} {
  const server = getMcpServer(JIRA_SERVER_NAME, cwd);
  const cfg = readJiraConfig();

  if (!server || !cfg) return { configured: false };
  return {
    configured: true,
    baseUrl: cfg.baseUrl,
    type: cfg.type,
    email: cfg.email,
  };
}

/**
 * Quick help text for the Jira connector.
 */
export const JIRA_HELP = `**Jira MCP Connector**

Setup (Jira Cloud):
  /enterprise jira setup --token <api-token> --workspace <slug> --email <you@company.com>

Setup (Jira Server/DC):
  /enterprise jira setup --token <pat> --server https://jira.mycompany.com

Remove:
  /enterprise jira remove

Status:
  /enterprise jira status

After setup, the AI can:
  • List and search Jira issues
  • Create / update issues
  • Transition issue status
  • Add comments

Credentials are stored in: ~/.config/pakalon/enterprise/jira.json
`;
