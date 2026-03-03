/**
 * git.ts — Git / GitHub slash-commands for Pakalon CLI.
 * T0-3: /git status, /git diff, /git commit, /git pr, /git branch, /git log
 * P7:   /git conflicts, /git resolve — interactive conflict resolution helpers
 *
 * All commands run via child_process (no git library dependency required).
 */

import { execSync, exec as execCb } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const exec = promisify(execCb);

export interface GitResult {
  ok: boolean;
  output: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function cwd(): string {
  return process.cwd();
}

async function git(args: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec(`git ${args}`, { cwd: cwd() });
    return { ok: true, output: (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim() };
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string; stdout?: string };
    return { ok: false, output: e.stdout?.trim() ?? "", error: e.stderr?.trim() ?? e.message ?? String(err) };
  }
}

/** Check if current directory is inside a git repo. */
async function isGitRepo(): Promise<boolean> {
  const res = await git("rev-parse --is-inside-work-tree");
  return res.ok && res.output.trim() === "true";
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/** /git status — show working tree state */
export async function gitStatus(): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  const short = await git("status --short --branch");
  const stash = await git("stash list --format='%gd: %s'");
  let output = short.output;
  if (stash.ok && stash.output) {
    output += `\n\nStashes:\n${stash.output}`;
  }
  return { ok: true, output };
}

/** /git diff [file?] — show unstaged or file-specific diff */
export async function gitDiff(file?: string): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  const args = file ? `diff -- ${JSON.stringify(file)}` : "diff";
  const result = await git(args);
  if (result.ok && !result.output) {
    return { ok: true, output: "(no unstaged changes)" };
  }
  return result;
}

/** /git staged — show staged diff */
export async function gitStagedDiff(): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  const result = await git("diff --cached");
  if (result.ok && !result.output) {
    return { ok: true, output: "(nothing staged)" };
  }
  return result;
}

/** /git log [n=10] — recent commit history */
export async function gitLog(n = 10): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  return git(`log --oneline --graph --decorate -${n}`);
}

/** /git branch — list branches, highlight current */
export async function gitBranch(): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  return git("branch -a");
}

/** /git checkout <branch> — switch branches (fail loudly if dirty) */
export async function gitCheckout(branch: string): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  if (!branch) return { ok: false, output: "", error: "Branch name required." };
  return git(`checkout ${branch}`);
}

/** /git commit <message> — stage all and commit
 *
 * T-GIT-ATTR: Appends a "Co-Authored-By: Pakalon <pakalon@pakalon.dev>" trailer
 * unless PAKALON_NO_ATTRIBUTION=1 or settings.git.attribution is false.
 */
export async function gitCommit(message: string): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  if (!message) return { ok: false, output: "", error: "Commit message required." };

  // Build the commit message — append Co-Authored-By trailer unless opted out
  let fullMessage = message;
  const noAttrib =
    process.env.PAKALON_NO_ATTRIBUTION === "1" ||
    (() => {
      try {
        // Read project-level settings
        const settingsPath = path.join(process.cwd(), ".pakalon", "settings.json");
        if (fs.existsSync(settingsPath)) {
          const s = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
          const git = s["git"] as Record<string, unknown> | undefined;
          if (git && git["attribution"] === false) return true;
        }
      } catch {
        // Ignore read errors
      }
      return false;
    })();

  if (!noAttrib) {
    // Git Co-Authored-By trailer (standard GitHub format)
    const trailer = "Co-Authored-By: Pakalon <pakalon@pakalon.dev>";
    // Git requires a blank line before trailers
    fullMessage = `${message}\n\n${trailer}`;
  }

  // Stage all tracked modifications
  await git("add -u");
  return git(`commit -m ${JSON.stringify(fullMessage)}`);
}

/** /git add [file?] — stage file or everything */
export async function gitAdd(file?: string): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  const args = file ? `add ${JSON.stringify(file)}` : "add -A";
  return git(args);
}

