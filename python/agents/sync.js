#!/usr/bin/env node

/**
 * sync.js - Penpot Design Sync Bridge for Pakalon
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LIFECYCLE (the key design contract)
 * ─────────────────────────────────────────────────────────────────────────────
 *  • sync.js is the SOLE controller for Penpot start / stop.
 *  • When Penpot opens  → sync.js starts the file-change poll loop.
 *  • When Penpot closes → sync.js stops the poll loop and exits cleanly.
 *  • sync.js must be running for Penpot to be available; stopping sync.js
 *    (SIGTERM / SIGINT) also stops the Penpot container.
 *
 * COOLDOWN
 *  • After every successful sync a configurable cooldown window starts.
 *  • During the cooldown no polls are sent → prevents excessive token usage.
 *
 * BRIDGE (frontend → backend file sync)
 *  • While the browser has Penpot open the user may edit elements freely.
 *  • On each revision bump the updated design is exported as SVG + .penpot
 *    and written to .pakalon-agents/ai-agents/phase-2/.
 *
 * COMMANDS
 *   node sync.js --start     Start Penpot, open browser, begin sync loop
 *   node sync.js --stop      Stop sync loop + stop Penpot container
 *   node sync.js --watch     Watch only (assumes Penpot already running)
 *   node sync.js --lifecycle Auto-watch Penpot container lifecycle
 *
 * OPTIONS
 *   -p, --project <id>    Penpot project ID
 *   -f, --file    <id>    Penpot file ID  (required for change detection)
 *   -o, --output  <dir>   Root output dir  (default: .pakalon-agents)
 *   --interval    <ms>    Poll interval    (default: 5000)
 *   --cooldown    <ms>    Cooldown period  (default: 30000)
 *   --no-browser          Skip automatic browser open
 *   -h, --help
 *
 * ENV
 *   PENPOT_HOST           Penpot server URL  (default: http://localhost:3449)
 *   PENPOT_API_TOKEN      Token for Penpot REST API
 *   PAKALON_AGENTS_DIR    Root output dir    (default: .pakalon-agents)
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Configuration (overridden by CLI args) ───────────────────────────────────
const PENPOT_HOST       = process.env.PENPOT_HOST       || 'http://localhost:3449';
const PENPOT_API_TOKEN  = process.env.PENPOT_API_TOKEN  || '';
const DEFAULT_OUTPUT_DIR = process.env.PAKALON_AGENTS_DIR || '.pakalon-agents';

let POLL_INTERVAL    = 5000;   // ms — how often to check for file revisions
let COOLDOWN_PERIOD  = 30000;  // ms — quiet period after a sync (token guard)
let LIFECYCLE_CHECK  = 3000;   // ms — how often to check if Penpot is alive

// ─── Runtime state ────────────────────────────────────────────────────────────
let isWatching        = false;
let lastRevision      = 0;
let cooldownEndTime   = 0;
let pollTimerId       = null;
let lifecycleTimerId  = null;
let previouslyUp      = false;   // tracks last known state for lifecycle watchdog

let projectId  = null;
let fileId     = null;
let outputDir  = DEFAULT_OUTPUT_DIR;
let openBrowser = true;

// ─── Parse CLI args ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let command = 'watch';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--start':      command = 'start';     break;
      case '--stop':       command = 'stop';      break;
      case '--watch':      command = 'watch';     break;
      case '--lifecycle':  command = 'lifecycle'; break;
      case '-p': case '--project':  projectId  = args[++i]; break;
      case '-f': case '--file':     fileId     = args[++i]; break;
      case '-o': case '--output':   outputDir  = args[++i]; break;
      case '--interval':  POLL_INTERVAL   = parseInt(args[++i]) || POLL_INTERVAL;   break;
      case '--cooldown':  COOLDOWN_PERIOD = parseInt(args[++i]) || COOLDOWN_PERIOD; break;
      case '--no-browser': openBrowser = false; break;
      case '-h': case '--help': printHelp(); process.exit(0); break;
    }
  }
  return command;
}

// ─── Help text ────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
Pakalon · Penpot Design Sync Bridge

Usage:
  node sync.js [command] [options]

Commands:
  --start       Start Penpot container, open browser, begin sync loop
  --stop        Stop sync loop, then stop Penpot container
  --watch       Sync loop only (assumes Penpot is already up)
  --lifecycle   Auto-watch container state; start/stop sync automatically

Options:
  -p, --project <id>   Penpot project ID
  -f, --file    <id>   Penpot file ID (required for change detection)
  -o, --output  <dir>  Output root dir  [default: .pakalon-agents]
  --interval    <ms>   Poll interval    [default: 5000]
  --cooldown    <ms>   Cooldown period  [default: 30000]
  --no-browser         Do not open the browser automatically
  -h, --help

Env vars:
  PENPOT_HOST          Penpot server URL [default: http://localhost:3449]
  PENPOT_API_TOKEN     Penpot API bearer token
  PAKALON_AGENTS_DIR   Output root dir   [default: .pakalon-agents]

Examples:
  node sync.js --start  --project abc  --file xyz
  node sync.js --lifecycle  --file xyz   # preferred: managed lifecycle
  node sync.js --watch  --file xyz       # manual watch after external start
  node sync.js --stop
`);
}

// ─── Docker / container helpers ──────────────────────────────────────────────

/**
 * Returns true when the Penpot Docker container is in "running" state.
 */
