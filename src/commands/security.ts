/**
 * /security command — view, filter, and act on Phase 4 security findings.
 *
 * Sub-commands:
 *   report [projectDir]          – print the full phase-4.md report to stdout
 *   findings [projectDir]        – list all normalised findings (CRITICAL → INFO)
 *   filter --severity=HIGH|...   – filter findings by severity / OWASP category
 *   tools                        – list available SAST / DAST tools and their status
 *   fix [projectDir]             – forward HIGH+ findings back into Phase 3 for re-fixing
 */

import fs from "fs";
import path from "path";
import { debugLog } from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecurityFinding {
  id: string;
  title: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  owasp_category?: string;
  owasp_name?: string;
  cwe_ids?: string[];
  source?: string;
  file?: string;
  line?: number;
  description?: string;
  remediation?: string;
}

export interface SecurityReport {
  phase: string;
  generated_at?: string;
  findings: SecurityFinding[];
  summary?: Record<string, unknown>;
  raw_md?: string;
}

// ---------------------------------------------------------------------------
// Helpers — locate artefacts
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: SecurityFinding["severity"][] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

function resolveProjectDir(projectDir?: string): string {
  return projectDir ? path.resolve(projectDir) : process.cwd();
}

function phase4Dir(projectDir: string): string {
  return path.join(projectDir, ".pakalon-agents", "phase-4");
}

/**
 * Try to read and parse the consolidated `findings.json` file written by the
 * phase-4 Python agent.  Falls back to a best-effort parse of `phase-4.md`.
 */
function loadFindings(projectDir: string): SecurityFinding[] {
  const dir = phase4Dir(projectDir);

  // Prefer structured JSON
  const jsonPath = path.join(dir, "findings.json");
  if (fs.existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      if (Array.isArray(raw)) return raw as SecurityFinding[];
      if (Array.isArray(raw.findings)) return raw.findings as SecurityFinding[];
    } catch {
      // fall through
    }
  }

  // Decision-registry summary may also contain security_finding records
  const registryPath = path.join(projectDir, ".pakalon-agents", "decisions.json");
  if (fs.existsSync(registryPath)) {
    try {
      const decisions = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as Array<{
        decision_type: string;
        description: string;
        metadata?: Record<string, unknown>;
        id: string;
        timestamp: string;
      }>;
      const secFindings = decisions.filter((d) => d.decision_type === "security_finding");
      if (secFindings.length > 0) {
        return secFindings.map((d) => ({
          id: d.id,
          title: d.description,
          severity: ((d.metadata?.severity as string) ?? "MEDIUM").toUpperCase() as SecurityFinding["severity"],
          owasp_category: d.metadata?.owasp_category as string | undefined,
          owasp_name: d.metadata?.owasp_name as string | undefined,
          cwe_ids: d.metadata?.cwe_ids as string[] | undefined,
          source: d.metadata?.source as string | undefined,
          description: d.description,
        }));
      }
    } catch {
      // fall through
    }
  }

  return [];
}

function loadReportMd(projectDir: string): string | null {
  const candidates = [
    path.join(phase4Dir(projectDir), "phase-4.md"),
    path.join(projectDir, ".pakalon-agents", "phase-4.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  }
  return null;
}

function severityColour(sev: string): string {
  switch (sev) {
    case "CRITICAL": return "\x1b[35m"; // magenta
    case "HIGH":     return "\x1b[31m"; // red
    case "MEDIUM":   return "\x1b[33m"; // yellow
    case "LOW":      return "\x1b[34m"; // blue
    default:         return "\x1b[37m"; // white
  }
}
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

/**
 * Print the raw phase-4.md report.
 */
export function cmdSecurityReport(projectDir?: string): void {
  const dir = resolveProjectDir(projectDir);
  const md = loadReportMd(dir);

  if (!md) {
    console.error(`\n✗ No security report found for project at: ${dir}`);
    console.error("  Run Phase 4 first: pakalon run --phase 4\n");
    return;
  }

  console.log(`\n── Security Report ──────────────────────────────────────────\n`);
  console.log(md);
}

/**
 * List all findings, sorted by severity.
 */
export function cmdSecurityFindings(
  projectDir?: string,
  opts: { severity?: string; owasp?: string; source?: string } = {}
): void {
  const dir = resolveProjectDir(projectDir);
  let findings = loadFindings(dir);

  if (findings.length === 0) {
    console.log(`\n✓ No security findings recorded for project at: ${dir}`);
    console.log("  Run Phase 4 first: pakalon run --phase 4\n");
    return;
  }

  // Apply filters
  if (opts.severity) {
    const sev = opts.severity.toUpperCase();
    findings = findings.filter((f) => f.severity === sev);
  }
  if (opts.owasp) {
    const ow = opts.owasp.toLowerCase();
    findings = findings.filter(
      (f) =>
        f.owasp_category?.toLowerCase().includes(ow) ||
        f.owasp_name?.toLowerCase().includes(ow)
    );
  }
  if (opts.source) {
    const src = opts.source.toLowerCase();
    findings = findings.filter((f) => f.source?.toLowerCase() === src);
  }

  // Sort by severity
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  // Count by severity for summary line
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  const summary = SEVERITY_ORDER
    .filter((s) => counts[s])
    .map((s) => `${severityColour(s)}${counts[s]} ${s}${RESET}`)
    .join("  ");

  console.log(`\n── Security Findings (${findings.length}) — ${summary || "none"} ──────────────\n`);

  for (const f of findings) {
    const col = severityColour(f.severity);
    const owaspTag = f.owasp_category ? `  [${f.owasp_category}]` : "";
    const cweTag = f.cwe_ids?.length ? `  [CWE: ${f.cwe_ids.join(",")}]` : "";
    const srcTag = f.source ? `  src:${f.source}` : "";
    console.log(`${col}  [${f.severity}]${RESET}  ${f.title}${owaspTag}${cweTag}${srcTag}`);
    if (f.file) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`          → ${loc}`);
    }
    if (f.remediation) {
      console.log(`          Fix: ${f.remediation.slice(0, 120)}`);
    }
    console.log();
  }

  debugLog(`[security] Listed ${findings.length} findings from ${dir}`);
}