/** /git push [remote] [branch] */
export async function gitPush(remote = "origin", branch = "HEAD"): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  return git(`push ${remote} ${branch}`);
}

/** /git stash [push|pop|list] */
export async function gitStash(action: "push" | "pop" | "list" = "push"): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };
  const map = { push: "stash push", pop: "stash pop", list: "stash list" } as const;
  return git(map[action]);
}

// ─────────────────────────────────────────────────────────────────────────────
// P7: Conflict resolution helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface ConflictFile {
  path: string;
  conflictCount: number;
  sections: ConflictSection[];
}

export interface ConflictSection {
  lineStart: number;
  ours: string;
  theirs: string;
  ancestor?: string; // diff3 middle section
}

/**
 * /git conflicts — list all files with unresolved merge conflicts.
 */
export async function gitListConflicts(): Promise<GitResult & { files?: ConflictFile[] }> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };

  const res = await git("diff --name-only --diff-filter=U");
  if (!res.ok) return res;
  if (!res.output.trim()) {
    return { ok: true, output: "✅ No merge conflicts found." };
  }

  const conflictFilePaths = res.output.trim().split("\n").filter(Boolean);
  const files: ConflictFile[] = [];

  for (const filePath of conflictFilePaths) {
    try {
      const abs = path.resolve(filePath);
      const content = fs.readFileSync(abs, "utf-8");
      const sections = parseConflictSections(content);
      files.push({ path: filePath, conflictCount: sections.length, sections });
    } catch {
      files.push({ path: filePath, conflictCount: 0, sections: [] });
    }
  }

  const lines = files.map((f) => `  ⚡ ${f.path} — ${f.conflictCount} conflict${f.conflictCount !== 1 ? "s" : ""}`);
  const output = [
    `Found **${files.length}** file${files.length !== 1 ? "s" : ""} with conflicts:`,
    ...lines,
    "",
    "Resolve with:",
    "  `/git resolve <file> ours`    — accept all ours (HEAD)",
    "  `/git resolve <file> theirs`  — accept all theirs (MERGE_HEAD)",
    "  `/git resolve <file> ai`      — let AI suggest the best resolution",
    "",
    "After resolving: `/git add <file>` then `/git commit`",
  ].join("\n");

  return { ok: true, output, files };
}

/** Parse conflict markers from file content and return sections. */
function parseConflictSections(content: string): ConflictSection[] {
  const sections: ConflictSection[] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    if (lines[i]?.startsWith("<<<<<<<")) {
      const lineStart = i + 1;
      const oursLines: string[] = [];
      const theirsLines: string[] = [];
      let inTheirs = false;

      i++;
      while (i < lines.length && !lines[i]?.startsWith(">>>>>>>")) {
        if (lines[i]?.startsWith("=======")) {
          inTheirs = true;
        } else if (inTheirs) {
          theirsLines.push(lines[i]!);
        } else {
          oursLines.push(lines[i]!);
        }
        i++;
      }

      sections.push({
        lineStart,
        ours: oursLines.join("\n"),
        theirs: theirsLines.join("\n"),
      });
    }
    i++;
  }

  return sections;
}

/**
 * /git resolve <file> [ours|theirs|ai] — resolve conflicts in a file.
 * - ours: keep all HEAD (our) changes
 * - theirs: keep all MERGE_HEAD changes
 * - ai: use AI to suggest merged resolution (calls bridge /agent/resolve-conflict)
 */
