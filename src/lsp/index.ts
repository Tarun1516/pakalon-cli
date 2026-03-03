/**
 * LSP (Language Server Protocol) Integration for Pakalon
 * 
 * Provides IDE-like code intelligence:
 * - Go to definition
 * - Find references
 * - Real-time diagnostics
 * - Symbol search
 * 
 * Based on Claude Code LSP implementation (released December 2025)
 * Supports 11 programming languages
 */

import { debugLog } from "@/utils/logger.js";

// LSP Client implementation using stdio communication with language servers
export interface LSPClient {
  name: string;
  language: string;
  command: string[];
  args?: string[];
}

export interface SymbolLocation {
  file: string;
  line: number;
  column: number;
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
}

export interface DefinitionResult {
  file: string;
  line: number;
  column: number;
  symbolName?: string;
}

export interface ReferencesResult {
  file: string;
  line: number;
  column: number;
  symbolName: string;
  context?: string;
}

// Language Server configurations
const LSP_SERVERS: Record<string, LSPClient> = {
  python: {
    name: "python-lsp-server",
    language: "python",
    command: ["python", "-m", "pylsp"],
  },
  typescript: {
    name: "typescript-language-server",
    language: "typescript",
    command: ["typescript-language-server", "--stdio"],
  },
  javascript: {
    name: "typescript-language-server",
    language: "javascript",
    command: ["typescript-language-server", "--stdio"],
  },
  tsx: {
    name: "typescript-language-server",
    language: "tsx",
    command: ["typescript-language-server", "--stdio"],
  },
  jsx: {
    name: "typescript-language-server",
    language: "jsx",
    command: ["typescript-language-server", "--stdio"],
  },
  go: {
    name: "gopls",
    language: "go",
    command: ["gopls"],
  },
  rust: {
    name: "rust-analyzer",
    language: "rust",
    command: ["rust-analyzer"],
  },
  java: {
    name: "jdtls",
    language: "java",
    command: ["jdtls"],
  },
  csharp: {
    name: "omnisharp",
    language: "csharp",
    command: ["omnisharp", "--stdio"],
  },
  cpp: {
    name: "clangd",
    language: "cpp",
    command: ["clangd"],
  },
  c: {
    name: "clangd",
    language: "c",
    command: ["clangd"],
  },
  php: {
    name: "php-language-server",
    language: "php",
    command: ["php", "-S", "localhost:0", "-t", ".", "| php-language-server"],
  },
  kotlin: {
    name: "kotlin-language-server",
    language: "kotlin",
    command: ["kotlin-language-server"],
  },
  ruby: {
    name: "solargraph",
    language: "ruby",
    command: ["solargraph", "stdio"],
  },
  html: {
    name: "vscode-html-languageserver",
    language: "html",
    command: ["vscode-html-languageserver", "--stdio"],
  },
  css: {
    name: "vscode-css-languageserver",
    language: "css",
    command: ["vscode-css-languageserver", "--stdio"],
  },
  json: {
    name: "vscode-json-languageserver",
    language: "json",
    command: ["vscode-json-languageserver", "--stdio"],
  },
  yaml: {
    name: "yaml-language-server",
    language: "yaml",
    command: ["yaml-language-server", "--stdio"],
  },
};

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    py: "python",
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    go: "go",
    rs: "rust",
    java: "java",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    php: "php",
    kt: "kotlin",
    kts: "kotlin",
    rb: "ruby",
    html: "html",
    htm: "html",
    css: "css",
    scss: "css",
    less: "css",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
  };
  return ext ? langMap[ext] || null : null;
}

/**
 * Get LSP client for a file
 */
export function getLSPClient(filePath: string): LSPClient | null {
  const lang = detectLanguage(filePath);
  if (!lang) return null;
  return LSP_SERVERS[lang] || null;
}

/**
 * Check if LSP is available for a file
 */
export function isLSPAvailable(filePath: string): boolean {
  return getLSPClient(filePath) !== null;
}

// LSP Request/Response types
interface LSPRequest {
  id: number;
  method: string;
  params: unknown;
}

interface LSPResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
}

class LSPClientConnection {
  private proc: ReturnType<typeof import("child_process")>["spawn"] | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();
  private capabilities: Record<string, boolean> = {};
  private initialized = false;