/**
 * Print available security tools and their status (present in PATH / Docker).
 */
export async function cmdSecurityTools(): Promise<void> {
  const { execSync } = await import("child_process");

  const tools: Array<{ name: string; type: "SAST" | "DAST"; cmd: string; dockerImage?: string }> = [
    { name: "semgrep",    type: "SAST", cmd: "semgrep --version" },
    { name: "bandit",     type: "SAST", cmd: "bandit --version" },
    { name: "gitleaks",   type: "SAST", cmd: "gitleaks version" },
    { name: "eslint",     type: "SAST", cmd: "eslint --version" },
    { name: "OWASP ZAP",  type: "DAST", cmd: "zap.sh -version", dockerImage: "zaproxy/zap-stable" },
    { name: "Nikto",      type: "DAST", cmd: "nikto -Version", dockerImage: "frapsoft/nikto" },
    { name: "wapiti",     type: "DAST", cmd: "wapiti --version", dockerImage: "wapiti3/wapiti" },
    { name: "docker",     type: "DAST", cmd: "docker --version" },
  ];

  console.log(`\n── Security Tools ──────────────────────────────────────────\n`);
  console.log(`  ${"Tool".padEnd(22)} ${"Type".padEnd(8)} Status`);
  console.log(`  ${"─".repeat(22)} ${"─".repeat(8)} ──────────`);

  for (const tool of tools) {
    let status = "✗ not found";
    try {
      execSync(tool.cmd, { stdio: "pipe", timeout: 8_000 });
      status = "✓ available";
    } catch {
      if (tool.dockerImage) {
        // Check if Docker image is pulled
        try {
          const images = execSync(`docker images --format "{{.Repository}}" ${tool.dockerImage}`, {
            stdio: "pipe",
            timeout: 8_000,
          }).toString().trim();
          if (images) {
            status = "✓ docker image ready";
          } else {
            status = "○ available via docker pull";
          }
        } catch {
          status = "✗ not found";
        }
      }
    }
    console.log(`  ${tool.name.padEnd(22)} ${tool.type.padEnd(8)} ${status}`);
  }

  console.log();
}

/**
 * Forward HIGH / CRITICAL findings back into Phase 3 for automated re-fixing.
 *
 * Writes a `fix-requests.json` file to `.pakalon-agents/` which the Phase 3
 * graph reads on next invocation (same retry loop mechanism added in Item D).
 */
export function cmdSecurityFix(projectDir?: string): void {
  const dir = resolveProjectDir(projectDir);
  const findings = loadFindings(dir);

  const actionable = findings.filter((f) =>
    f.severity === "CRITICAL" || f.severity === "HIGH"
  );

  if (actionable.length === 0) {
    console.log("\n✓ No HIGH or CRITICAL findings to fix.\n");
    return;
  }

  const agentsDir = path.join(dir, ".pakalon-agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  const fixRequests = actionable.map((f) => ({
    finding_id: f.id,
    severity: f.severity,
    title: f.title,
    owasp_category: f.owasp_category,
    cwe_ids: f.cwe_ids,
    source_file: f.file,
    line: f.line,
    description: f.description,
    remediation: f.remediation,
    requested_at: new Date().toISOString(),
  }));

  const outPath = path.join(agentsDir, "fix-requests.json");
  fs.writeFileSync(outPath, JSON.stringify(fixRequests, null, 2), "utf-8");

  console.log(`\n✓ ${actionable.length} security fix request(s) written to .pakalon-agents/fix-requests.json`);
  console.log("  Phase 3 will pick up these requests on next run.\n");
  console.log("  Run with: pakalon run --phase 3 --fix-security\n");

  for (const f of actionable) {
    const col = severityColour(f.severity);
    console.log(`  ${col}[${f.severity}]${RESET}  ${f.title}`);
  }
  console.log();

  debugLog(`[security] Wrote ${actionable.length} fix requests to ${outPath}`);
}

// ---------------------------------------------------------------------------
// Main entry-point dispatcher
// ---------------------------------------------------------------------------

export async function cmdSecurity(
  subcommand: string = "findings",
  args: string[] = [],
  opts: Record<string, string | boolean> = {}
): Promise<void> {
  const projectDir = (opts["project"] as string) ?? args.find((a) => !a.startsWith("--"));

  switch (subcommand) {
    case "report":
      return cmdSecurityReport(projectDir);

    case "findings":
    case "list":
      return cmdSecurityFindings(projectDir, {
        severity: opts["severity"] as string | undefined,
        owasp: opts["owasp"] as string | undefined,
        source: opts["source"] as string | undefined,
      });

    case "tools":
      return cmdSecurityTools();

    case "fix":
      return cmdSecurityFix(projectDir);

    default:
      console.log(`
Usage: pakalon security <subcommand> [options]

Subcommands:
  findings [dir]               List all security findings (default)
  report   [dir]               Show the full phase-4.md report
  tools                        Show available SAST/DAST tools
  fix      [dir]               Forward HIGH/CRITICAL issues to Phase 3 for re-fixing

Options:
  --severity=CRITICAL|HIGH|MEDIUM|LOW|INFO   Filter findings by severity
  --owasp=<category>                          Filter by OWASP category
  --source=zap|nikto|semgrep|...             Filter by scan source
  --project=<dir>                             Override project directory
`);
  }
}
