/**
 * MCP Tools Loader — discovers tools from configured MCP servers and
 * converts them to Vercel AI SDK-compatible tool definitions.
 *
 * Supports SSE, HTTP, and stdio transports.
 * For stdio servers (e.g. `npx @modelcontextprotocol/server-filesystem`),
 * connections are pooled per-process so subprocesses stay alive for the
 * CLI session and are closed on process exit.
 */
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { listMcpServers, type McpServerConfig, type McpScope } from "./manager.js";
import logger from "@/utils/logger.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ---------------------------------------------------------------------------
// Stdio connection pool — one Client per server name, kept alive for session
// ---------------------------------------------------------------------------

interface StdioPoolEntry {
  client: Client;
  transport: StdioClientTransport;
}

const _stdioPool = new Map<string, StdioPoolEntry>();

process.on("exit", () => {
  for (const { client } of _stdioPool.values()) {
    try { client.close(); } catch { /* ignore */ }
  }
});

/**
 * Parse a stdio command string like "npx @modelcontextprotocol/server-filesystem /path"
 * into { command, args }.
 */
function parseStdioCommand(cmdStr: string): { command: string; args: string[] } {
  const parts = cmdStr.trim().split(/\s+/);
  const command = parts[0]!;
  const rest = parts.slice(1);
  // When command is "npx", ensure -y flag is included to skip interactive prompts
  if (command === "npx" && !rest.includes("-y")) {
    return { command, args: ["-y", ...rest] };
  }
  return { command, args: rest };
}

/**
 * Get (or create) a connected stdio MCP client for the given server.
 * Connection is cached in _stdioPool for the lifetime of the process.
 */
async function getStdioClient(server: McpServerConfig): Promise<Client> {
  const existing = _stdioPool.get(server.name);
  if (existing) return existing.client;

  const { command, args } = parseStdioCommand(server.url);
  const transport = new StdioClientTransport({ command, args });
  const client = new Client(
    { name: "pakalon-cli", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  await client.connect(transport);
  _stdioPool.set(server.name, { client, transport });
  logger.debug(`[mcp/stdio] Connected to stdio server "${server.name}" via: ${command} ${args.join(" ")}`);
  return client;
}

/**
 * Fetch tool definitions from a stdio MCP server using the SDK client.
 */
async function fetchStdioMcpTools(server: McpServerConfig): Promise<McpToolDefinition[]> {
  try {
    const client = await getStdioClient(server);
    const response = await client.listTools();
    return (response.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as McpToolDefinition["inputSchema"],
    }));
  } catch (err) {
    logger.warn(`[mcp/stdio] Failed to list tools from stdio server "${server.name}": ${err}`);
    return [];
  }
}

/**
 * Call a tool on a stdio MCP server.
 */
async function callStdioMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = await getStdioClient(server);
  const response = await client.callTool({ name: toolName, arguments: args });
  const content = (response.content ?? []) as Array<{ type: string; text?: string }>;
  if (content.length === 1 && content[0]?.type === "text") {
    return content[0]?.text;
  }
  return content;
}

// ---------------------------------------------------------------------------
// MCP protocol types (JSON-RPC over SSE / HTTP)
// ---------------------------------------------------------------------------

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

interface McpListToolsResponse {
  tools: McpToolDefinition[];
}

// ---------------------------------------------------------------------------
// Schema builder — converts JSON Schema (MCP) → Zod schema (AI SDK)
// ---------------------------------------------------------------------------

type ZodShape = Record<string, z.ZodTypeAny>;

function jsonSchemaToZod(schema: McpToolDefinition["inputSchema"]): z.ZodObject<ZodShape> {
  if (!schema?.properties) return z.object({});

  const shape: ZodShape = {};
  const required = new Set(schema.required ?? []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    let fieldSchema: z.ZodTypeAny;

    if (prop.enum) {
      fieldSchema = z.enum(prop.enum as [string, ...string[]]);
    } else {
      switch (prop.type) {
        case "number":
        case "integer":
          fieldSchema = z.number();
          break;
        case "boolean":
          fieldSchema = z.boolean();
          break;
        case "array":
          fieldSchema = z.array(z.unknown());
          break;
        case "object":
          fieldSchema = z.record(z.unknown());
          break;
        default:
          fieldSchema = z.string();
      }
    }

    if (prop.description) {
      fieldSchema = fieldSchema.describe(prop.description);
    }

    shape[key] = required.has(key) ? fieldSchema : fieldSchema.optional();
  }

  return z.object(shape);
}

// ---------------------------------------------------------------------------
// Fetch tools list from an MCP server (SSE, HTTP, or stdio)
// ---------------------------------------------------------------------------

