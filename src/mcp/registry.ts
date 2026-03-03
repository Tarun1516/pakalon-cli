/**
 * MCP Registry — known MCP servers from modelcontextprotocol/servers
 * and other popular community servers.
 */

export interface RegistryEntry {
  name: string;
  displayName: string;
  url: string;
  description: string;
  transport: "sse" | "stdio";
  tags: string[];
  official: boolean;
}

// ---------------------------------------------------------------------------
// Known server registry
// ---------------------------------------------------------------------------

export const MCP_REGISTRY: RegistryEntry[] = [
  {
    name: "filesystem",
    displayName: "Filesystem",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    description: "Read/write local filesystem with sandboxed directory access",
    transport: "stdio",
    tags: ["file", "filesystem", "io"],
    official: true,
  },
  {
    name: "github",
    displayName: "GitHub",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    description: "Interact with GitHub repositories, issues, and PRs",
    transport: "stdio",
    tags: ["git", "github", "vcs", "code"],
    official: true,
  },
  {
    name: "gitlab",
    displayName: "GitLab",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab",
    description: "Interact with GitLab repositories and CI/CD pipelines",
    transport: "stdio",
    tags: ["git", "gitlab", "vcs", "ci"],
    official: true,
  },
  {
    name: "google-drive",
    displayName: "Google Drive",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive",
    description: "Access and manage Google Drive files and folders",
    transport: "stdio",
    tags: ["drive", "google", "files", "cloud"],
    official: true,
  },
  {
    name: "google-maps",
    displayName: "Google Maps",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps",
    description: "Location, routing, and places via Google Maps API",
    transport: "stdio",
    tags: ["maps", "location", "geo", "google"],
    official: true,
  },
  {
    name: "postgres",
    displayName: "PostgreSQL",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    description: "Read-only and read-write access to PostgreSQL databases",
    transport: "stdio",
    tags: ["database", "sql", "postgres", "db"],
    official: true,
  },
  {
    name: "sqlite",
    displayName: "SQLite",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
    description: "SQLite database interaction with schema introspection",
    transport: "stdio",
    tags: ["database", "sql", "sqlite", "db"],
    official: true,
  },
  {
    name: "slack",
    displayName: "Slack",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    description: "Post messages and read channels from Slack workspace",
    transport: "stdio",
    tags: ["slack", "messaging", "team", "social"],
    official: true,
  },
  {
    name: "puppeteer",
    displayName: "Puppeteer",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    description: "Browser automation via Puppeteer — screenshots, scraping, testing",
    transport: "stdio",
    tags: ["browser", "puppeteer", "automation", "scrape", "test"],
    official: true,
  },
  {
    name: "brave-search",
    displayName: "Brave Search",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    description: "Web search using the Brave Search API",
    transport: "stdio",
    tags: ["search", "web", "brave", "internet"],
    official: true,
  },
  {
    name: "everart",
    displayName: "EverArt",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/everart",
    description: "AI image generation using EverArt API",
    transport: "stdio",
    tags: ["image", "ai", "art", "generate", "visual"],
    official: true,
  },
  {
    name: "fetch",
    displayName: "Fetch",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    description: "HTTP fetch for URLs with markdown conversion",
    transport: "stdio",
    tags: ["http", "fetch", "web", "url"],
    official: true,
  },
  {
    name: "aws-kb-retrieval",
    displayName: "AWS Knowledge Base",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/aws-kb-retrieval-server",
    description: "AWS Bedrock Knowledge Base retrieval for RAG",
    transport: "stdio",
    tags: ["aws", "bedrock", "rag", "knowledge", "retrieval"],
    official: true,
  },
  {
    name: "sentry",
    displayName: "Sentry",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/sentry",
    description: "Query Sentry issues and error reports",
    transport: "stdio",
    tags: ["monitoring", "sentry", "errors", "observability"],
    official: true,
  },
  {
    name: "linear",
    displayName: "Linear",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/linear",
    description: "Create and manage Linear issues and projects",
    transport: "stdio",
    tags: ["project", "issues", "linear", "planning"],
    official: true,
  },
  {
    name: "memory",
    displayName: "Memory",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    description: "Persistent memory store using knowledge graphs",
    transport: "stdio",
    tags: ["memory", "knowledge", "persistent", "graph"],
    official: true,
  },
  {
    name: "sequentialthinking",
    displayName: "Sequential Thinking",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    description: "Chain-of-thought reasoning via sequential thinking protocol",
    transport: "stdio",
    tags: ["reasoning", "thinking", "cot", "chain"],
    official: true,
  },
  {
    name: "firecrawl",
    displayName: "Firecrawl",
    url: "https://github.com/mendableai/firecrawl-mcp-server",
    description: "Advanced web scraping and crawling with Firecrawl",
    transport: "sse",
    tags: ["scrape", "crawl", "web", "firecrawl"],
    official: false,
  },
  {
    name: "browserbase",
    displayName: "BrowserBase",
    url: "https://github.com/browserbase/mcp-server-browserbase",
    description: "Cloud browser sessions for AI — screenshots, automation",
    transport: "sse",
    tags: ["browser", "cloud", "automation", "screenshot"],
    official: false,
  },
  {
    name: "neon",
    displayName: "Neon Database",
    url: "https://github.com/neondatabase/mcp-server-neon",
    description: "Neon serverless Postgres management and querying",
    transport: "sse",
    tags: ["database", "neon", "postgres", "serverless"],
    official: false,
  },
  {
    name: "cloudflare",
    displayName: "Cloudflare",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    description: "Manage Cloudflare workers, KV, R2, and Durable Objects",
    transport: "sse",
    tags: ["cloudflare", "workers", "edge", "cdn"],
    official: false,
  },
  {
    name: "context7",
    displayName: "Context7",
    url: "https://github.com/upstash/context7",
    description: "Up-to-date library documentation and code examples for any npm/PyPI package — prevents hallucinated APIs",
    transport: "stdio",
    tags: ["docs", "documentation", "context", "npm", "libraries", "context7", "upstash"],
    official: false,
  },
  {
    name: "notion",
    displayName: "Notion",
    url: "https://github.com/makenotion/notion-mcp-server",
    description: "Read, write, and search Notion pages and databases via the Notion API",
    transport: "sse",
    tags: ["notion", "notes", "docs", "wiki", "enterprise"],
    official: false,
  },
  {
    name: "jira",
    displayName: "Jira",
    url: "https://github.com/atlassian/jira-mcp-server",
    description: "Create, update, and search Jira issues for Cloud and Server/DC",
    transport: "sse",
    tags: ["jira", "issues", "project", "atlassian", "enterprise"],
    official: false,
  },
];

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Fuzzy search registry by name, description, or tags.
 */
