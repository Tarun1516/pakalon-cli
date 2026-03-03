/**
 * MCP Advanced Features — OAuth 2.0, list_changed, @resource, prompts
 * ─────────────────────────────────────────────────────────────────────────
 * 
 * T-A25: OAuth 2.0 authorization code flow for remote MCP servers
 * T-A26: list_changed dynamic tool notification
 * T-A27: @resource mention autocomplete
 * T-A28: MCP prompts as /mcp__server__prompt commands
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import logger from "@/utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────
// OAuth 2.0 Types (T-A25)
// ─────────────────────────────────────────────────────────────────────────

export interface OAuthConfig {
  /** OAuth server URL */
  authUrl: string;
  /** Token endpoint */
  tokenUrl: string;
  /** Client ID */
  clientId: string;
  /** Client secret (stored securely) */
  clientSecret?: string;
  /** Scopes to request */
  scopes?: string[];
  /** Redirect URI */
  redirectUri: string;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
}

export interface McpServerWithOAuth extends McpServerConfig {
  auth?: OAuthConfig;
  token?: OAuthToken;
}

// Extended McpServerConfig from manager.ts
export interface McpServerConfig {
  name: string;
  url: string;
  description?: string;
  transport?: "sse" | "stdio";
  addedAt?: string;
  enabled?: boolean;
  lastHealthCheck?: string;
  lastHealthStatus?: "ok" | "error" | "unknown";
  // OAuth fields
  authType?: "none" | "oauth" | "bearer";
  authUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scopes?: string[];
  redirectUri?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// OAuth Token Storage
// ─────────────────────────────────────────────────────────────────────────

const OAUTH_TOKEN_DIR = path.join(os.homedir(), ".config", "pakalon", "oauth");

function oauthTokenPath(serverName: string): string {
  return path.join(OAUTH_TOKEN_DIR, `${serverName}.json`);
}

/**
 * Load stored OAuth token for a server
 */
export function loadOAuthToken(serverName: string): OAuthToken | null {
  const tokenPath = oauthTokenPath(serverName);
  
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  
  try {
    const raw = fs.readFileSync(tokenPath, "utf-8");
    const token = JSON.parse(raw) as OAuthToken;
    
    // Check if token is expired
    if (token.expiresAt && Date.now() > token.expiresAt) {
      // Token expired - will need refresh
      return token;
    }
    
    return token;
  } catch {
    return null;
  }
}

/**
 * Save OAuth token for a server
 */
export function saveOAuthToken(serverName: string, token: OAuthToken): void {
  fs.mkdirSync(OAUTH_TOKEN_DIR, { recursive: true });
  fs.writeFileSync(oauthTokenPath(serverName), JSON.stringify(token, null, 2), "utf-8");
}

/**
 * Delete OAuth token for a server
 */
export function deleteOAuthToken(serverName: string): void {
  const tokenPath = oauthTokenPath(serverName);
  if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// OAuth 2.0 Authorization Code Flow (T-A25)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generate OAuth authorization URL
 */
export function generateOAuthUrl(config: McpServerConfig): string {
  const params = new URLSearchParams({
    client_id: config.clientId || "",
    redirect_uri: config.redirectUri || "http://localhost:8765/oauth/callback",
    response_type: "code",
    scope: config.scopes || "read",
    state: generateRandomState(),
  });
  
  return `${config.authUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForToken(
  config: McpServerConfig,
  code: string
): Promise<OAuthToken> {
  const tokenUrl = config.tokenUrl || `${config.authUrl}/token`;
  
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId || "",
      client_secret: config.clientSecret || "",
      redirect_uri: config.redirectUri || "http://localhost:8765/oauth/callback",
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OAuth token exchange failed: ${response.status} ${error}`);
  }
  
  const data = await response.json();
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenType: data.token_type || "Bearer",
  };
}

/**
 * Refresh OAuth token
 */
export async function refreshOAuthToken(
  config: McpServerConfig,
  refreshToken: string
): Promise<OAuthToken> {
  const tokenUrl = config.tokenUrl || `${config.authUrl}/token`;
  
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId || "",
      client_secret: config.clientSecret || "",
    }),
  });
  
  if (!response.ok) {
    throw new Error(`OAuth token refresh failed: ${response.status}`);
  }
  
  const data = await response.json();
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenType: data.token_type || "Bearer",
  };
}

/**
 * Full OAuth flow: initiate, get code from callback, exchange for token
 */
export async function completeOAuthFlow(
  config: McpServerConfig,
  authorizationCode: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await exchangeCodeForToken(config, authorizationCode);
    saveOAuthToken(config.name, token);
    return { success: true };
  } catch (err) {
    return { 
      success: false, 
      error: err instanceof Error ? err.message : String(err) 
    };
  }
}

/**
 * Get valid access token (handles refresh if needed)
 */