  constructor(
    private client: LSPClient,
    private workspaceRoot: string
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const { spawn } = await import("child_process");
      
      this.proc = spawn(this.client.command[0], [...(this.client.args || []), ...this.client.command.slice(1)], {
        cwd: this.workspaceRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Initialize LSP
      const initPromise = this.sendRequest("initialize", {
        processId: process.pid,
        workspaceFolders: [{ uri: `file://${this.workspaceRoot}`, name: "pakalon" }],
        capabilities: {
          textDocument: {
            synchronization: { willSave: false, didSave: true, willSaveWaitUntil: false },
            completion: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            definition: { dynamicRegistration: false },
            typeDefinition: { dynamicRegistration: false },
            implementation: { dynamicRegistration: false },
            hover: { dynamicRegistration: false },
            signatureHelp: { dynamicRegistration: false },
          },
          workspace: {
            applyEdit: false,
            workspaceFolders: true,
          },
        },
      });

      // Wait for initialization with timeout
      await Promise.race([
        initPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("LSP init timeout")), 5000)),
      ]);

      // Send initialized notification
      this.sendNotification("initialized", {});

      this.initialized = true;
      debugLog(`[lsp] Initialized ${this.client.name} for ${this.client.language}`);
    } catch (err) {
      debugLog(`[lsp] Failed to initialize ${this.client.name}: ${err}`);
      throw err;
    }
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) throw new Error("LSP not initialized");

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });

      const request: LSPRequest = { id, method, params };
      this.proc!.stdin!.write(JSON.stringify(request) + "\n");

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.proc) return;
    const notification = { method, params };
    this.proc.stdin!.write(JSON.stringify(notification) + "\n");
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    await this.sendRequest("shutdown", {});
    this.sendNotification("exit", {});
    this.proc?.kill();
    this.initialized = false;
  }

  // LSP Methods
  async gotoDefinition(filePath: string, line: number, column: number): Promise<DefinitionResult | null> {
    try {
      const result = await this.sendRequest("textDocument/definition", {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character: column },
      });

      if (!result || Array.isArray(result) && result.length === 0) return null;

      const location = Array.isArray(result) ? result[0] : result;
      if (!location || !location.uri) return null;

      const uri = location.uri;
      const pathMatch = uri.match(/file:\/\/(.+)/);
      if (!pathMatch) return null;

      return {
        file: pathMatch[1],
        line: location.range?.start?.line || 0,
        column: location.range?.start?.character || 0,
        symbolName: location.symbolName,
      };
    } catch (err) {
      debugLog(`[lsp] gotoDefinition error: ${err}`);
      return null;
    }
  }

  async findReferences(filePath: string, line: number, column: number): Promise<ReferencesResult[]> {
    try {
      const result = await this.sendRequest("textDocument/references", {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character: column },
        context: { includeDeclaration: true },
      });

      if (!result || !Array.isArray(result)) return [];

      return result.map((location: any) => ({
        file: location.uri?.replace(/file:\/\//, "") || "",
        line: location.range?.start?.line || 0,
        column: location.range?.start?.character || 0,
        symbolName: "",
        context: "",
      }));
    } catch (err) {
      debugLog(`[lsp] findReferences error: ${err}`);
      return [];
    }
  }

  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    try {
      // First, open the document
      const { readFileSync } = await import("fs");
      const content = readFileSync(filePath, "utf-8");

      this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: `file://${filePath}`,
          languageId: this.client.language,
          version: 1,
          text: content,
        },
      });

      // Request diagnostics
      const result = await this.sendRequest("textDocument/diagnostic", {
        textDocument: { uri: `file://${filePath}` },
      });

      if (!result || !Array.isArray(result)) return [];

      return result.map((diag: any) => ({
        file: filePath,
        line: diag.range?.start?.line || 0,
        column: diag.range?.start?.character || 0,
        severity: mapDiagnosticSeverity(diag.severity),
        message: diag.message || "",
        source: diag.source,
      }));
    } catch (err) {
      // Diagnostics might not be supported
      return [];
    }
  }

  async getDocumentSymbols(filePath: string): Promise<Array<{ name: string; kind: number; location: { file: string; line: number; column: number } }>> {
    try {
      const result = await this.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: `file://${filePath}` },
      });

      if (!result || !Array.isArray(result)) return [];

      return result.map((symbol: any) => ({
        name: symbol.name,
        kind: symbol.kind,
        location: {
          file: filePath,
          line: symbol.location?.range?.start?.line || 0,
          column: symbol.location?.range?.start?.character || 0,
        },
      }));
    } catch (err) {
      debugLog(`[lsp] getDocumentSymbols error: ${err}`);
      return [];
    }
  }

  async getWorkspaceSymbols(query: string): Promise<Array<{ name: string; location: { file: string; line: number } }>> {
    try {
      const result = await this.sendRequest("workspace/symbol", {
        query,
      });

      if (!result || !Array.isArray(result)) return [];

      return result.map((symbol: any) => ({
        name: symbol.name,
        location: {
          file: symbol.location?.uri?.replace(/file:\/\//, "") || "",
          line: symbol.location?.range?.start?.line || 0,
        },
      }));
    } catch (err) {
      debugLog(`[lsp] getWorkspaceSymbols error: ${err}`);
      return [];
    }
  }
}

