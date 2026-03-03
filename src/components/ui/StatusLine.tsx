/**
 * StatusLine — bottom bar showing model, plan, permission mode, session info,
 * live token counter (Epic A-01), and git branch + PR/CI status (T-CLI-58).
 *
 * T-CLI-STATUS-LINE: Supports a scriptable statusLine.command config option.
 * When set, the command is executed periodically and its stdout is appended
 * to the right side of the status bar (Claude Code parity).
 */
import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { useStore } from "@/store/index.js";
import type { InteractionMode, PermissionMode } from "@/store/slices/mode.slice.js";

const execFileAsync = promisify(execFile);

// T-CLI-58: CI status types
type CiStatus = "pending" | "success" | "failure" | "cancelled" | null;

interface GitBranchInfo {
  branch: string | null;
  prNumber: number | null;
  ciStatus: CiStatus;
}

/** Poll current git branch and optional GitHub PR CI status (T-CLI-58) */
async function fetchGitBranchInfo(cwd?: string): Promise<GitBranchInfo> {
  const opts = { cwd: cwd ?? process.cwd() };
  let branch: string | null = null;
  let prNumber: number | null = null;
  let ciStatus: CiStatus = null;

  // Get current branch name
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], opts);
    branch = stdout.trim() || null;
  } catch {
    return { branch: null, prNumber: null, ciStatus: null };
  }

  if (!branch) return { branch, prNumber, ciStatus };

  // Try gh CLI to get PR + CI status (non-blocking — gh may not be installed)
  try {
    const { stdout: prOut } = await execFileAsync(
      "gh", ["pr", "view", "--json", "number,statusCheckRollup", "--jq", ".number,.statusCheckRollup[0].status"],
      { ...opts, timeout: 4000 },
    );
    const lines = prOut.trim().split("\n");
    const num = parseInt(lines[0] ?? "", 10);
    if (!isNaN(num)) prNumber = num;
    const statusRaw = (lines[1] ?? "").trim().toLowerCase();
    if (statusRaw === "completed") {
      // check conclusion
      const { stdout: concOut } = await execFileAsync(
        "gh", ["pr", "view", "--json", "statusCheckRollup", "--jq", ".statusCheckRollup[0].conclusion"],
        { ...opts, timeout: 4000 },
      );
      const conclusion = concOut.trim().toLowerCase();
      ciStatus = conclusion === "success" ? "success" : conclusion === "failure" || conclusion === "failure" ? "failure" : "cancelled";
    } else if (statusRaw === "in_progress" || statusRaw === "queued") {
      ciStatus = "pending";
    }
  } catch {
    // gh not installed or no PR — silently skip
  }

  return { branch, prNumber, ciStatus };
}

// ---------------------------------------------------------------------------
// T-CLI-STATUS-LINE: Scriptable status line command runner
// ---------------------------------------------------------------------------

/**
 * Read the statusLine.command setting from .pakalon/settings.json or ~/.config/pakalon/settings.json.
 * Returns the command string, or null if not configured.
 */
