/**
 * /trace command — view the cross-phase decision registry written by Pakalon agents.
 *
 * Sub-commands:
 *   list   [projectDir]        – list all recorded decisions (sorted by phase)
 *   show   <id> [projectDir]   – show a single decision and its linked decisions
 *   links  <id> [projectDir]   – show all links for a decision
 *   summary [projectDir]       – show a by-phase breakdown count
 *   search <term> [projectDir] – search descriptions for a keyword
 */

import fs from "fs";
import path from "path";
import { debugLog } from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types (mirror decision_registry.py schema)
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  id: string;
  phase: number;
  decision_type: string;
  description: string;
  source_file?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface DecisionLink {
  from_id: string;
  to_id: string;
  relationship: string;
  timestamp: string;
}

interface DecisionRegistry {
  decisions: DecisionRecord[];
  links: DecisionLink[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProjectDir(projectDir?: string): string {
  return projectDir ? path.resolve(projectDir) : process.cwd();
}

function registryPath(projectDir: string): string {
  return path.join(projectDir, ".pakalon-agents", "decisions.json");
}

function loadRegistry(projectDir: string): DecisionRegistry {
  const p = registryPath(projectDir);
  if (!fs.existsSync(p)) return { decisions: [], links: [] };
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as DecisionRegistry;
  } catch {
    return { decisions: [], links: [] };
  }
}

const PHASE_NAMES: Record<number, string> = {
  1: "Requirements",
  2: "TDD / Architecture",
  3: "Implementation",
  4: "Security & Testing",
  5: "CI/CD",
  6: "Documentation",
};

function phaseLabel(phase: number): string {
  return PHASE_NAMES[phase] ? `Phase ${phase} — ${PHASE_NAMES[phase]}` : `Phase ${phase}`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const TYPE_COLOUR: Record<string, string> = {
  requirement:       "\x1b[36m", // cyan
  phase_output:      "\x1b[32m", // green
  security_finding:  "\x1b[31m", // red
  technology_choice: "\x1b[35m", // magenta
  implementation:    "\x1b[34m", // blue
  test_strategy:     "\x1b[33m", // yellow
};
const RESET = "\x1b[0m";

function typeColour(t: string): string {
  return TYPE_COLOUR[t] ?? "\x1b[37m";
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

/**
 * List all decisions grouped by phase.
 */
export function cmdTraceList(
  projectDir?: string,
  opts: { type?: string; phase?: number } = {}
): void {
  const dir = resolveProjectDir(projectDir);
  const registry = loadRegistry(dir);
  let decisions = [...registry.decisions];

  if (decisions.length === 0) {
    console.log(`\n  No decisions recorded yet at: ${dir}`);
    console.log("  Decisions are written automatically as agents run.\n");
    return;
  }

  if (opts.type) {
    decisions = decisions.filter((d) => d.decision_type === opts.type);
  }
  if (opts.phase !== undefined) {
    decisions = decisions.filter((d) => d.phase === opts.phase);
  }

  // Sort by phase, then timestamp
  decisions.sort((a, b) => {
    if (a.phase !== b.phase) return a.phase - b.phase;
    return a.timestamp.localeCompare(b.timestamp);
  });

  // Group by phase
  const byPhase = new Map<number, DecisionRecord[]>();
  for (const d of decisions) {
    if (!byPhase.has(d.phase)) byPhase.set(d.phase, []);
    byPhase.get(d.phase)!.push(d);
  }

  console.log(`\n── Decision Registry (${decisions.length} total) ─────────────────────────────\n`);

  for (const [phase, recs] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${phaseLabel(phase)} (${recs.length})`);
    for (const d of recs) {
      const col = typeColour(d.decision_type);
      const desc = d.description.length > 80
        ? d.description.slice(0, 77) + "..."
        : d.description;
      console.log(`    ${col}[${d.decision_type}]${RESET}  ${d.id.slice(-8)}  ${desc}`);
    }
    console.log();
  }

  debugLog(`[trace] Listed ${decisions.length} decisions from ${dir}`);
}

/**
 * Show a single decision record by (partial) ID.
 */
export function cmdTraceShow(id: string, projectDir?: string): void {
  const dir = resolveProjectDir(projectDir);
  const registry = loadRegistry(dir);

  const decision = registry.decisions.find(
    (d) => d.id === id || d.id.endsWith(id)
  );

  if (!decision) {
    console.error(`\n  Decision "${id}" not found.\n`);
    return;
  }

  console.log(`\n── Decision ${decision.id} ──────────────────────────────────────────\n`);
  console.log(`  Phase:       ${phaseLabel(decision.phase)}`);
  console.log(`  Type:        ${typeColour(decision.decision_type)}${decision.decision_type}${RESET}`);
  console.log(`  Recorded:    ${formatTime(decision.timestamp)}`);
  if (decision.source_file) console.log(`  Source file: ${decision.source_file}`);
  console.log();
  console.log(`  ${decision.description}`);
  console.log();

  if (decision.metadata && Object.keys(decision.metadata).length > 0) {
    console.log("  Metadata:");
    for (const [k, v] of Object.entries(decision.metadata)) {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      console.log(`    ${k.padEnd(24)} ${val}`);
    }
    console.log();
  }

  // Show linked decisions
  const links = registry.links.filter(
    (l) => l.from_id === decision.id || l.to_id === decision.id
  );
  if (links.length > 0) {
    console.log(`  Links (${links.length}):`);
    for (const l of links) {
      const other = l.from_id === decision.id ? l.to_id : l.from_id;
      const dir_arrow = l.from_id === decision.id ? "→" : "←";
      const otherRec = registry.decisions.find((d) => d.id === other);
      const label = otherRec
        ? `${other.slice(-8)}  ${otherRec.description.slice(0, 60)}`
        : other.slice(-8);
      console.log(`    ${dir_arrow} [${l.relationship}]  ${label}`);
    }
    console.log();
  }
}

/**
 * Show decision-count summary by phase.
 */
export function cmdTraceSummary(projectDir?: string): void {
  const dir = resolveProjectDir(projectDir);
  const registry = loadRegistry(dir);

  const byPhase: Record<number, Record<string, number>> = {};
  for (const d of registry.decisions) {
    if (!byPhase[d.phase]) byPhase[d.phase] = {};
    byPhase[d.phase]![d.decision_type] = (byPhase[d.phase]![d.decision_type] ?? 0) + 1;
  }

  console.log(`\n── Decision Registry Summary ──────────────────────────────────\n`);
  console.log(`  Total decisions: ${registry.decisions.length}`);
  console.log(`  Total links:     ${registry.links.length}`);
  console.log();

  for (const phase of Object.keys(byPhase).map(Number).sort()) {
    const types = byPhase[phase]!;
    const total = Object.values(types).reduce((a, b) => a + b, 0);
    console.log(`  ${phaseLabel(phase).padEnd(38)} ${total} decisions`);
    for (const [t, count] of Object.entries(types)) {
      console.log(`    ${typeColour(t)}${t}${RESET}:  ${count}`);
    }
    console.log();
  }
}

/**
 * Search decision descriptions for a keyword or phrase.
 */
export function cmdTraceSearch(term: string, projectDir?: string): void {
  const dir = resolveProjectDir(projectDir);
  const registry = loadRegistry(dir);
  const q = term.toLowerCase();

  const matches = registry.decisions.filter(
    (d) =>
      d.description.toLowerCase().includes(q) ||
      d.decision_type.toLowerCase().includes(q) ||
      JSON.stringify(d.metadata ?? {}).toLowerCase().includes(q)
  );

  if (matches.length === 0) {
    console.log(`\n  No decisions matching "${term}".\n`);
    return;
  }

  console.log(`\n── Search results for "${term}" (${matches.length}) ────────────\n`);
  for (const d of matches) {
    const col = typeColour(d.decision_type);
    console.log(`  ${col}[${d.decision_type}]${RESET}  ${d.id.slice(-8)}  Phase ${d.phase}`);
    console.log(`    ${d.description}`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Main entry-point dispatcher
// ---------------------------------------------------------------------------

export async function cmdTrace(
  subcommand: string = "list",
  args: string[] = [],
  opts: Record<string, string | boolean> = {}
): Promise<void> {
  const projectDir = (opts["project"] as string) ??
    args.find((a) => a && !a.startsWith("--") && subcommand !== a);

  switch (subcommand) {
    case "list":
      return cmdTraceList(projectDir, {
        type: opts["type"] as string | undefined,
        phase: opts["phase"] !== undefined ? Number(opts["phase"]) : undefined,
      });

    case "show": {
      const id = args.find((a) => a !== subcommand && !a.startsWith("--"));
      if (!id) { console.error("  Usage: pakalon trace show <id>"); return; }
      return cmdTraceShow(id, projectDir);
    }

    case "links": {
      const id = args.find((a) => a !== subcommand && !a.startsWith("--"));
      if (!id) { console.error("  Usage: pakalon trace links <id>"); return; }
      const registry = loadRegistry(resolveProjectDir(projectDir));
      const links = registry.links.filter((l) => l.from_id.endsWith(id) || l.to_id.endsWith(id));
      if (links.length === 0) { console.log(`\n  No links for decision "${id}".\n`); return; }
      console.log(`\n── Links for ${id} ────────────────────────────────────\n`);
      for (const l of links) {
        console.log(`  ${l.from_id.slice(-8)} → [${l.relationship}] → ${l.to_id.slice(-8)}`);
      }
      console.log();
      return;
    }

    case "summary":
      return cmdTraceSummary(projectDir);

    case "search": {
      const term = args.find((a) => a !== subcommand && !a.startsWith("--"));
      if (!term) { console.error("  Usage: pakalon trace search <term>"); return; }
      return cmdTraceSearch(term, projectDir);
    }

    default:
      console.log(`
Usage: pakalon trace <subcommand> [options]

Subcommands:
  list    [dir]              List all decisions grouped by phase (default)
  show    <id> [dir]         Show full detail for a decision
  links   <id> [dir]         Show links for a decision
  summary [dir]              Count-by-phase and type breakdown
  search  <term> [dir]       Search decision descriptions

Options:
  --type=<decision_type>     Filter list by type (requirement, security_finding, …)
  --phase=<n>                Filter list by phase number
  --project=<dir>            Override project directory
`);
  }
}