export function searchRegistry(query: string): RegistryEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return MCP_REGISTRY;

  const scored: Array<{ entry: RegistryEntry; score: number }> = [];

  for (const entry of MCP_REGISTRY) {
    let score = 0;

    // Exact name match — highest priority
    if (entry.name === q) score += 100;
    // Name starts with query
    else if (entry.name.startsWith(q)) score += 50;
    // Name contains query
    else if (entry.name.includes(q)) score += 30;

    // Display name match
    if (entry.displayName.toLowerCase().includes(q)) score += 20;

    // Description match
    if (entry.description.toLowerCase().includes(q)) score += 10;

    // Tag matches
    for (const tag of entry.tags) {
      if (tag === q) score += 40;
      else if (tag.includes(q)) score += 15;
    }

    // Official bonus
    if (entry.official && score > 0) score += 5;

    if (score > 0) scored.push({ entry, score });
  }

  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}

/**
 * Get full details for a registry entry by name.
 */
export function getRegistryEntry(name: string): RegistryEntry | null {
  return MCP_REGISTRY.find((e) => e.name === name) ?? null;
}

/**
 * List all entries grouped by official vs community.
 */
export function listByOfficial(): { official: RegistryEntry[]; community: RegistryEntry[] } {
  return {
    official: MCP_REGISTRY.filter((e) => e.official),
    community: MCP_REGISTRY.filter((e) => !e.official),
  };
}