function readStatusLineCommand(projectDir?: string): string | null {
  const candidates = [
    projectDir ? path.join(projectDir, ".pakalon", "settings.json") : null,
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".config", "pakalon", "settings.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const s = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
        const cmd = (s["statusLine"] as Record<string, unknown> | undefined)?.["command"];
        if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Execute the statusLine.command and return its trimmed stdout.
 * Non-blocking — returns "" on error.
 */
async function runStatusLineCommand(command: string, cwd?: string): Promise<string> {
  try {
    const { exec } = await import("child_process");
    const { promisify: _p } = await import("util");
    const execAsync = _p(exec);
    const { stdout } = await execAsync(command, {
      cwd: cwd ?? process.cwd(),
      timeout: 3000,
      maxBuffer: 512,
    });
    return stdout.trim().split("\n")[0]?.trim() ?? "";
  } catch {
    return "";
  }
}

const CI_STATUS_ICON: Record<NonNullable<CiStatus>, string> = {
  pending: "◔",
  success: "✓",
  failure: "✗",
  cancelled: "⊘",
};

const CI_STATUS_COLOR: Record<NonNullable<CiStatus>, string> = {
  pending: "yellow",
  success: "green",
  failure: "red",
  cancelled: "gray",
};

interface StatusLineProps {
  modelId?: string | null;
  plan?: string;
  mode?: InteractionMode;
  trialDaysRemaining?: number | null;
  isStreaming?: boolean;
  messageCount?: number;
  /** Live token count used in the current session (A-01) */
  estimatedTokens?: number;
  /** Total context window for current model (A-01) */
  contextLimit?: number;
  /** Whether privacy mode is active (M-02) */
  privacyMode?: boolean;
  /** Default model display name */
  defaultModel?: string | null;
  /** T-CLI-58: project directory for git branch detection */
  projectDir?: string;
}

const PERMISSION_MODE_COLORS: Record<PermissionMode, string> = {
  plan: "blue",
  edit: "yellow",
  "auto-accept": "green",
  bypass: "red",
};

const StatusLine: React.FC<StatusLineProps> = ({
  modelId,
  plan,
  mode = "chat",
  trialDaysRemaining,
  isStreaming,
  messageCount = 0,
  estimatedTokens,
  contextLimit,
  privacyMode,
  defaultModel,
  projectDir,
}) => {
  const permissionMode = useStore((s) => s.permissionMode);
  const thinkingEnabled = useStore((s) => s.thinkingEnabled);
  const verbose = useStore((s) => s.verbose);

  // T-CLI-58: Git branch + PR/CI status — polled every 30s
  const [gitInfo, setGitInfo] = useState<GitBranchInfo>({ branch: null, prNumber: null, ciStatus: null });
  const gitPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const poll = () => { fetchGitBranchInfo(projectDir).then(setGitInfo).catch(() => {}); };
    poll();
    gitPollRef.current = setInterval(poll, 30_000);
    return () => { if (gitPollRef.current) clearInterval(gitPollRef.current); };
  }, [projectDir]);

  // T-CLI-STATUS-LINE: Scriptable status line command — polled every 10s
  const [scriptOutput, setScriptOutput] = useState<string>("");
  const scriptCmdRef = useRef<string | null>(null);
  useEffect(() => {
    // Lazy-read the command once (it rarely changes)
    scriptCmdRef.current = readStatusLineCommand(projectDir);
    if (!scriptCmdRef.current) return;

    const poll = () => {
      if (!scriptCmdRef.current) return;
      runStatusLineCommand(scriptCmdRef.current, projectDir).then(setScriptOutput).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [projectDir]);

  // Flashing alert state for near-limit context (> 85%)
  const [flashOn, setFlashOn] = useState(true);
  const usedPct =
    estimatedTokens && contextLimit && contextLimit > 0
      ? Math.round((estimatedTokens / contextLimit) * 100)
      : null;
  const isNearLimit = usedPct !== null && usedPct >= 85;
  const isExhausted = usedPct !== null && usedPct >= 100;

  useEffect(() => {
    if (!isNearLimit) return;
    const id = setInterval(() => setFlashOn((v) => !v), 1000);
    return () => clearInterval(id);
  }, [isNearLimit]);

  const tokenColor = isExhausted
    ? "red"
    : isNearLimit
    ? flashOn ? "red" : "yellow"
    : usedPct !== null && usedPct >= 60
    ? "yellow"
    : "green";

  const modeColor: Record<InteractionMode, string> = {
    chat: "green",
    agent: "yellow",
    headless: "blue",
  };

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Box gap={2}>
        {/* Interaction mode */}
        <Text color={modeColor[mode] ?? "white"}>
          [{mode.toUpperCase()}]
        </Text>

        {/* Permission mode (T-CLI-18) */}
        <Text color={PERMISSION_MODE_COLORS[permissionMode]} bold>
          {permissionMode.toUpperCase()}
        </Text>

        {/* Thinking mode indicator (T-CLI-19) */}
        {thinkingEnabled && <Text color="magenta">🧠</Text>}

        {/* Privacy mode indicator (M-02) */}
        {privacyMode && <Text color="cyan">🔒</Text>}

        {/* Verbose indicator (T164) */}
        {verbose && <Text color="gray">VERBOSE</Text>}

        {/* Model name — show default if no session model (US-A) */}
        {(modelId || defaultModel) && (
          <Text dimColor>
            {(() => {
              const m = modelId ?? defaultModel ?? "";
              return m.length > 40 ? `...${m.slice(-37)}` : m;
            })()}
          </Text>
        )}

        {/* T-CLI-58: Git branch + PR CI indicator */}
        {gitInfo.branch && (
          <Text color="cyan">
            ⎇ {gitInfo.branch}
            {gitInfo.prNumber ? ` #${gitInfo.prNumber}` : ""}
            {gitInfo.ciStatus ? ` ${CI_STATUS_ICON[gitInfo.ciStatus]}` : ""}
          </Text>
        )}

        {/* Live token counter (Epic A-01) */}
        {estimatedTokens !== undefined && contextLimit !== undefined && contextLimit > 0 && (
          <Text color={tokenColor}>
            {isExhausted
              ? `⛔ ${(estimatedTokens / 1000).toFixed(1)}k / ${(contextLimit / 1000).toFixed(0)}k (FULL)`
              : `${(estimatedTokens / 1000).toFixed(1)}k / ${(contextLimit / 1000).toFixed(0)}k (${usedPct}%)`}
          </Text>
        )}

        {/* Streaming indicator */}
        {isStreaming && <Text color="cyan">◉ streaming</Text>}
      </Box>

      <Box gap={2}>
        {/* T-CLI-STATUS-LINE: Scriptable command output */}
        {scriptOutput && (
          <Text color="gray">{scriptOutput}</Text>
        )}

        {/* Message count */}
        {messageCount > 0 && (
          <Text dimColor>{messageCount} msg{messageCount !== 1 ? "s" : ""}</Text>
        )}

        {/* Plan indicator */}
        {plan && (
          <Text color={plan === "pro" ? "yellow" : "white"}>
            {plan.toUpperCase()}
          </Text>
        )}

        {/* Trial days warning */}
        {trialDaysRemaining !== null &&
          trialDaysRemaining !== undefined &&
          trialDaysRemaining <= 5 && (
            <Text color={trialDaysRemaining <= 2 ? "red" : "yellow"}>
              ⚠ {trialDaysRemaining}d trial
            </Text>
          )}
      </Box>
    </Box>
  );
};

export default StatusLine;