// LSP Client cache by workspace
const lspClients = new Map<string, LSPClientConnection>();

function mapDiagnosticSeverity(severity: number): Diagnostic["severity"] {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "information";
    case 4: return "hint";
    default: return "information";
  }
}

/**
 * Get or create LSP client for workspace
 */
export async function getOrCreateLSPClient(
  workspaceRoot: string,
  filePath?: string
): Promise<LSPClientConnection | null> {
  const key = workspaceRoot;
  
  if (lspClients.has(key)) {
    const client = lspClients.get(key)!;
    try {
      await client.initialize();
      return client;
    } catch {
      lspClients.delete(key);
    }
  }

  // Try to detect language and get LSP client
  const langClient = filePath ? getLSPClient(filePath) : null;
  if (!langClient) return null;

  try {
    const client = new LSPClientConnection(langClient, workspaceRoot);
    await client.initialize();
    lspClients.set(key, client);
    return client;
  } catch (err) {
    debugLog(`[lsp] Failed to create LSP client: ${err}`);
    return null;
  }
}

/**
 * Go to definition - navigates to where a symbol is defined
 */
export async function gotoDefinition(
  filePath: string,
  line: number,
  column: number,
  workspaceRoot?: string
): Promise<DefinitionResult | null> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return null;
  return client.gotoDefinition(filePath, line, column);
}

/**
 * Find all references to a symbol
 */
export async function findReferences(
  filePath: string,
  line: number,
  column: number,
  workspaceRoot?: string
): Promise<ReferencesResult[]> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return [];
  return client.findReferences(filePath, line, column);
}

/**
 * Get diagnostics for a file
 */
export async function getFileDiagnostics(
  filePath: string,
  workspaceRoot?: string
): Promise<Diagnostic[]> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return [];
  return client.getDiagnostics(filePath);
}

/**
 * Get all symbols in a document
 */
export async function getDocumentSymbols(
  filePath: string,
  workspaceRoot?: string
): Promise<Array<{ name: string; kind: number; location: { file: string; line: number; column: number } }>> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return [];
  return client.getDocumentSymbols(filePath);
}

/**
 * Search for symbols across the workspace
 */
export async function searchWorkspaceSymbols(
  query: string,
  workspaceRoot: string
): Promise<Array<{ name: string; location: { file: string; line: number } }>> {
  const client = await getOrCreateLSPClient(workspaceRoot);
  if (!client) return [];
  return client.getWorkspaceSymbols(query);
}

/**
 * Get available LSP servers info
 */
export function getAvailableLSPServers(): Array<{ language: string; server: string }> {
  return Object.entries(LSP_SERVERS).map(([lang, client]) => ({
    language: lang,
    server: client.name,
  }));
}

/**
 * Check which languages have LSP support
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(LSP_SERVERS);
}

/**
 * Clean up LSP clients
 */
export async function cleanupLSPClients(): Promise<void> {
  for (const client of lspClients.values()) {
    try {
      await client.shutdown();
    } catch {
      // Ignore cleanup errors
    }
  }
  lspClients.clear();
}

// Export for use in other modules
export default {
  detectLanguage,
  getLSPClient,
  isLSPAvailable,
  gotoDefinition,
  findReferences,
  getFileDiagnostics,
  getDocumentSymbols,
  searchWorkspaceSymbols,
  getAvailableLSPServers,
  getSupportedLanguages,
  cleanupLSPClients,
};
