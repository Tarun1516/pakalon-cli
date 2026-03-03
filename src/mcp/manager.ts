/**
 * MCP Manager — add/remove/list MCP servers at global and project scope.
 * Global config: ~/.config/pakalon/mcp.json
 * Project config: .pakalon/mcp.json (cwd)
 */
import fs from "fs";
import path from "path";
import os from "os";
import { debugLog } from "@/utils/logger.js";
import {
  loadOAuthToken,
  generateOAuthUrl,
  completeOAuthFlow,
  getValidAccessToken,
  getAllResources,
  searchResources,
  executeMcpPrompt,
  parseMcpPromptCommand,
  type OAuthConfig,
} from "./advanced.js";
// NOTE: imported lazily to avoid circular deps (tools.ts imports manager.ts)
let _invalidateMcpToolCache: (() => void) | null = null;
function _getInvalidate(): () => void {
  if (!_invalidateMcpToolCache) {
    // Lazy import to break circular dependency
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("@/mcp/tools.js") as { invalidateMcpToolCache?: () => void };
      _invalidateMcpToolCache = m.invalidateMcpToolCache ?? (() => {});
    } catch {
      _invalidateMcpToolCache = () => {};
    }
  }
  return _invalidateMcpToolCache!;
}

export type McpScope = "global" | "project";

export interface McpServerConfig {
  name: string;
  url: string;
  description?: string;
  transport?: "sse" | "stdio";
  addedAt?: string;
  enabled?: boolean;          // T1-5: can be disabled without removing
  lastHealthCheck?: string;   // T1-5: ISO timestamp of last ping
  lastHealthStatus?: "ok" | "error" | "unknown"; // T1-5
  // T-A22: OAuth 2.0 support
  authType?: "none" | "oauth" | "bearer";
  authUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  redirectUri?: string;
}