export async function gitResolveConflict(
  filePath: string,
  strategy: "ours" | "theirs" | "ai" = "ours"
): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };

  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return { ok: false, output: "", error: `File not found: ${filePath}` };
  }

  if (strategy === "ours" || strategy === "theirs") {
    // Use git checkout to resolve cleanly
    const res = await git(`checkout --${strategy} -- ${JSON.stringify(filePath)}`);
    if (!res.ok) return res;
    await git(`add -- ${JSON.stringify(filePath)}`);
    return {
      ok: true,
      output: `✅ Resolved \`${filePath}\` using **${strategy}**. File staged.\n\nRun \`/git commit\` when all conflicts are resolved.`,
    };
  }

  // ai strategy: call bridge endpoint
  try {
    const content = fs.readFileSync(abs, "utf-8");
    const sections = parseConflictSections(content);
    if (sections.length === 0) {
      return { ok: true, output: `No conflict markers found in \`${filePath}\`.` };
    }

    const bridgeUrl = process.env.PAKALON_BRIDGE_URL ?? "http://127.0.0.1:7432";
    const res = await fetch(`${bridgeUrl}/agent/resolve-conflict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_path: abs, content, sections }),
    });

    if (!res.ok) {
      return { ok: false, output: "", error: `Bridge error: HTTP ${res.status}` };
    }

    const data = await res.json() as { resolved_content?: string; explanation?: string };
    if (!data.resolved_content) {
      return { ok: false, output: "", error: "Bridge returned no resolved content." };
    }

    fs.writeFileSync(abs, data.resolved_content, "utf-8");
    await git(`add -- ${JSON.stringify(filePath)}`);

    return {
      ok: true,
      output: [
        `✅ AI resolved \`${filePath}\` — ${sections.length} conflict${sections.length !== 1 ? "s" : ""} merged.`,
        data.explanation ? `\n**Reasoning:** ${data.explanation}` : "",
        "\nFile staged. Run `/git commit` when all conflicts are resolved.",
      ].join(""),
    };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, output: "", error: `AI resolution failed: ${e.message ?? String(err)}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub PR helpers (uses `gh` CLI if available, otherwise outputs URL)
// ─────────────────────────────────────────────────────────────────────────────

async function ghAvailable(): Promise<boolean> {
  try {
    execSync("gh --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface PRDraft {
  title: string;
  body: string;
  base?: string;
  draft?: boolean;
}

/**
 * /git pr create — Create a GitHub PR using `gh` CLI.
 * If `gh` is not installed, returns instructions.
 */
export async function createPR(draft: PRDraft): Promise<GitResult> {
  if (!(await isGitRepo())) return { ok: false, output: "", error: "Not a git repository." };

  if (!(await ghAvailable())) {
    return {
      ok: false,
      output: "",
      error: "`gh` CLI not found. Install from https://cli.github.com/ then run: gh pr create",
    };
  }

  const base = draft.base || "main";
  const draftFlag = draft.draft ? "--draft" : "";
  const cmd = `gh pr create --title ${JSON.stringify(draft.title)} --body ${JSON.stringify(draft.body)} --base ${base} ${draftFlag}`.trim();
  return git(`${cmd.replace(/^git /, "")}`);
}

/**
 * /git pr list — List open PRs for this repo.
 */
export async function listPRs(): Promise<GitResult> {
  if (!(await ghAvailable())) {
    return { ok: false, output: "", error: "`gh` CLI not found." };
  }
  try {
    const { stdout } = await exec("gh pr list --state open --json number,title,headRefName,author,createdAt --template '{{range .}}#{{.number}} {{.title}} ({{.headRefName}}) by {{.author.login}}\n{{end}}'");
    return { ok: true, output: stdout.trim() || "(no open PRs)" };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, output: "", error: e.stderr ?? e.message ?? String(err) };
  }
}

/**
 * /git pr view [number] — Show PR details.
 */
export async function viewPR(number?: number): Promise<GitResult> {
  if (!(await ghAvailable())) {
    return { ok: false, output: "", error: "`gh` CLI not found." };
  }
  const arg = number ? `${number}` : "";
  try {
    const { stdout } = await exec(`gh pr view ${arg}`);
    return { ok: true, output: stdout.trim() };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, output: "", error: e.stderr ?? e.message ?? String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI-guided commit message generation (uses last diff)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a conventional-commit message from staged diff.
 * Returns a suggested message; user must confirm before committing.
 */
export async function suggestCommitMessage(): Promise<{ suggestion: string; diff: string }> {
  const diffRes = await gitStagedDiff();
  const diff = diffRes.output;

  if (!diff || diff === "(nothing staged)") {
    return { suggestion: "", diff: "" };
  }

  // Simple heuristic: extract file names and guess type
  const files = diff
    .split("\n")
    .filter((l) => l.startsWith("diff --git"))
    .map((l) => l.split(" b/").pop() ?? "")
    .filter(Boolean);

  const hasTests = files.some((f) => f.includes("test") || f.includes("spec"));
  const hasDocs = files.some((f) => f.endsWith(".md") || f.includes("docs/"));
  const hasConfig = files.some((f) => f.includes("config") || f.includes(".json") || f.includes(".ts") && !f.includes("src/"));

  let type = "feat";
  if (hasTests) type = "test";
  else if (hasDocs) type = "docs";
  else if (hasConfig) type = "chore";

  const fileList = files.slice(0, 3).join(", ");
  const suggestion = `${type}: update ${fileList}${files.length > 3 ? " (+ more)" : ""}`;

  return { suggestion, diff };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch: parse "/git <sub> [args...]" and run correct handler
// ─────────────────────────────────────────────────────────────────────────────

export interface GitCommandResult extends GitResult {
  subCommand: string;
}

export async function handleGitCommand(args: string[]): Promise<GitCommandResult> {
  const [sub, ...rest] = args;
  const arg0 = rest[0];

  switch (sub) {
    case "status":
    case "st":
      return { ...(await gitStatus()), subCommand: "status" };

    case "diff":
      return { ...(await gitDiff(arg0)), subCommand: "diff" };

    case "staged":
      return { ...(await gitStagedDiff()), subCommand: "staged" };

    case "log":
      return { ...(await gitLog(arg0 ? parseInt(arg0, 10) : 10)), subCommand: "log" };

    case "branch":
    case "branches":
      return { ...(await gitBranch()), subCommand: "branch" };

    case "checkout":
    case "co":
      return { ...(await gitCheckout(arg0 ?? "")), subCommand: "checkout" };

    case "add":
      return { ...(await gitAdd(arg0)), subCommand: "add" };

    case "commit":
      return { ...(await gitCommit(rest.join(" "))), subCommand: "commit" };

    case "push":
      return { ...(await gitPush(arg0, rest[1])), subCommand: "push" };

    case "stash":
      return { ...(await gitStash((arg0 as "push" | "pop" | "list") ?? "push")), subCommand: "stash" };

    case "pr": {
      const prSub = rest[0];
      if (prSub === "list" || !prSub) return { ...(await listPRs()), subCommand: "pr list" };
      if (prSub === "view") return { ...(await viewPR(rest[1] ? parseInt(rest[1], 10) : undefined)), subCommand: "pr view" };
      return { ok: false, output: "", error: `Unknown pr sub-command: ${prSub}. Try: list, view`, subCommand: "pr" };
    }

    case "suggest-commit": {
      const { suggestion, diff } = await suggestCommitMessage();
      if (!suggestion) return { ok: true, output: "(nothing staged to suggest a message for)", subCommand: "suggest-commit" };
      return { ok: true, output: `Suggested commit message:\n  ${suggestion}\n\nRun /git commit ${JSON.stringify(suggestion)} to apply.`, subCommand: "suggest-commit" };
    }

    case "conflicts":
    case "conflict": {
      const result = await gitListConflicts();
      return { ...result, subCommand: "conflicts" };
    }

    case "resolve": {
      const file = rest[0];
      const strategy = (rest[1] as "ours" | "theirs" | "ai" | undefined) ?? "ours";
      if (!file) {
        return {
          ok: false,
          output: "",
          error: "Usage: /git resolve <file> [ours|theirs|ai]",
          subCommand: "resolve",
        };
      }
      if (!["ours", "theirs", "ai"].includes(strategy)) {
        return {
          ok: false,
          output: "",
          error: `Unknown strategy: "${strategy}". Use ours, theirs, or ai.`,
          subCommand: "resolve",
        };
      }
      const result = await gitResolveConflict(file, strategy);
      return { ...result, subCommand: "resolve" };
    }

    case "help":
    default:
      return {
        ok: true,
        output: [
          "Git commands:",
          "  /git status              — working tree state",
          "  /git diff [file]         — unstaged changes",
          "  /git staged              — staged diff",
          "  /git log [n]             — last n commits (default 10)",
          "  /git branch              — list branches",
          "  /git checkout <branch>   — switch branch",
          "  /git add [file]          — stage file or all",
          "  /git commit <message>    — stage tracked + commit",
          "  /git push [remote] [branch]",
          "  /git stash [push|pop|list]",
          "  /git conflicts           — list files with merge conflicts",
          "  /git resolve <file> [ours|theirs|ai]  — resolve conflict in file",
          "  /git pr list             — list open PRs (requires gh CLI)",
          "  /git pr view [#]         — view PR details",
          "  /git suggest-commit      — AI-guess a commit message from staged diff",
        ].join("\n"),
        subCommand: "help",
      };
  }
}

// ---------------------------------------------------------------------------
// GitHub PR Loading (T-A42) — --from-pr flag
// ---------------------------------------------------------------------------

export interface PrContext {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR description/body */
  body: string;
  /** Author */
  author: string;
  /** Base branch */
  base: string;
  /** Head branch */
  head: string;
  /** Files changed */
  files: Array<{
    filename: string;
    status: "added" | "removed" | "modified" | "renamed";
    additions: number;
    deletions: number;
    patch?: string;
  }>;
  /** Full diff */
  diff: string;
  /** URL */
  url: string;
}

/**
 * Parse PR reference from various formats:
 * - https://github.com/owner/repo/pull/123
 * - owner/repo#123
 * - 123 (requires repo to be detected)
 */
export function parsePrReference(prRef: string): { owner?: string; repo?: string; number?: number } {
  // URL format: https://github.com/owner/repo/pull/123
  const urlMatch = prRef.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[3], 10) };
  }

  // Short URL: owner/repo#123
  const shortMatch = prRef.match(/^([^#\s]+)#(\d+)$/);
  if (shortMatch) {
    const [owner, repo] = shortMatch[1].split("/");
    return { owner, repo, number: parseInt(shortMatch[2], 10) };
  }

  // Just number: 123
  const numMatch = prRef.match(/^(\d+)$/);
  if (numMatch) {
    return { number: parseInt(numMatch[1], 10) };
  }

  return {};
}

/**
 * Load PR context from GitHub (requires gh CLI or GitHub token)
 */
export async function loadPrFromGitHub(
  prRef: string,
  options: { token?: string; owner?: string; repo?: string } = {}
): Promise<{ ok: boolean; data?: PrContext; error?: string }> {
  const parsed = parsePrReference(prRef);
  const number = parsed.number ?? options.number;
  
  if (!number) {
    return { ok: false, error: "Could not parse PR number from: " + prRef };
  }

  const owner = parsed.owner ?? options.owner;
  const repo = parsed.repo ?? options.repo;

  if (!owner || !repo) {
    // Try to detect from git remote
    const remoteResult = await git("remote get-url origin");
    if (remoteResult.ok) {
      const remoteMatch = remoteResult.output.match(/github\.com[/:]([^\/]+)\/(.+?)(\.git)?$/);
      if (remoteMatch) {
        const detectedOwner = parsed.owner ?? remoteMatch[1];
        const detectedRepo = parsed.repo ?? remoteMatch[2].replace(/\.git$/, "");
        return _fetchPrDetails(detectedOwner, detectedRepo, number, options.token);
      }
    }
    return { ok: false, error: "Could not detect repository. Please specify as owner/repo#123" };
  }

  return _fetchPrDetails(owner, repo, number, options.token);
}

async function _fetchPrDetails(
  owner: string,
  repo: string,
  number: number,
  token?: string
): Promise<{ ok: boolean; data?: PrContext; error?: string }> {
  // Try using gh CLI first
  const ghResult = await _tryGhCli(owner, repo, number);
  if (ghResult.ok) {
    return ghResult;
  }

  // Fall back to GitHub API
  if (!token) {
    return { ok: false, error: "No GitHub token available and gh CLI not found" };
  }

  try {
    // Get PR details
    const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!prResponse.ok) {
      return { ok: false, error: `GitHub API error: ${prResponse.status}` };
    }

    const pr = await prResponse.json();

    // Get PR files
    const filesResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files`, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${token}`,
      },
    });

    const files = await filesResponse.json();

    // Get diff
    const diffResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        Accept: "application/vnd.github.v3.diff",
        Authorization: `Bearer ${token}`,
      },
    });

    const diff = await diffResponse.text();

    const prContext: PrContext = {
      number: pr.number,
      title: pr.title,
      body: pr.body || "",
      author: pr.user.login,
      base: pr.base.ref,
      head: pr.head.ref,
      files: files.map((f: Record<string, unknown>) => ({
        filename: f.filename as string,
        status: f.status as "added" | "removed" | "modified" | "renamed",
        additions: f.additions as number,
        deletions: f.deletions as number,
        patch: f.patch as string | undefined,
      })),
      diff,
      url: pr.html_url,
    };

    return { ok: true, data: prContext };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function _tryGhCli(
  owner: string,
  repo: string,
  number: number
): Promise<{ ok: boolean; data?: PrContext; error?: string }> {
  try {
    // Check if gh is available
    const ghCheck = await import("child_process");
    ghCheck.execSync("gh --version", { stdio: "ignore" });
  } catch {
    return { ok: false, error: "gh CLI not found" };
  }

  try {
    const { execSync } = await import("child_process");

    // Get PR details
    const prJson = execSync(
      `gh pr view ${number} --repo ${owner}/${repo} --json title,body,author,baseRefName,headRefName,url,files`,
      { encoding: "utf-8" }
    );
    const pr = JSON.parse(prJson);

    // Get diff
    const diff = execSync(
      `gh pr diff ${number} --repo ${owner}/${repo}`,
      { encoding: "utf-8" }
    );

    const prContext: PrContext = {
      number,
      title: pr.title,
      body: pr.body || "",
      author: pr.author.login,
      base: pr.baseRefName,
      head: pr.headRefName,
      files: pr.files.map((f: Record<string, unknown>) => ({
        filename: f.path as string,
        status: f.status as "added" | "removed" | "modified" | "renamed",
        additions: f.additions as number,
        deletions: f.deletions as number,
        patch: f.patch as string | undefined,
      })),
      diff,
      url: pr.url,
    };

    return { ok: true, data: prContext };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Format PR context as a markdown block for injecting into conversation
 */
export function formatPrContextForConversation(pr: PrContext): string {
  const lines: string[] = [];
  
  lines.push(`# GitHub PR #${pr.number}: ${pr.title}`);
  lines.push("");
  lines.push(`**Author:** ${pr.author}`);
  lines.push(`**Branch:** ${pr.head} → ${pr.base}`);
  lines.push(`**URL:** ${pr.url}`);
  lines.push("");
  
  if (pr.body) {
    lines.push("## Description");
    lines.push("");
    lines.push(pr.body);
    lines.push("");
  }
  
  lines.push(`## Files Changed (${pr.files.length} files)`);
  lines.push("");
  
  for (const file of pr.files) {
    const symbol = file.status === "+" ? "+" : file.status === "-" ? "-" : "M";
    lines.push(`- ${symbol} ${file.filename} (+${file.additions} -${file.deletions})`);
  }
  
  lines.push("");
  lines.push("## Diff");
  lines.push("");
  lines.push("```diff");
  lines.push(pr.diff.slice(0, 50000)); // Limit diff size
  lines.push("```");
  
  return lines.join("\n");
}
