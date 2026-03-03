/**
 * GitHub PR Context Loader
 * ─────────────────────────────────────────────────
 * 
 * Loads pull request diff and description from GitHub
 * for context injection at CLI startup.
 * 
 * Usage: pakalon --from-pr https://github.com/owner/repo/pull/123
 *        pakalon --from-pr 123
 *        pakalon --from-pr owner/repo#123
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import logger from "@/utils/logger.js";

export interface PrContext {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  description: string;
  diff: string;
  filesChanged: string[];
  url: string;
}

/**
 * Parse PR reference from various formats:
 * - https://github.com/owner/repo/pull/123
 * - https://github.com/owner/repo/pull/123/files
 * - owner/repo#123
 * - 123 (requires GITHUB_REPO env var)
 * - 123 (requires --dir with git remote)
 */
export function parsePrReference(input: string, cwd?: string): { owner: string; repo: string; prNumber: number } | null {
  // Full URL: https://github.com/owner/repo/pull/123
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], prNumber: parseInt(urlMatch[3], 10) };
  }

  // Short format: owner/repo#123
  const shortMatch = input.match(/^([^#]+)#(\d+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1].trim(), repo: "", prNumber: parseInt(shortMatch[2], 10) };
  }

  // Just number: 123
  const numMatch = input.match(/^\d+$/);
  if (numMatch) {
    // Try to get repo from git remote
    if (cwd) {
      const remote = getGitRemote(cwd);
      if (remote) {
        return { owner: remote.owner, repo: remote.repo, prNumber: parseInt(input, 10) };
      }
    }
    // Try GITHUB_REPO env var
    const githubRepo = process.env.GITHUB_REPO;
    if (githubRepo) {
      const parts = githubRepo.split("/");
      return { owner: parts[0], repo: parts[1] || "", prNumber: parseInt(input, 10) };
    }
  }

  return null;
}

/**
 * Get git remote URL and parse owner/repo
 */
function getGitRemote(cwd: string): { owner: string; repo: string } | null {
  try {
    const { execSync } = require("child_process");
    const remoteUrl = execSync("git remote get-url origin", { cwd, encoding: "utf-8" }).trim();
    
    // Parse from git@github.com:owner/repo.git or https://github.com/owner/repo.git
    const match = remoteUrl.match(/(?:github\.com[/:])([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  } catch {
    // Not a git repo or no origin remote
  }
  return null;
}

/**
 * Load PR context from GitHub API
 */
export async function loadPrContext(prRef: string, cwd?: string): Promise<PrContext> {
  const parsed = parsePrReference(prRef, cwd);
  
  if (!parsed) {
    throw new Error(`Invalid PR reference: ${prRef}. Use format: owner/repo#123, full URL, or PR number with GITHUB_REPO env var`);
  }

  const { owner, repo, prNumber } = parsed;
  const repoName = repo || process.env.GITHUB_REPO?.split("/")[1];
  
  if (!owner || !repoName) {
    throw new Error("Could not determine owner/repo. Use full URL or set GITHUB_REPO env var.");
  }

  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
  };
  
  if (githubToken) {
    headers["Authorization"] = `token ${githubToken}`;
  }

  // Fetch PR details
  const prUrl = `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`;
  logger.debug("[GitHub] Fetching PR", { owner, repo: repoName, prNumber });
  
  const prResp = await fetch(prUrl, { headers });
  
  if (!prResp.ok) {
    const err = await prResp.text();
    throw new Error(`GitHub API error: ${prResp.status} ${err}`);
  }
  
  const prData = await prResp.json() as {
    title: string;
    body: string;
    html_url: string;
    changed_files: number;
  };

  // Fetch PR diff
  const diffUrl = `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}.diff`;
  const diffResp = await fetch(diffUrl, { headers });
  
  if (!diffResp.ok) {
    throw new Error(`Failed to fetch diff: ${diffResp.status}`);
  }
  
  const diff = await diffResp.text();

  // Get list of changed files
  const filesUrl = `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}/files`;
  const filesResp = await fetch(filesUrl, { headers });
  const filesData = await filesResp.json() as Array<{ filename: string }>;
  const filesChanged = filesData.map(f => f.filename);

  return {
    owner,
    repo: repoName,
    prNumber,
    title: prData.title,
    description: prData.body || "",
    diff: diff.slice(0, 500000), // Limit to 500KB
    filesChanged,
    url: prData.html_url,
  };
}

/**
 * Format PR context as a markdown block for system prompt injection
 */
export function formatPrContextForPrompt(ctx: PrContext): string {
  const lines = [
    "## GitHub Pull Request Context",
    "",
    `**#${ctx.prNumber}: ${ctx.title}**`,
    `${ctx.url}`,
    "",
    "### Description",
    ctx.description.slice(0, 2000),
    "",
    "### Changed Files",
    ctx.filesChanged.slice(0, 50).map(f => `- ${f}`).join("\n"),
    "",
    ctx.filesChanged.length > 50 ? `... and ${ctx.filesChanged.length - 50} more files` : "",
    "",
    "### Diff (truncated)",
    "```diff",
    ctx.diff.slice(0, 30000), // First 30KB of diff
    "```",
  ];

  return lines.filter(Boolean).join("\n");
}

/**
 * Cache PR context to temp file and return path
 */
export async function cachePrContext(prRef: string, cwd?: string): Promise<string> {
  const ctx = await loadPrContext(prRef, cwd);
  const formatted = formatPrContextForPrompt(ctx);
  
  const cacheDir = path.join(os.tmpdir(), "pakalon-pr-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  
  const cacheFile = path.join(cacheDir, `pr-${ctx.owner}-${ctx.repo}-${ctx.prNumber}.md`);
  fs.writeFileSync(cacheFile, formatted, "utf-8");
  
  logger.info("[GitHub] Cached PR context", { pr: `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`, cacheFile });
  
  return cacheFile;
}
