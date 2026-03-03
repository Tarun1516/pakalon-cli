/**
 * Enterprise MCP — Notion connector (P11)
 * ─────────────────────────────────────────
 * Wraps the official Notion MCP server into Pakalon's MCP manager.
 * Uses the community SSE MCP server at https://github.com/makenotion/notion-mcp-server.
 *
 * Usage (from CLI):
 *   /enterprise notion setup --token <integration-token> [--workspace <name>]
 */
import path from "path";
import os from "os";
import fs from "fs";
import { addMcpServer, removeMcpServer, getMcpServer, McpScope } from "@/mcp/manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTION_SERVER_NAME = "notion";
const NOTION_MCP_URL = "https://api.notion.com/v1/mcp";
const NOTION_ENV_FILE = path.join(os.homedir(), ".config", "pakalon", "enterprise", "notion.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotionSetupOptions {
  /** Notion Internal Integration Token (secret_…) */
  token: string;
  /** Optional workspace name for display purposes */
  workspace?: string;
  /** Scope for the MCP server entry */
  scope?: McpScope;
  /** Project directory for project-scope entries */
  cwd?: string;
}

export interface NotionConfig {
  token: string;
  workspace?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

function readNotionConfig(): NotionConfig | null {
  try {
    if (fs.existsSync(NOTION_ENV_FILE)) {
      return JSON.parse(fs.readFileSync(NOTION_ENV_FILE, "utf-8")) as NotionConfig;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeNotionConfig(cfg: NotionConfig): void {
  fs.mkdirSync(path.dirname(NOTION_ENV_FILE), { recursive: true });
  fs.writeFileSync(NOTION_ENV_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

function deleteNotionConfig(): void {
  try {
    fs.unlinkSync(NOTION_ENV_FILE);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Token validation (lightweight)
// ---------------------------------------------------------------------------

function isValidNotionToken(token: string): boolean {
  // Integration tokens start with "secret_", OAuth tokens with "ntn_"
  return token.startsWith("secret_") || token.startsWith("ntn_");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set up the Notion MCP server and persist credentials.
 */
export async function setupNotionMcp(
  opts: NotionSetupOptions
): Promise<{ ok: boolean; message: string }> {
  const { token, workspace, scope = "global", cwd } = opts;

  if (!token) {
    return {
      ok: false,
      message: "Notion setup requires --token <integration-token> (starts with secret_ or ntn_)",
    };
  }

  if (!isValidNotionToken(token)) {
    return {
      ok: false,
      message: [
        "Invalid Notion token format.",
        "Integration tokens start with `secret_`.",
        "OAuth access tokens start with `ntn_`.",
        "Create one at: https://www.notion.so/my-integrations",
      ].join("\n"),
    };
  }

  // Persist credentials
  const cfg: NotionConfig = {
    token,
    workspace,
    createdAt: new Date().toISOString(),
  };
  writeNotionConfig(cfg);

  const result = await addMcpServer(NOTION_SERVER_NAME, NOTION_MCP_URL, scope, {
    description: `Notion MCP${workspace ? ` (${workspace})` : ""}`,
    transport: "sse",
    cwd,
    skipConnCheck: true,
  });

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    message: [
      `✅ Notion MCP configured${workspace ? ` for workspace "${workspace}"` : ""}`,
      `   Credentials saved to: ${NOTION_ENV_FILE}`,
      `   Server registered as: "${NOTION_SERVER_NAME}"`,
      "",
      `   Set environment: NOTION_API_KEY="${token}"`,
      "",
      "   Restart Pakalon to activate the connector.",
      "",
      "   ⚠️  Share your Notion databases/pages with the integration",
      "      before the AI can access them.",
    ].join("\n"),
  };
}

/**
 * Remove the Notion MCP server and delete credentials.
 */
export function removeNotionMcp(scope: McpScope = "global", cwd?: string): { ok: boolean; message: string } {
  const result = removeMcpServer(NOTION_SERVER_NAME, scope, cwd);
  deleteNotionConfig();
  if (!result.ok) return result;
  return { ok: true, message: "✅ Notion MCP removed and credentials deleted." };
}

/**
 * Return the current Notion connection status.
 */
export function notionStatus(cwd?: string): {
  configured: boolean;
  workspace?: string;
  createdAt?: string;
} {
  const server = getMcpServer(NOTION_SERVER_NAME, cwd);
  const cfg = readNotionConfig();

  if (!server || !cfg) return { configured: false };
  return {
    configured: true,
    workspace: cfg.workspace,
    createdAt: cfg.createdAt,
  };
}

/**
 * Quick help text for the Notion connector.
 */
export const NOTION_HELP = `**Notion MCP Connector**

Setup:
  /enterprise notion setup --token <integration-token> [--workspace <name>]

  Get your token at: https://www.notion.so/my-integrations
  (Create an internal integration, copy the "Internal Integration Secret")

Remove:
  /enterprise notion remove

Status:
  /enterprise notion status

After setup, the AI can:
  • Search Notion pages and databases
  • Read page content
  • Create and update pages
  • Append blocks to existing pages
  • Query databases with filters

Credentials are stored in: ~/.config/pakalon/enterprise/notion.json
`;