function isPenpotRunning() {
  try {
    const out = execSync(
      'docker inspect --format="{{.State.Running}}" pakalon-penpot',
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.trim() === '"true"' || out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Returns true when the Penpot HTTP health endpoint responds 200.
 */
function isPenpotReachable() {
  return new Promise((resolve) => {
    const req = http.get(`${PENPOT_HOST}/api/rpc/command/get-profile`, (res) => {
      res.resume();
      // Any HTTP response (even 401) means the server is up
      resolve(res.statusCode < 500);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Start the Penpot Docker container.
 * This is the ONLY entry-point for launching Penpot — callers must use sync.js.
 */
async function startPenpot() {
  console.log('[sync] Starting Penpot container...');

  try {
    // Check if the container already exists (stopped)
    const existing = execSync(
      'docker ps -a --filter "name=pakalon-penpot" --format="{{.Names}}"',
      { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    if (existing.includes('pakalon-penpot')) {
      execSync('docker start pakalon-penpot', { stdio: 'inherit', timeout: 30000 });
      console.log('[sync] Existing Penpot container started');
    } else {
      // First-time run: spin up a new container
      execSync(
        'docker run -d --name pakalon-penpot -p 3449:80 penpotapp/frontend:2.11.1',
        { stdio: 'inherit', timeout: 120000 }
      );
      console.log('[sync] New Penpot container created and started');
    }

    // Wait until HTTP is reachable (max 60 s)
    console.log('[sync] Waiting for Penpot to be ready...');
    for (let i = 0; i < 30; i++) {
      if (await isPenpotReachable()) break;
      await sleep(2000);
    }
    console.log('[sync] Penpot is ready');
    return true;
  } catch (err) {
    console.error('[sync] Failed to start Penpot:', err.message);
    return false;
  }
}

/**
 * Stop the Penpot Docker container.
 * Called automatically when sync.js exits so Penpot lifecycle matches sync.js.
 */
function stopPenpot() {
  console.log('[sync] Stopping Penpot container...');
  try {
    execSync('docker stop pakalon-penpot', { stdio: 'inherit', timeout: 30000 });
    console.log('[sync] Penpot container stopped');
    return true;
  } catch (err) {
    console.error('[sync] Failed to stop Penpot:', err.message);
    return false;
  }
}

/**
 * Open the design in the default system browser.
 * If a fileId is known the URL points directly to that file; otherwise opens
 * the Penpot workspace root so the user can navigate manually.
 */
function openInBrowser(fId) {
  const url = fId
    ? `${PENPOT_HOST}/#/workspace/${fId}`
    : PENPOT_HOST;

  console.log(`[sync] Opening browser → ${url}`);
  try {
    if (process.platform === 'win32')       execSync(`start "" "${url}"`);
    else if (process.platform === 'darwin') execSync(`open "${url}"`);
    else                                    execSync(`xdg-open "${url}"`);
  } catch {
    console.warn('[sync] Could not open browser automatically. Visit:', url);
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Promise-based sleep */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Penpot API helpers ────────────────────────────────────────────────────────

/** Fetch the current revision number of the open file. Returns 0 on failure. */
async function getFileRevision() {
  if (!fileId) return 0;
  try {
    const res = await fetch(
      `${PENPOT_HOST}/api/rpc/command/get-file?id=${fileId}`,
      { headers: { Authorization: `Token ${PENPOT_API_TOKEN}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return data.revn || 0;
  } catch {
    return 0;
  }
}

/** Export the file as SVG or transit-JSON from Penpot. Returns null on failure. */
async function exportFile(format = 'json') {
  if (!fileId) return null;
  try {
    const endpoint = format === 'svg' ? 'export-file-object' : 'export-file';
    const typePart = format === 'svg' ? 'type=svg' : 'type=transit';
    const res = await fetch(
      `${PENPOT_HOST}/api/rpc/command/${endpoint}?file-id=${fileId}&${typePart}`,
      { headers: { Authorization: `Token ${PENPOT_API_TOKEN}` }, signal: AbortSignal.timeout(30000) }
    );
    if (!res.ok) return null;
    return format === 'svg' ? await res.text() : await res.json();
  } catch {
    return null;
  }
}

/**
 * Persist the exported SVG + .penpot JSON into the project directory.
 *  Primary:   .pakalon-agents/ai-agents/phase-2/Wireframe_generated.{svg,penpot}
 *  Secondary: .pakalon-agents/wireframes/wireframe_<timestamp>.{svg,penpot}
 */
function saveFiles(svg, penpotJson) {
  const phase2Dir    = join(outputDir, 'ai-agents', 'phase-2');
  const wireframeDir = join(outputDir, 'wireframes');

  for (const dir of [phase2Dir, wireframeDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  if (svg) {
    writeFileSync(join(phase2Dir,    'Wireframe_generated.svg'),    svg);
    writeFileSync(join(wireframeDir, `wireframe_${ts}.svg`),        svg);
    console.log('[sync] ✓ Saved SVG');
  }
  if (penpotJson) {
    const raw = JSON.stringify(penpotJson, null, 2);
    writeFileSync(join(phase2Dir,    'Wireframe_generated.penpot'), raw);
    writeFileSync(join(wireframeDir, `wireframe_${ts}.penpot`),     raw);
    console.log('[sync] ✓ Saved .penpot');
  }
}

// ─── Cooldown helpers ─────────────────────────────────────────────────────────

function isInCooldown() {
  return Date.now() < cooldownEndTime;
}

function triggerCooldown() {
  cooldownEndTime = Date.now() + COOLDOWN_PERIOD;
  console.log(`[sync] Cooldown started — next sync allowed in ${COOLDOWN_PERIOD / 1000}s`);
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function pollForChanges() {
  if (isInCooldown()) {
    const remaining = Math.ceil((cooldownEndTime - Date.now()) / 1000);
    if (remaining % 10 === 0) console.log(`[sync] Cooldown: ${remaining}s remaining…`);
    return;
  }
  if (!fileId) return;

  try {
    const current = await getFileRevision();
    if (current > lastRevision) {
      console.log(`[sync] Change detected — revision ${lastRevision} → ${current}`);
      const [svg, penpotJson] = await Promise.all([exportFile('svg'), exportFile('json')]);
      if (svg || penpotJson) {
        saveFiles(svg, penpotJson);
        console.log('[sync] Sync complete');
      } else {
        console.warn('[sync] Export returned empty — skipping save');
      }
      triggerCooldown();
      lastRevision = current;
    }
  } catch (err) {
    console.error('[sync] Poll error:', err.message);
  }
}

// ─── Watch (poll loop manager) ────────────────────────────────────────────────

function startWatching() {
  if (isWatching) { console.log('[sync] Already watching'); return; }
  console.log(`[sync] Watching for changes (interval: ${POLL_INTERVAL}ms, cooldown: ${COOLDOWN_PERIOD}ms)`);
  isWatching  = true;
  lastRevision = 0;
  pollTimerId = setInterval(pollForChanges, POLL_INTERVAL);
  pollForChanges();
}

function stopWatching() {
  if (!isWatching) return;
  console.log('[sync] Stopping watch loop');
  isWatching = false;
  if (pollTimerId) { clearInterval(pollTimerId); pollTimerId = null; }
}

// ─── Lifecycle watchdog ───────────────────────────────────────────────────────
/**
 * Preferred runtime mode.
 * Continuously checks if the Penpot Docker container is running:
 *  • Container just came UP   → start poll loop (open browser once)
 *  • Container just went DOWN → stop poll loop & exit
 */
let browserOpened = false;

function startLifecycleWatchdog() {
  console.log('[sync] Lifecycle watchdog active — monitoring Penpot container…');

  lifecycleTimerId = setInterval(async () => {
    const up = isPenpotRunning();

    if (up && !previouslyUp) {
      console.log('[sync] Penpot started — beginning sync');
      previouslyUp = true;
      if (openBrowser && !browserOpened) {
        await sleep(1500);
        openInBrowser(fileId);
        browserOpened = true;
      }
      startWatching();

    } else if (!up && previouslyUp) {
      console.log('[sync] Penpot stopped — halting sync');
      previouslyUp  = false;
      browserOpened = false;
      stopWatching();
      console.log('[sync] All loops stopped; exiting sync.js');
      gracefulExit(0);
    }
  }, LIFECYCLE_CHECK);
}

function stopLifecycleWatchdog() {
  if (lifecycleTimerId) { clearInterval(lifecycleTimerId); lifecycleTimerId = null; }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function gracefulExit(code = 0) {
  stopWatching();
  stopLifecycleWatchdog();
  console.log('[sync] sync.js shut down cleanly');
  process.exit(code);
}

process.on('SIGINT',  () => { console.log('\n[sync] SIGINT received');  stopPenpot(); gracefulExit(0); });
process.on('SIGTERM', () => { console.log('\n[sync] SIGTERM received'); stopPenpot(); gracefulExit(0); });

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const command = parseArgs();

  console.log('═'.repeat(55));
  console.log('  Pakalon · Penpot Design Sync Bridge');
  console.log('═'.repeat(55));
  console.log(`  Host     : ${PENPOT_HOST}`);
  console.log(`  Output   : ${outputDir}`);
  if (fileId)    console.log(`  File ID  : ${fileId}`);
  if (projectId) console.log(`  Project  : ${projectId}`);
  console.log(`  Interval : ${POLL_INTERVAL}ms`);
  console.log(`  Cooldown : ${COOLDOWN_PERIOD}ms`);
  console.log('─'.repeat(55));

  switch (command) {

    // --start ─────────────────────────────────────────────────────────────────
    case 'start': {
      const started = await startPenpot();
      if (!started) { console.error('[sync] Could not start Penpot. Aborting.'); process.exit(1); }
      if (openBrowser) { await sleep(1500); openInBrowser(fileId); browserOpened = true; }
      startWatching();
      previouslyUp = true;
      startLifecycleWatchdog();
      break;
    }

    // --stop ──────────────────────────────────────────────────────────────────
    case 'stop': {
      stopWatching();
      stopLifecycleWatchdog();
      stopPenpot();
      gracefulExit(0);
      break;
    }

    // --lifecycle ─────────────────────────────────────────────────────────────
    // Preferred long-running mode: watchdog handles everything automatically.
    case 'lifecycle': {
      previouslyUp = isPenpotRunning();
      if (previouslyUp) {
        console.log('[sync] Penpot already running — starting sync immediately');
        if (openBrowser) { openInBrowser(fileId); browserOpened = true; }
        startWatching();
      } else {
        console.log('[sync] Penpot not running — waiting for it to start…');
      }
      startLifecycleWatchdog();
      break;
    }

    // --watch (default) ───────────────────────────────────────────────────────
    case 'watch':
    default: {
      if (!isPenpotRunning()) {
        console.warn('[sync] ⚠  Penpot container is not running. Use --start or --lifecycle.');
      }
      startWatching();
      break;
    }
  }
}

// ─── Exports (for programmatic use from TypeScript bridge) ────────────────────
export {
  isPenpotRunning,
  startPenpot,
  stopPenpot,
  openInBrowser,
  startWatching,
  stopWatching,
  startLifecycleWatchdog,
  stopLifecycleWatchdog,
  exportFile,
  saveFiles,
  triggerCooldown,
  isInCooldown,
};

// Run when invoked directly
main().catch((err) => { console.error('[sync] Fatal error:', err); process.exit(1); });