async function fetchMcpTools(server: McpServerConfig): Promise<McpToolDefinition[]> {
  // Dispatch to stdio handler for locally-spawned servers
  if (server.transport === "stdio") {
    return fetchStdioMcpTools(server);
  }

  const url = server.url.replace(/\/$/, "");
  const listUrl = `${url}/tools/list`;

  try {
    const res = await fetch(listUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = (await res.json()) as { result?: McpListToolsResponse; tools?: McpToolDefinition[] };
    return json.result?.tools ?? (json as { tools?: McpToolDefinition[] }).tools ?? [];
  } catch (err) {
    logger.warn(`[mcp/tools] Failed to list tools from ${server.name} (${listUrl}): ${err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Call a tool on an MCP server
// ---------------------------------------------------------------------------

async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Dispatch to stdio handler for locally-spawned servers
  if (server.transport === "stdio") {
    return callStdioMcpTool(server, toolName, args);
  }

  const url = server.url.replace(/\/$/, "");
  const callUrl = `${url}/tools/call`;

  const res = await fetch(callUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`MCP call HTTP ${res.status}`);

  const json = (await res.json()) as {
    result?: { content?: Array<{ type: string; text?: string }> };
    error?: { message: string };
  };

  if (json.error) throw new Error(`MCP error: ${json.error.message}`);

  // Flatten content array to a string/object
  const content = json.result?.content ?? [];
  if (content.length === 1 && content[0]?.type === "text") {
    return content[0]?.text;
  }
  return content;
}

// ---------------------------------------------------------------------------
// MCP Tool Cache — TTL-based with config-change invalidation
// ---------------------------------------------------------------------------

interface McpToolCacheEntry {
  tools: ToolSet;
  serverCount: number;
  toolCount: number;
  /** Unix timestamp when this entry was written */
  cachedAt: number;
  /** Hash of the serialised server list at time of cache */
  configHash: string;
}

/** Cache TTL in ms (default 5 minutes — re-fetch if MCP server tools change) */
const CACHE_TTL_MS = 5 * 60 * 1000;

let _mcpToolCache: McpToolCacheEntry | null = null;

/**
 * Quick hash of current server config — used to detect config changes.
 * If the server list changes (add/remove/edit), the cache is invalidated.
 */
function _hashServers(servers: McpServerConfig[]): string {
  return servers.map((s) => `${s.name}|${s.url}|${s.enabled ?? true}`).join(",");
}

/**
 * Explicitly invalidate the cached MCP tools.
 * Call this after `addMcpServer` / `removeMcpServer` / `enableMcpServer` / `disableMcpServer`.
 */
export function invalidateMcpToolCache(): void {
  _mcpToolCache = null;
  logger.debug("[mcp/tools] Tool cache invalidated");
}

/**
 * Return cached MCP tools if fresh and config hasn't changed, otherwise null.
 */
export function getCachedMcpTools(servers: McpServerConfig[]): McpToolCacheEntry | null {
  if (!_mcpToolCache) return null;
  const now = Date.now();
  if (now - _mcpToolCache.cachedAt > CACHE_TTL_MS) {
    _mcpToolCache = null;
    logger.debug("[mcp/tools] Cache expired (TTL reached)");
    return null;
  }
  if (_mcpToolCache.configHash !== _hashServers(servers)) {
    _mcpToolCache = null;
    logger.debug("[mcp/tools] Cache invalidated (config change)");
    return null;
  }
  return _mcpToolCache;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadedMcpTools {
  tools: ToolSet;
  serverCount: number;
  toolCount: number;
}

/**
 * Load all configured MCP servers and return their tools as Vercel AI SDK tools.
 * Each tool is namespaced as `{serverName}__{toolName}`.
 *
 * Results are cached for `CACHE_TTL_MS` ms and auto-invalidated when the
 * server config changes (add/remove/enable/disable).
 *
 * @param cwd — project root (for resolving project-scope MCP config)
 * @param extraServerUrls — ad-hoc URL list from --MCP flag
 */
export async function loadMcpTools(cwd?: string, extraServerUrls: string[] = []): Promise<LoadedMcpTools> {
  const servers = listMcpServers(cwd);

  // Merge in --MCP flag servers (ad-hoc URLs, use URL hostname as name)
  for (const url of extraServerUrls) {
    try {
      const hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9]/g, "_");
      servers.push({ name: hostname, url, transport: "sse", scope: "global" });
    } catch {
      logger.warn(`[mcp/tools] Skipping invalid MCP URL: ${url}`);
    }
  }

  // Return from cache if fresh
  const cached = getCachedMcpTools(servers);
  if (cached) {
    logger.debug("[mcp/tools] Returning cached tools", { toolCount: cached.toolCount });
    return { tools: cached.tools, serverCount: cached.serverCount, toolCount: cached.toolCount };
  }

  const result: ToolSet = {};
  let serverCount = 0;

  for (const server of servers) {
    const toolDefs = await fetchMcpTools(server);
    if (!toolDefs.length) continue;

    serverCount++;
    for (const def of toolDefs) {
      const fullName = `${server.name}__${def.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
      const schema = jsonSchemaToZod(def.inputSchema);

      result[fullName] = tool({
        description: def.description
          ? `[${server.name}] ${def.description}`
          : `Tool '${def.name}' from MCP server '${server.name}'`,
        inputSchema: schema,
        execute: async (args: Record<string, unknown>) => {
          try {
            return await callMcpTool(server, def.name, args as Record<string, unknown>);
          } catch (err) {
            logger.error(`[mcp/tools] Error calling ${def.name} on ${server.name}`, { err: String(err) });
            return { error: String(err) };
          }
        },
      });
    }
  }

  // Store in cache
  _mcpToolCache = {
    tools: result,
    serverCount,
    toolCount: Object.keys(result).length,
    cachedAt: Date.now(),
    configHash: _hashServers(servers),
  };
  logger.debug("[mcp/tools] Cached fresh MCP tools", { toolCount: _mcpToolCache.toolCount });

  return { tools: result, serverCount, toolCount: Object.keys(result).length };
}