export async function getValidAccessToken(
  config: McpServerConfig
): Promise<string | null> {
  const token = loadOAuthToken(config.name);
  
  if (!token) {
    return null;
  }
  
  // Check if token needs refresh (expired or about to expire)
  if (token.expiresAt && Date.now() > token.expiresAt - 60000) {
    // Token expired or about to expire, try refresh
    if (token.refreshToken) {
      try {
        const newToken = await refreshOAuthToken(config, token.refreshToken);
        saveOAuthToken(config.name, newToken);
        return newToken.accessToken;
      } catch {
        // Refresh failed, token is invalid
        deleteOAuthToken(config.name);
        return null;
      }
    }
    return null;
  }
  
  return token.accessToken;
}

function generateRandomState(): string {
  return Math.random().toString(36).substring(2, 15);
}

// ─────────────────────────────────────────────────────────────────────────
// list_changed Dynamic Tool Notification (T-A26)
// ─────────────────────────────────────────────────────────────────────────

type ToolListChangedCallback = (serverName: string) => void;

const _toolListChangedListeners: ToolListChangedCallback[] = [];

/**
 * Subscribe to tool list changes
 */
export function onToolsListChanged(callback: ToolListChangedCallback): () => void {
  _toolListChangedListeners.push(callback);
  return () => {
    const idx = _toolListChangedListeners.indexOf(callback);
    if (idx >= 0) _toolListChangedListeners.splice(idx, 1);
  };
}

/**
 * Notify listeners that a server's tool list changed
 */