interface McpConfigFile {
  servers: McpServerConfig[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function globalMcpPath(): string {
  return path.join(os.homedir(), ".config", "pakalon", "mcp.json");
}

function projectMcpPath(cwd?: string): string {
  return path.join(cwd ?? process.cwd(), ".pakalon", "mcp.json");
}

// ---------------------------------------------------------------------------
// Read / Write helpers
// ---------------------------------------------------------------------------

function readConfig(filePath: string): McpConfigFile {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<McpConfigFile>;
    return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
  } catch {
    return { servers: [] };
  }
}

function writeConfig(filePath: string, config: McpConfigFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Connectivity check
// ---------------------------------------------------------------------------

async function checkConnectivity(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal }).catch(() => null);
    clearTimeout(timer);
    return res !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add an MCP server to either global or project scope.
 */
export async function addMcpServer(
  name: string,
  url: string,
  scope: McpScope = "global",
  options: { description?: string; transport?: "http" | "sse" | "stdio"; cwd?: string; skipConnCheck?: boolean } = {}
): Promise<{ ok: boolean; message: string }> {
  const filePath = scope === "global" ? globalMcpPath() : projectMcpPath(options.cwd);
  const config = readConfig(filePath);

  // Duplicate check
  if (config.servers.some((s) => s.name === name)) {
    return { ok: false, message: `MCP server "${name}" already exists in ${scope} config.` };
  }

  // Connectivity validation (unless skipped)
  if (!options.skipConnCheck) {
    debugLog(`[mcp] Checking connectivity for ${url}`);
    const reachable = await checkConnectivity(url);
    if (!reachable) {
      return { ok: false, message: `Cannot reach MCP server at ${url}. Add anyway with --skip-check.` };
    }
  }

  const entry: McpServerConfig = {
    name,
    url,
    // Normalize 'http' transport to 'sse' — both use JSON-RPC over HTTP in tools.ts
    transport: (options.transport === "http" ? "sse" : options.transport) ?? "sse",
    addedAt: new Date().toISOString(),
    ...(options.description ? { description: options.description } : {}),
  };

  config.servers.push(entry);
  writeConfig(filePath, config);
  debugLog(`[mcp] Added ${name} to ${scope} config at ${filePath}`);
  _getInvalidate()();

  return { ok: true, message: `Added MCP server "${name}" to ${scope} config.` };
}

/**
 * Remove an MCP server by name from given scope.
 */
export function removeMcpServer(
  name: string,
  scope: McpScope = "global",
  cwd?: string
): { ok: boolean; message: string } {
  const filePath = scope === "global" ? globalMcpPath() : projectMcpPath(cwd);
  const config = readConfig(filePath);
  const before = config.servers.length;
  config.servers = config.servers.filter((s) => s.name !== name);

  if (config.servers.length === before) {
    return { ok: false, message: `MCP server "${name}" not found in ${scope} config.` };
  }

  writeConfig(filePath, config);
  _getInvalidate()();
  return { ok: true, message: `Removed MCP server "${name}" from ${scope} config.` };
}

/**
 * List all MCP servers, merging global + project configs.
 */
export function listMcpServers(cwd?: string): Array<McpServerConfig & { scope: McpScope }> {
  const globalServers = readConfig(globalMcpPath()).servers.map((s) => ({
    ...s,
    scope: "global" as McpScope,
  }));
  const projectServers = readConfig(projectMcpPath(cwd)).servers.map((s) => ({
    ...s,
    scope: "project" as McpScope,
  }));

  // Project servers override global ones with same name
  const globalFiltered = globalServers.filter(
    (g) => !projectServers.some((p) => p.name === g.name)
  );

  return [...globalFiltered, ...projectServers];
}

/**
 * Get a single MCP server by name (project takes precedence over global).
 */
export function getMcpServer(name: string, cwd?: string): (McpServerConfig & { scope: McpScope }) | null {
  const all = listMcpServers(cwd);
  return all.find((s) => s.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// T1-5: Enable / Disable / Status
// ---------------------------------------------------------------------------

/**
 * Enable a previously disabled MCP server.
 */
export function enableMcpServer(name: string, scope: McpScope = "global", cwd?: string): { ok: boolean; message: string } {
  return _setEnabled(name, true, scope, cwd);
}

/**
 * Disable an MCP server without removing it.
 * Disabled servers are not loaded at startup, but remain in config.
 */
export function disableMcpServer(name: string, scope: McpScope = "global", cwd?: string): { ok: boolean; message: string } {
  return _setEnabled(name, false, scope, cwd);
}

function _setEnabled(name: string, enabled: boolean, scope: McpScope, cwd?: string): { ok: boolean; message: string } {
  const filePath = scope === "global" ? globalMcpPath() : projectMcpPath(cwd);
  const config = readConfig(filePath);
  const server = config.servers.find((s) => s.name === name);

  if (!server) {
    return { ok: false, message: `MCP server "${name}" not found in ${scope} config.` };
  }

  server.enabled = enabled;
  writeConfig(filePath, config);
  _getInvalidate()();
  return { ok: true, message: `MCP server "${name}" ${enabled ? "enabled" : "disabled"} in ${scope} config.` };
}

/**
 * Health-check a single MCP server (or all servers) by sending a HEAD/GET request.
 * Updates `lastHealthCheck` and `lastHealthStatus` in config.
 *
 * Returns a summary object keyed by server name.
 */
export async function checkMcpStatus(
  name?: string,
  cwd?: string
): Promise<Record<string, { ok: boolean; latencyMs?: number; error?: string }>> {
  const servers = listMcpServers(cwd).filter((s) => !name || s.name === name).filter((s) => s.enabled !== false);

  const results: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

  await Promise.all(
    servers.map(async (server) => {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(server.url, { method: "HEAD", signal: controller.signal }).catch(() => null);
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        const ok = res !== null && res.status < 500;
        results[server.name] = { ok, latencyMs };

        // Persist health status back to config
        const scope = server.scope;
        const filePath = scope === "global" ? globalMcpPath() : projectMcpPath(cwd);
        const config = readConfig(filePath);
        const entry = config.servers.find((s) => s.name === server.name);
        if (entry) {
          entry.lastHealthCheck = new Date().toISOString();
          entry.lastHealthStatus = ok ? "ok" : "error";
          writeConfig(filePath, config);
        }
      } catch (err: unknown) {
        const e = err as { message?: string };
        results[server.name] = { ok: false, error: e.message ?? String(err) };
      }
    })
  );

  return results;
}

/**
 * Format health-check results as a human-readable string.
 */
export function formatMcpStatus(results: Record<string, { ok: boolean; latencyMs?: number; error?: string }>): string {
  const entries = Object.entries(results);
  if (!entries.length) return "No MCP servers to check.";

  return entries
    .map(([name, r]) => {
      const latency = r.latencyMs !== undefined ? ` (${r.latencyMs}ms)` : "";
      const status = r.ok ? `✅ ok${latency}` : `❌ error: ${r.error ?? "unreachable"}`;
      return `  ${name}: ${status}`;
    })
    .join("\n");
}

/**
 * Handle @mcp <name> <url> in-chat shortcut.
 */
export async function handleMcpAtMention(
  input: string,
  cwd?: string
): Promise<string> {
  // Expected: "@mcp <name> <url> [global|project]"
  const parts = input.replace(/^@mcp\s+/i, "").trim().split(/\s+/);
  if (parts.length < 2) {
    return "Usage: @mcp <name> <url> [global|project]";
  }
  const [name, url, scopeArg] = parts as [string, string, string | undefined];
  const scope: McpScope = scopeArg === "project" ? "project" : "global";
  const result = await addMcpServer(name, url, scope, { cwd });
  return result.message;
}

// ---------------------------------------------------------------------------
// Claude Desktop config import (T-MCP-10)
// ---------------------------------------------------------------------------

/**
 * Possible paths for Claude Desktop's claude_desktop_config.json.
 * Checked in order; first existing file is used.
 */
function _claudeDesktopConfigPaths(): string[] {
  const home = os.homedir();
  return [
    // macOS
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    // Windows
    path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json"),
    // Linux
    path.join(home, ".config", "Claude", "claude_desktop_config.json"),
  ];
}

export interface ClaudeDesktopImportResult {
  imported: string[];
  skipped: string[];
  errors: Array<{ name: string; reason: string }>;
}

/**
 * Read Claude Desktop's `claude_desktop_config.json` and import all defined
 * `mcpServers` into the Pakalon global MCP config.
 *
 * Stdio servers (command + args) are stored as a single command string in the
 * `url` field, matching how `parseStdioCommand` in `mcp/tools.ts` expects them.
 */
export async function importFromClaudeDesktop(
  scope: McpScope = "global",
  cwd?: string
): Promise<ClaudeDesktopImportResult> {
  const result: ClaudeDesktopImportResult = { imported: [], skipped: [], errors: [] };

  // Find the config file
  const configPath = _claudeDesktopConfigPaths().find((p) => fs.existsSync(p));
  if (!configPath) {
    throw new Error(
      "Claude Desktop config not found. Expected locations:\n" +
        _claudeDesktopConfigPaths()
          .map((p) => `  • ${p}`)
          .join("\n")
    );
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse Claude Desktop config at ${configPath}: ${String(err)}`);
  }

  const mcpServers = (rawConfig as any)?.mcpServers as
    | Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string> }>
    | undefined;

  if (!mcpServers || typeof mcpServers !== "object") {
    throw new Error("No `mcpServers` key found in Claude Desktop config.");
  }

  for (const [name, serverDef] of Object.entries(mcpServers)) {
    try {
      let url: string;
      let transport: "sse" | "stdio";

      if (serverDef.url) {
        // SSE / HTTP remote server
        url = serverDef.url;
        transport = "sse";
      } else if (serverDef.command) {
        // Stdio server: join command + args into a single shell string
        const args = Array.isArray(serverDef.args) ? serverDef.args.join(" ") : "";
        url = args ? `${serverDef.command} ${args}` : serverDef.command;
        transport = "stdio";
      } else {
        result.errors.push({ name, reason: "Server has neither `command` nor `url` field" });
        continue;
      }

      const addResult = await addMcpServer(name, url, scope, {
        cwd,
        transport,
        description: `Imported from Claude Desktop (${new Date().toLocaleDateString()})`,
        skipConnCheck: transport === "stdio", // stdio servers aren't URLs — skip connectivity check
      });

      if (addResult.ok) {
        result.imported.push(name);
      } else if (addResult.message.includes("already exists")) {
        result.skipped.push(name);
      } else {
        result.errors.push({ name, reason: addResult.message });
      }
    } catch (err) {
      result.errors.push({ name, reason: String(err) });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// MCP Registry — discover and install MCP servers dynamically
// ---------------------------------------------------------------------------

/** Well-known MCP server registry entries bundled with Pakalon. */
const BUILTIN_MCP_REGISTRY: McpRegistryEntry[] = [
  { name: "filesystem", package: "@modelcontextprotocol/server-filesystem", description: "File system operations (read, write, search)", transport: "stdio", tags: ["files", "core"] },
  { name: "memory", package: "@modelcontextprotocol/server-memory", description: "Persistent key-value memory across sessions", transport: "stdio", tags: ["memory", "core"] },
  { name: "fetch", package: "@modelcontextprotocol/server-fetch", description: "HTTP fetch and web scraping", transport: "stdio", tags: ["web", "http"] },
  { name: "brave-search", package: "@modelcontextprotocol/server-brave-search", description: "Brave Search integration for web search", transport: "stdio", tags: ["search", "web"] },
  { name: "github", package: "@modelcontextprotocol/server-github", description: "GitHub API integration (repos, issues, PRs)", transport: "stdio", tags: ["github", "vcs"] },
  { name: "gitlab", package: "@modelcontextprotocol/server-gitlab", description: "GitLab API integration", transport: "stdio", tags: ["gitlab", "vcs"] },
  { name: "postgres", package: "@modelcontextprotocol/server-postgres", description: "PostgreSQL database access", transport: "stdio", tags: ["database", "sql"] },
  { name: "sqlite", package: "@modelcontextprotocol/server-sqlite", description: "SQLite database access", transport: "stdio", tags: ["database", "sql"] },
  { name: "slack", package: "@modelcontextprotocol/server-slack", description: "Slack messaging and channel management", transport: "stdio", tags: ["chat", "slack"] },
  { name: "puppeteer", package: "@modelcontextprotocol/server-puppeteer", description: "Browser automation via Puppeteer", transport: "stdio", tags: ["browser", "automation"] },
  { name: "everything", package: "@modelcontextprotocol/server-everything", description: "All example MCP features in one server (for testing)", transport: "stdio", tags: ["testing"] },
  { name: "sequential-thinking", package: "@modelcontextprotocol/server-sequential-thinking", description: "Structured multi-step reasoning", transport: "stdio", tags: ["reasoning", "ai"] },
  { name: "firecrawl", package: "mcp-server-firecrawl", description: "Firecrawl web scraping and data extraction", transport: "sse", tags: ["web", "scraping"] },
  { name: "exa", package: "exa-mcp-server", description: "Exa AI search engine", transport: "sse", tags: ["search", "ai"] },
  { name: "context7", package: "@upstash/context7-mcp", description: "Up-to-date library docs and code examples for any npm/PyPI package", transport: "stdio", tags: ["docs", "context", "libraries"] },
  { name: "notion", package: "@notionhq/notion-mcp-server", description: "Read/write Notion pages and databases", transport: "sse", url: "https://api.notion.com/v1/mcp", requiresApiKey: "NOTION_API_KEY", tags: ["notion", "docs", "enterprise"] },
  { name: "jira", package: "@atlassianlabs/jira-mcp-server", description: "Create and manage Jira issues (Cloud and Server/DC)", transport: "sse", requiresApiKey: "JIRA_API_TOKEN", tags: ["jira", "issues", "enterprise"] },

  // === HTTP Transport Servers (Remote MCP Apps) ===
  { name: "supabase", package: "@supabase/mcp-server-supabase", description: "Supabase: Database, auth, storage, realtime", transport: "http", url: "https://mcp.supabase.com/mcp", requiresApiKey: "SUPABASE_SERVICE_KEY", tags: ["database", "auth", "backend", "enterprise"] },
  { name: "stripe", package: "@stripe/mcp-server", description: "Stripe: Payments, subscriptions, invoices", transport: "http", url: "https://mcp.stripe.com", requiresApiKey: "STRIPE_SECRET_KEY", tags: ["payments", "billing", "enterprise"] },
  { name: "figma-mcp", package: "@figma/mcp-server", description: "Figma: Design-to-code, tokens, FigJam", transport: "http", url: "https://mcp.figma.com/mcp", requiresApiKey: "FIGMA_ACCESS_TOKEN", tags: ["design", "figma", "ui"] },
  { name: "monday", package: "@mondaycom/mcp-server", description: "Monday.com: Boards, items, projects", transport: "http", url: "https://mcp.monday.com/mcp", requiresApiKey: "MONDAY_API_KEY", tags: ["project", "management", "enterprise"] },
  { name: "asana", package: "@asana/mcp-server", description: "Asana: Projects, tasks, timelines", transport: "http", url: "https://mcp.asana.com/mcp", requiresApiKey: "ASANA_ACCESS_TOKEN", tags: ["project", "management", "enterprise"] },
  { name: "salesforce", package: "@salesforce/mcp-server", description: "Salesforce: CRM, leads, opportunities", transport: "http", url: "https://mcp.salesforce.com/mcp", requiresApiKey: "SF_ACCESS_TOKEN", tags: ["crm", "enterprise"] },
  { name: "amplitude", package: "@amplitude/mcp-server", description: "Amplitude: Product analytics, user journeys", transport: "http", url: "https://mcp.amplitude.com/mcp", requiresApiKey: "AMPLITUDE_API_KEY", tags: ["analytics", "enterprise"] },
  { name: "box", package: "@box/mcp-server", description: "Box: Enterprise file storage", transport: "http", url: "https://mcp.box.com/mcp", requiresApiKey: "BOX_ACCESS_TOKEN", tags: ["storage", "enterprise"] },
  { name: "clay", package: "@clay/mcp-server", description: "Clay: Data enrichment, lead lists", transport: "http", url: "https://mcp.clay.com/mcp", requiresApiKey: "CLAY_API_KEY", tags: ["data", "enterprise"] },
  { name: "hex", package: "@hex/mcp-server", description: "Hex: Data notebooks, analytics", transport: "http", url: "https://mcp.hex.tech/mcp", requiresApiKey: "HEX_API_KEY", tags: ["analytics", "data"] },
  { name: "paypal", package: "@paypal/mcp-server", description: "PayPal: Invoices, payments", transport: "http", url: "https://mcp.paypal.com/http", requiresApiKey: "PAYPAL_CLIENT_ID", tags: ["payments", "enterprise"] },
  { name: "context7-mcp", package: "@context7/mcp-server", description: "Context7: Live library docs for npm/PyPI", transport: "http", url: "https://mcp.context7.com/mcp", tags: ["docs", "libraries", "ai"] },
  { name: "ahrefs", package: "@ahrefs/mcp-server", description: "Ahrefs: Backlinks, keywords, SEO", transport: "http", url: "https://api.ahrefs.com/mcp/mcp", requiresApiKey: "AHREFS_API_KEY", tags: ["seo", "marketing"] },
  { name: "semrush", package: "@semrush/mcp-server", description: "Semrush: SEO data, traffic", transport: "http", url: "https://mcp.semrush.com/v1/mcp", requiresApiKey: "SEMRUSH_API_KEY", tags: ["seo", "marketing"] },

  // === Additional STDIO Servers ===
  { name: "mongodb", package: "@modelcontextprotocol/server-mongodb", description: "MongoDB document database integration", transport: "stdio", tags: ["database", "nosql"] },
  { name: "mysql", package: "@modelcontextprotocol/server-mysql", description: "MySQL database access", transport: "stdio", tags: ["database", "sql"] },
  { name: "redis", package: "@modelcontextprotocol/server-redis", description: "Redis caching and data structures", transport: "stdio", tags: ["database", "cache"] },
  { name: "clickhouse", package: "@modelcontextprotocol/server-clickhouse", description: "ClickHouse analytical database", transport: "stdio", tags: ["database", "analytics"] },
  { name: "aws-kb", package: "@modelcontextprotocol/server-aws-kb", description: "AWS Knowledge Base retrieval", transport: "stdio", tags: ["aws", "ai", "rag"] },
  { name: "s3", package: "@modelcontextprotocol/server-s3", description: "AWS S3 file operations", transport: "stdio", tags: ["aws", "storage"] },
  { name: "docker", package: "@modelcontextprotocol/server-docker", description: "Docker container management", transport: "stdio", tags: ["devops", "containers"] },
  { name: "kubernetes", package: "@modelcontextprotocol/server-kubernetes", description: "Kubernetes cluster management", transport: "stdio", tags: ["devops", "containers"] },
  { name: "gitlab-ci", package: "@modelcontextprotocol/server-gitlab-ci", description: "GitLab CI/CD integration", transport: "stdio", tags: ["ci/cd", "devops"] },
  { name: "linear", package: "@modelcontextprotocol/server-linear", description: "Linear issue tracking and projects", transport: "stdio", tags: ["issues", "project"] },
  { name: "hubspot", package: "@modelcontextprotocol/server-hubspot", description: "HubSpot CRM contacts and deals", transport: "stdio", tags: ["crm", "enterprise"] },
  { name: "google-drive", package: "@modelcontextprotocol/server-google-drive", description: "Google Drive file access", transport: "stdio", tags: ["storage", "google"] },
  { name: "google-calendar", package: "@modelcontextprotocol/server-google-calendar", description: "Google Calendar events", transport: "stdio", tags: ["calendar", "google"] },
  { name: "google-analytics", package: "@modelcontextprotocol/server-google-analytics", description: "Google Analytics data", transport: "stdio", tags: ["analytics", "google"] },
  { name: "cloudflare", package: "@modelcontextprotocol/server-cloudflare", description: "Cloudflare Workers, KV, R2, DNS", transport: "stdio", tags: ["cloud", "devops"] },
  { name: "vercel", package: "@modelcontextprotocol/server-vercel", description: "Vercel deployments, logs, envs", transport: "stdio", tags: ["cloud", "deploy"] },
  { name: "puppeteer-extended", package: "@modelcontextprotocol/server-puppeteer", description: "Extended Puppeteer browser automation", transport: "stdio", tags: ["browser", "automation", "testing"] },
  { name: "playwright", package: "@playwright/mcp-server", description: "Playwright browser automation (12K+ stars)", transport: "stdio", tags: ["browser", "testing", "automation"] },
  { name: "sentry", package: "@sentry/mcp-server", description: "Sentry error tracking and monitoring", transport: "stdio", tags: ["monitoring", "errors"] },
  { name: "newrelic", package: "@newrelic/mcp-server", description: "New Relic observability", transport: "stdio", tags: ["monitoring", "analytics"] },
  { name: "datadog", package: "@datadog/mcp-server", description: "Datadog monitoring and logs", transport: "stdio", tags: ["monitoring", "devops"] },
  { name: "postgres-direct", package: "@t3/mcp-server-postgres", description: "PostgreSQL direct queries", transport: "stdio", tags: ["database", "sql"] },
  { name: "sqlite-direct", package: "@t3/mcp-server-sqlite", description: "SQLite direct file access", transport: "stdio", tags: ["database", "sql"] },
  { name: "elasticsearch", package: "@elastic/mcp-server", description: "Elasticsearch search engine", transport: "stdio", tags: ["database", "search"] },
  { name: "qdrant", package: "@qdrant/mcp-server", description: "Qdrant vector database for RAG", transport: "stdio", tags: ["database", "ai", "vector"] },
  { name: "weaviate", package: "@weaviate/mcp-server", description: "Weaviate vector database", transport: "stdio", tags: ["database", "ai", "vector"] },
  { name: "pinecone", package: "@pinecone/mcp-server", description: "Pinecone vector database", transport: "stdio", tags: ["database", "ai", "vector"] },
  { name: "anthropic-memory", package: "@anthropic-ai/mcp-server-memory", description: "Anthropic Memory - persistent knowledge graph", transport: "http", url: "https://api.anthropic.com/v1/memory", tags: ["memory", "ai"] },
  { name: "perplexity", package: "@perplexity/mcp-server", description: "Perplexity AI-powered search with citations", transport: "http", url: "https://mcp.perplexity.com", requiresApiKey: "PERPLEXITY_API_KEY", tags: ["search", "ai"] },
  { name: "tavily", package: "@tavily/mcp-server", description: "Tavily search API for AI agents", transport: "stdio", tags: ["search", "ai"] },
  { name: "zapier", package: "@zapier/mcp-server", description: "Zapier - 7000+ app integrations", transport: "http", url: "https://mcp.zapier.com", requiresApiKey: "ZAPIER_API_KEY", tags: ["automation", "enterprise"] },
  { name: "n8n", package: "@n8n/mcp-server", description: "n8n self-hosted workflow automation", transport: "stdio", tags: ["automation", "workflows"] },
  { name: "canva", package: "@canva/mcp-server", description: "Canva design creation and templates", transport: "http", url: "https://mcp.canva.com", requiresApiKey: "CANVA_API_KEY", tags: ["design", "creative"] },
  { name: "elevenlabs", package: "@elevenlabs/mcp-server", description: "ElevenLabs text-to-speech and voice cloning", transport: "http", url: "https://mcp.elevenlabs.io", requiresApiKey: "ELEVENLABS_API_KEY", tags: ["audio", "ai"] },
  { name: "apify", package: "@apify/mcp-server", description: "Apify web scraping and automation", transport: "stdio", tags: ["scraping", "automation"] },
  { name: "scrape-it", package: "@scrape-it/mcp-server", description: "Simple web scraping server", transport: "stdio", tags: ["scraping", "web"] },
  { name: "openapi", package: "@modelcontextprotocol/server-openapi", description: "Connect to any OpenAPI spec", transport: "stdio", tags: ["api", "integration"] },
  { name: "apidog", package: "@apidog/mcp-server", description: "Access API specs from OpenAPI definitions", transport: "stdio", tags: ["api", "docs"] },
  { name: "filesystem-granular", package: "@modelcontextprotocol/server-filesystem", description: "Granular file permissions", transport: "stdio", tags: ["files", "security"] },
  { name: "github-issues", package: "@modelcontextprotocol/server-github", description: "GitHub issues and PRs", transport: "stdio", tags: ["github", "vcs"] },
  { name: "slack-extended", package: "@modelcontextprotocol/server-slack", description: "Slack extended - messages, channels, search", transport: "stdio", tags: ["chat", "slack"] },
  { name: "twitter", package: "@twitter/mcp-server", description: "Twitter/X API integration", transport: "stdio", tags: ["social", "api"] },
  { name: "telegram", package: "@telegram/mcp-server", description: "Telegram bot messaging", transport: "stdio", tags: ["chat", "bot"] },
  { name: "discord", package: "@discord/mcp-server", description: "Discord bot and server management", transport: "stdio", tags: ["chat", "bot"] },
  { name: "notion-extended", package: "@notionhq/notion-mcp-server", description: "Extended Notion - pages, databases, comments", transport: "sse", url: "https://api.notion.com/v1/mcp", requiresApiKey: "NOTION_API_KEY", tags: ["docs", "enterprise"] },
  { name: "confluence", package: "@atlassian/mcp-server-confluence", description: "Atlassian Confluence documentation", transport: "sse", url: "https://api.atlassian.com", requiresApiKey: "CONFLUENCE_API_KEY", tags: ["docs", "enterprise"] },
];

export interface McpRegistryEntry {
  name: string;
  package: string;       // npm package name
  description: string;
  transport: "http" | "sse" | "stdio";
  tags?: string[];
  url?: string;          // For SSE servers, the default URL
  requiresApiKey?: string; // env var name for required API key
  version?: string;
  installedAt?: string;
  installedVersion?: string;
}

interface McpInstallRecord {
  entries: McpRegistryEntry[];
  lastUpdated: string;
}

function installRecordPath(): string {
  return path.join(os.homedir(), ".config", "pakalon", "mcp-installed.json");
}

function readInstallRecord(): McpInstallRecord {
  try {
    return JSON.parse(fs.readFileSync(installRecordPath(), "utf-8")) as McpInstallRecord;
  } catch {
    return { entries: [], lastUpdated: "" };
  }
}

function writeInstallRecord(record: McpInstallRecord): void {
  const p = installRecordPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2), "utf-8");
}

/**
 * Discover available MCP servers from the built-in registry or a remote URL.
 * Optional `query` filters by name/description/tags.
 */
export async function discoverMcpServers(
  query?: string,
  remoteRegistryUrl?: string
): Promise<McpRegistryEntry[]> {
  let entries = [...BUILTIN_MCP_REGISTRY];

  // Optionally fetch remote registry
  if (remoteRegistryUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(remoteRegistryUrl, { signal: controller.signal }).catch(() => null);
      clearTimeout(timer);
      if (resp?.ok) {
        const remote = (await resp.json()) as McpRegistryEntry[];
        if (Array.isArray(remote)) {
          // Merge — remote entries override built-in ones with same name
          const builtinNames = new Set(entries.map((e) => e.name));
          for (const re of remote) {
            if (builtinNames.has(re.name)) {
              entries = entries.map((e) => (e.name === re.name ? { ...e, ...re } : e));
            } else {
              entries.push(re);
            }
          }
        }
      }
    } catch {
      // Remote registry unavailable — use built-in only
    }
  }

  // Filter by query
  if (query) {
    const q = query.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }

  // Mark which ones are already installed
  const installed = readInstallRecord().entries;
  return entries.map((e) => ({
    ...e,
    installedVersion: installed.find((i) => i.name === e.name)?.installedVersion,
  }));
}

/**
 * Install an MCP server from npm and register it in Pakalon's config.
 *
 * For stdio transport: installs the npm package globally and registers it.
 * For sse transport: registers the URL without installing anything.
 */
export async function installMcpServer(
  nameOrPackage: string,
  scope: McpScope = "global",
  options: { cwd?: string; url?: string; force?: boolean } = {}
): Promise<{ ok: boolean; message: string; serverConfig?: McpServerConfig }> {
  // Resolve from registry first
  const all = await discoverMcpServers();
  const registryEntry =
    all.find((e) => e.name === nameOrPackage) ??
    all.find((e) => e.package === nameOrPackage) ??
    // Allow raw npm package names not in registry
    { name: nameOrPackage.replace(/^@[^/]+\//, "").replace(/^mcp-server-/, ""), package: nameOrPackage, description: "", transport: "stdio" as const };

  const serverName = registryEntry.name;

  // Check if already added
  const existing = getMcpServer(serverName, options.cwd);
  if (existing && !options.force) {
    return { ok: false, message: `MCP server "${serverName}" is already installed. Use --force to reinstall.` };
  }

  let serverUrl = options.url ?? registryEntry.url ?? "";

  if (registryEntry.transport === "stdio" || !serverUrl) {
    // Install npm package
    const pkg = registryEntry.package;
    debugLog(`[mcp] Installing npm package: ${pkg}`);
    try {
      const { execSync: _exec } = await import("child_process");
      _exec(`npm install -g ${pkg}`, { stdio: "pipe", timeout: 120_000 });

      // Get installed version
      let installedVersion = "latest";
      try {
        installedVersion = _exec(`npm list -g ${pkg} --json`, { stdio: "pipe" })
          .toString()
          .match(/"version":\s*"([^"]+)"/)?.[1] ?? "latest";
      } catch { /* ignore */ }

      // For stdio servers, URL convention is the package name + --stdio flag
      serverUrl = `npx ${pkg}`;

      // Record installation
      const record = readInstallRecord();
      const idx = record.entries.findIndex((e) => e.name === serverName);
      const installEntry: McpRegistryEntry = {
        ...registryEntry,
        installedAt: new Date().toISOString(),
        installedVersion,
      };
      if (idx >= 0) {
        record.entries[idx] = installEntry;
      } else {
        record.entries.push(installEntry);
      }
      writeInstallRecord(record);
    } catch (err: unknown) {
      const e = err as { message?: string; stderr?: Buffer };
      return {
        ok: false,
        message: `Failed to install ${pkg}: ${e.message ?? String(err)}\n` +
          (e.stderr ? `Stderr: ${e.stderr.toString().slice(0, 300)}` : ""),
      };
    }
  }

  // Normalize transport — McpServerConfig only stores 'sse' | 'stdio'; 'http' = 'sse'
  const configTransport: "sse" | "stdio" = registryEntry.transport === "stdio" ? "stdio" : "sse";

  // Register in Pakalon MCP config
  const addResult = await addMcpServer(serverName, serverUrl, scope, {
    description: registryEntry.description || `Installed from ${registryEntry.package}`,
    transport: configTransport,
    cwd: options.cwd,
    skipConnCheck: configTransport === "stdio",  // stdio servers don't expose HTTP
  });

  if (!addResult.ok && !options.force) {
    return addResult;
  }

  const serverConfig: McpServerConfig = {
    name: serverName,
    url: serverUrl,
    description: registryEntry.description,
    transport: configTransport,
    addedAt: new Date().toISOString(),
    enabled: true,
  };

  return {
    ok: true,
    message: `✅ Installed and registered MCP server "${serverName}" (${registryEntry.transport}).\n` +
      (registryEntry.requiresApiKey ? `  ⚠️  Requires API key: ${registryEntry.requiresApiKey}` : ""),
    serverConfig,
  };
}

/**
 * Uninstall an MCP server: removes from config AND optionally uninstalls the npm package.
 */
export async function uninstallMcpServer(
  name: string,
  scope: McpScope = "global",
  options: { cwd?: string; removePackage?: boolean } = {}
): Promise<{ ok: boolean; message: string }> {
  const entry = getMcpServer(name, options.cwd);
  if (!entry) {
    return { ok: false, message: `MCP server "${name}" not found.` };
  }

  // Remove from config
  const removeResult = removeMcpServer(name, scope, options.cwd);
  if (!removeResult.ok) return removeResult;

  // Optionally uninstall npm package
  if (options.removePackage) {
    const record = readInstallRecord();
    const installed = record.entries.find((e) => e.name === name);
    if (installed?.package) {
      try {
        const { execSync: _exec } = await import("child_process");
        _exec(`npm uninstall -g ${installed.package}`, { stdio: "pipe", timeout: 60_000 });
        record.entries = record.entries.filter((e) => e.name !== name);
        writeInstallRecord(record);
      } catch {
        /* ignore uninstall errors */
      }
    }
  }

  return { ok: true, message: `Uninstalled MCP server "${name}" from ${scope} config.` };
}

// ---------------------------------------------------------------------------
// Tool cache — prevent repeated /tools/list calls to the same server
// ---------------------------------------------------------------------------

interface ToolCacheEntry {
  tools: unknown[];
  fetchedAt: number;
  ttlMs: number;
}

const _toolCache = new Map<string, ToolCacheEntry>();
const DEFAULT_TOOL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch tools from an MCP server with in-memory caching.
 * Subsequent calls within TTL return the cached result.
 */
export async function getCachedMcpTools(
  serverUrl: string,
  ttlMs = DEFAULT_TOOL_CACHE_TTL
): Promise<unknown[]> {
  const now = Date.now();
  const cached = _toolCache.get(serverUrl);
  if (cached && now - cached.fetchedAt < cached.ttlMs) {
    debugLog(`[mcp-cache] Hit for ${serverUrl} (age: ${Math.round((now - cached.fetchedAt) / 1000)}s)`);
    return cached.tools;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(`${serverUrl}/tools/list`, { signal: controller.signal }).catch(() => null);
    clearTimeout(timer);

    if (resp?.ok) {
      const data = await resp.json() as { tools?: unknown[] };
      const tools = data?.tools ?? [];
      _toolCache.set(serverUrl, { tools, fetchedAt: now, ttlMs });
      debugLog(`[mcp-cache] Cached ${tools.length} tools from ${serverUrl}`);
      return tools;
    }
  } catch {
    /* server not reachable */
  }
  return [];
}

/**
 * Invalidate the tool cache for a specific server (or all servers).
 */
export function invalidateMcpToolCache(serverUrl?: string): void {
  if (serverUrl) {
    _toolCache.delete(serverUrl);
  } else {
    _toolCache.clear();
  }
}

/**
 * Handle dynamic MCP install from chat: "install mcp <name>" or "/mcp install <name>"
 */
export async function handleMcpInstallCommand(
  input: string,
  cwd?: string
): Promise<string> {
  // Match: "install mcp <name>" or "/mcp install <name>" or "@mcp install <name>"
  const match = input.match(/(?:install\s+mcp|mcp\s+install|@mcp\s+install)\s+([^\s]+)/i);
  if (!match?.[1]) {
    return "Usage: /mcp install <name-or-package>\nExample: /mcp install github";
  }
  const nameOrPkg = match[1];
  const result = await installMcpServer(nameOrPkg, "global", { cwd });
  return result.message;
}

// ============================================================================
// T-A22: OAuth 2.0 helpers
// ============================================================================

/**
 * Check if an MCP server requires OAuth authentication
 */
export function serverRequiresOAuth(serverName: string): boolean {
  const server = getMcpServer(serverName);
  return server?.authType === "oauth";
}

/**
 * Get OAuth authorization URL for a server that requires OAuth
 */
export function getOAuthUrl(serverName: string): string | null {
  const server = getMcpServer(serverName);
  if (!server || server.authType !== "oauth") return null;
  return generateOAuthUrl(server);
}

/**
 * Complete OAuth flow for an MCP server
 */
export async function completeServerOAuth(serverName: string, authCode: string): Promise<boolean> {
  const server = getMcpServer(serverName);
  if (!server) return false;
  const result = await completeOAuthFlow(server, authCode);
  return result.success;
}

/**
 * Get valid access token for OAuth-enabled server
 */
export async function getServerAccessToken(serverName: string): Promise<string | null> {
  const server = getMcpServer(serverName);
  if (!server) return null;
  return getValidAccessToken(server);
}

// ============================================================================
// T-A23: @resource mention support
// ============================================================================

/**
 * Get all resources from all MCP servers
 */
export async function getMcpResources(): Promise<Array<{ server: string; resources: unknown[] }>> {
  return getAllResources();
}

/**
 * Search resources across all MCP servers
 */
export async function searchMcpResources(query: string): Promise<unknown[]> {
  return searchResources(query);
}

/**
 * Parse @resource mention from input
 */
export function parseResourceMention(input: string): { resourceUri: string; rest: string } | null {
  // Match @server://resource-uri or @server:resource-uri
  const match = input.match(/@(\w+):(\/\/[^\s]+|\/[^\s]+)/);
  if (!match) return null;
  return { resourceUri: match[1] + ":" + match[2], rest: input.slice(match[0].length) };
}

// ============================================================================
// T-A24: MCP prompts as slash commands
// ============================================================================

/**
 * Parse MCP prompt command from input
 * Format: /mcp__servername__promptname [args]
 */
export function parseMcpPrompt(input: string): { server: string; prompt: string; args: string } | null {
  const parsed = parseMcpPromptCommand(input);
  if (!parsed) return null;
  return { server: parsed.server, prompt: parsed.prompt, args: parsed.args ?? "" };
}

/**
 * Execute an MCP prompt.
 * args can be a raw string (e.g. "key=value key2=value2") or left undefined.
 * The string is split on spaces and each token that contains "=" is treated as
 * a key=value pair; bare tokens are passed as "input" key.
 */
export async function runMcpPrompt(serverName: string, promptName: string, args?: string): Promise<unknown> {
  let argsRecord: Record<string, string> | undefined;
  if (args && args.trim()) {
    argsRecord = {};
    const tokens = args.trim().split(/\s+/);
    const positional: string[] = [];
    for (const tok of tokens) {
      const eqIdx = tok.indexOf("=");
      if (eqIdx > 0) {
        argsRecord[tok.slice(0, eqIdx)] = tok.slice(eqIdx + 1);
      } else {
        positional.push(tok);
      }
    }
    if (positional.length > 0) argsRecord["input"] = positional.join(" ");
    if (Object.keys(argsRecord).length === 0) argsRecord = undefined;
  }
  return executeMcpPrompt(serverName, promptName, argsRecord);
}

/**
 * Get all available MCP prompt slash-command names from all registered servers.
 * Returns list formatted as "/mcp__server__prompt" strings.
 */
export function getMcpPromptCommands(): string[] {
  const servers = listMcpServers();
  if (!servers.length) return [];
  // We can only enumerate prompts that have been registered via registerPromptProvider.
  // For each server we expose the server name as a prefix so users can discover them.
  // Actual prompt names are discovered on first use via the prompt provider.
  return servers
    .filter((s) => s.enabled !== false)
    .map((s) => `/mcp__${s.name}__`);
}
