#!/usr/bin/env node
/**
 * sync.js — Project-local Penpot Design Sync Bridge launcher.
 *
 * This stub re-exports and delegates to the CLI's canonical sync.js.
 * Run it directly:  node .pakalon-agents/ai-agents/sync.js --lifecycle
 */
const { execFileSync } = await import('child_process');
const { fileURLToPath } = await import('url');
const { join, dirname } = await import('path');

const __dir  = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dir, '..', '..', '..', 'pakalon-cli', 'python', 'agents', 'sync.js');

// Pass all CLI arguments through to the canonical sync.js
execFileSync(process.execPath, [cliDir, ...process.argv.slice(2)], {
  stdio : 'inherit',
  cwd   : join(__dir, '..', '..'),   // project root (where .pakalon-agents lives)
  env   : { ...process.env, PAKALON_AGENTS_DIR: join(__dir, '..', '..', '.pakalon-agents') },
});