export function notifyToolsListChanged(serverName: string): void {
  for (const cb of _toolListChangedListeners) {
    try {
      cb(serverName);
    } catch (err) {
      logger.warn("[MCP] tools_list_changed callback error", { serverName, error: String(err) });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// @resource Mention Autocomplete (T-A27)
// ─────────────────────────────────────────────────────────────────────────

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

type ResourceCallback = (serverName: string) => Promise<McpResource[]>;

const _resourceProviders: Map<string, ResourceCallback> = new Map();

/**
 * Register a resource provider for an MCP server
 */
export function registerResourceProvider(
  serverName: string,
  provider: ResourceCallback
): void {
  _resourceProviders.set(serverName, provider);
}

/**
 * Get all resources from all MCP servers
 */
export async function getAllResources(): Promise<Array<{ server: string; resources: McpResource[] }>> {
  const results: Array<{ server: string; resources: McpResource[] }> = [];
  
  for (const [serverName, provider] of _resourceProviders) {
    try {
      const resources = await provider(serverName);
      results.push({ server: serverName, resources });
    } catch (err) {
      logger.warn("[MCP] Failed to get resources", { serverName, error: String(err) });
    }
  }
  
  return results;
}

/**
 * Search resources by query
 */
export async function searchResources(query: string): Promise<McpResource[]> {
  const allResources = await getAllResources();
  const lowerQuery = query.toLowerCase();
  
  const results: McpResource[] = [];
  
  for (const { resources } of allResources) {
    for (const resource of resources) {
      const matches = 
        resource.name.toLowerCase().includes(lowerQuery) ||
        resource.description?.toLowerCase().includes(lowerQuery) ||
        resource.uri.toLowerCase().includes(lowerQuery);
      
      if (matches) {
        results.push(resource);
      }
    }
  }
  
  return results;
}

/**
 * Parse @resource mention from user input
 */
export function parseResourceMention(input: string): { resourceUri: string; rest: string } | null {
  const match = input.match(/^@(\S+)\s*(.*)$/);
  
  if (!match) return null;
  
  return {
    resourceUri: match[1],
    rest: match[2] || "",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MCP Prompts as /mcp__server__prompt Commands (T-A28)
// ─────────────────────────────────────────────────────────────────────────

export interface McpPrompt {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

type PromptCallback = (serverName: string, promptName: string, args?: Record<string, string>) => Promise<string>;

const _promptProviders: Map<string, PromptCallback> = new Map();

/**
 * Register a prompt provider for an MCP server
 */
export function registerPromptProvider(
  serverName: string,
  provider: PromptCallback
): void {
  _promptProviders.set(serverName, provider);
}

/**
 * Execute an MCP prompt
 */
export async function executeMcpPrompt(
  serverName: string,
  promptName: string,
  args?: Record<string, string>
): Promise<string | null> {
  const provider = _promptProviders.get(serverName);
  
  if (!provider) {
    return null;
  }
  
  try {
    return await provider(serverName, promptName, args);
  } catch (err) {
    logger.warn("[MCP] Prompt execution failed", { serverName, promptName, error: String(err) });
    return null;
  }
}

/**
 * Parse /mcp__server__prompt command
 */
export function parseMcpPromptCommand(input: string): {
  server: string;
  prompt: string;
  args: string;
} | null {
  const match = input.match(/^\/mcp__(\w+)__(\w+)(?:\s+(.*))?$/);
  
  if (!match) return null;
  
  return {
    server: match[1],
    prompt: match[2],
    args: match[3] || "",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Managed MCP Enterprise (T-A31)
// ─────────────────────────────────────────────────────────────────────────

export interface ManagedMcpConfig {
  /** If true, only allow enterprise-managed MCP servers */
  allowManagedMcpOnly: boolean;
  /** List of allowed MCP server names/URLs */
  allowedServers?: string[];
  /** List of blocked MCP server names/URLs */
  blockedServers?: string[];
}

const MANAGED_MCP_PATHS = [
  "/etc/pakalon/managed-mcp.json",
  path.join(os.homedir(), ".config", "pakalon", "managed-mcp.json"),
];

/**
 * Load managed MCP configuration
 */
export function loadManagedMcpConfig(): ManagedMcpConfig | null {
  for (const mcpPath of MANAGED_MCP_PATHS) {
    if (fs.existsSync(mcpPath)) {
      try {
        const raw = fs.readFileSync(mcpPath, "utf-8");
        return JSON.parse(raw) as ManagedMcpConfig;
      } catch {
        // Invalid config, skip
      }
    }
  }
  
  return null;
}

/**
 * Check if an MCP server is allowed by enterprise policy
 */
export function isServerAllowed(serverConfig: McpServerConfig): {
  allowed: boolean;
  reason?: string;
} {
  const managed = loadManagedMcpConfig();
  
  if (!managed) {
    return { allowed: true }; // No enterprise policy
  }
  
  if (managed.allowManagedMcpOnly) {
    const isAllowed = managed.allowedServers?.some(
      allowed => allowed === serverConfig.name || allowed === serverConfig.url
    );
    
    if (!isAllowed) {
      return { 
        allowed: false, 
        reason: "Server not in enterprise allowlist and managed MCP only is enforced" 
      };
    }
  }
  
  const isBlocked = managed.blockedServers?.some(
    blocked => blocked === serverConfig.name || blocked === serverConfig.url
  );
  
  if (isBlocked) {
    return { allowed: false, reason: "Server is blocked by enterprise policy" };
  }
  
  return { allowed: true };
}

// ─────────────────────────────────────────────────────────────────────────
// MCP Tool Search (T-A32)
// ─────────────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

type ToolsCallback = (serverName: string) => Promise<McpTool[]>;

const _toolsProviders: Map<string, ToolsCallback> = new Map();

/**
 * Register a tools provider for an MCP server
 */
export function registerToolsProvider(serverName: string, provider: ToolsCallback): void {
  _toolsProviders.set(serverName, provider);
}

/**
 * Search tools across all MCP servers
 */
export async function searchMcpTools(query: string): Promise<Array<{
  server: string;
  tool: McpTool;
}>> {
  const lowerQuery = query.toLowerCase();
  const results: Array<{ server: string; tool: McpTool }> = [];
  
  for (const [serverName, provider] of _toolsProviders) {
    try {
      const tools = await provider(serverName);
      
      for (const tool of tools) {
        const matches = 
          tool.name.toLowerCase().includes(lowerQuery) ||
          tool.description?.toLowerCase().includes(lowerQuery);
        
        if (matches) {
          results.push({ server: serverName, tool });
        }
      }
    } catch (err) {
      logger.warn("[MCP] Tool search failed", { serverName, error: String(err) });
    }
  }
  
  // Sort by relevance (exact name match first)
  results.sort((a, b) => {
    const aExact = a.tool.name.toLowerCase() === lowerQuery;
    const bExact = b.tool.name.toLowerCase() === lowerQuery;
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    return 0;
  });
  
  return results;
}

// ─────────────────────────────────────────────────────────────────────────
// MCP Server as MCP Server (T-A29)
// ─────────────────────────────────────────────────────────────────────────

export interface McpAsServerConfig {
  /** Port to listen on */
  port: number;
  /** Allowed tools */
  allowedTools?: string[];
  /** Auth token (optional) */
  authToken?: string;
}

/**
 * Start the CLI as an MCP server
 * This exposes Pakalon's tools (readFile, writeFile, bash, etc.) over MCP
 */
export async function startMcpServer(
  config: McpAsServerConfig
): Promise<{ success: boolean; error?: string }> {
  // This would require implementing the MCP protocol server
  // For now, return a stub that explains what's needed
  logger.info("[MCP] Starting MCP server on port", { port: config.port });
  
  // TODO: Implement actual MCP server using stdio or SSE transport
  // This would involve:
  // 1. Implementing JSON-RPC 2.0 message handling
  // 2. Exposing tool implementations via MCP tool schema
  // 3. Handling initialize, tools/list, tools/call methods
  
  return { 
    success: false, 
    error: "MCP server mode not yet implemented. Use --mcp-serve flag to enable when available." 
  };
}
