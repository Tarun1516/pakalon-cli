#!/usr/bin/env node
/**
 * postinstall.js — First-run Python environment bootstrap.
 *
 * Runs automatically after `npm install` / `bun install`.
 * Creates a virtualenv at python/.venv and installs python/requirements.txt.
 *
 * Silently skips if:
 *  - Python 3 is not found on PATH
 *  - python/requirements.txt doesn't exist
 *  - PAKALON_SKIP_PYTHON_SETUP=1 env var is set
 */

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const PYTHON_DIR = path.join(ROOT, "python");
const VENV_DIR = path.join(PYTHON_DIR, ".venv");
const REQUIREMENTS = path.join(PYTHON_DIR, "requirements.txt");

// ── Skip checks ────────────────────────────────────────────────────────────
if (process.env.PAKALON_SKIP_PYTHON_SETUP === "1") {
  process.exit(0);
}

if (!fs.existsSync(REQUIREMENTS)) {
  // No requirements file — nothing to do
  process.exit(0);
}

// ── Locate Python 3 ─────────────────────────────────────────────────────────
function findPython() {
  const candidates = ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ["--version"], { encoding: "utf8" });
      if (result.status === 0) {
        const versionStr = (result.stdout || result.stderr || "").trim();
        // Accept Python 3.9+
        const match = versionStr.match(/Python (\d+)\.(\d+)/);
        if (match && parseInt(match[1]) >= 3 && parseInt(match[2]) >= 9) {
          return cmd;
        }
      }
    } catch {
      // not found
    }
  }
  return null;
}

const python = findPython();
if (!python) {
  console.warn(
    "[pakalon] Python 3.9+ not found — skipping Python agent setup.\n" +
    "         Install Python 3.9+ and re-run `npm install` to enable AI agents."
  );
  process.exit(0);
}

// ── Create virtualenv ────────────────────────────────────────────────────────
if (!fs.existsSync(VENV_DIR)) {
  console.log("[pakalon] Creating Python virtualenv at python/.venv …");
  const venvResult = spawnSync(python, ["-m", "venv", VENV_DIR], {
    stdio: "inherit",
    encoding: "utf8",
  });
  if (venvResult.status !== 0) {
    console.warn("[pakalon] Failed to create venv — agents will use system Python.");
    process.exit(0);
  }
}

// ── Locate pip in venv ───────────────────────────────────────────────────────
const isWindows = process.platform === "win32";
const venvPip = isWindows
  ? path.join(VENV_DIR, "Scripts", "pip.exe")
  : path.join(VENV_DIR, "bin", "pip");

const pipCmd = fs.existsSync(venvPip) ? venvPip : "pip";

// ── Install requirements ─────────────────────────────────────────────────────
console.log("[pakalon] Installing Python dependencies (python/requirements.txt) …");

// First attempt: bulk install with --prefer-binary (skips C++ compilation if wheels exist)
const installResult = spawnSync(
  pipCmd,
  ["install", "-r", REQUIREMENTS, "--quiet", "--disable-pip-version-check", "--prefer-binary"],
  { stdio: "inherit", encoding: "utf8" }
);

if (installResult.status !== 0) {
  // Fallback: install package-by-package so C++ failures don't block everything else
  console.warn("[pakalon] Bulk install incomplete — retrying package-by-package (C++ packages will be skipped if no binary wheel is available) …");
  const lines = fs.readFileSync(REQUIREMENTS, "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && !l.startsWith("-"));

  let ok = 0;
  let skip = 0;
  for (const pkg of lines) {
    const r = spawnSync(
      pipCmd,
      ["install", pkg, "--quiet", "--disable-pip-version-check", "--prefer-binary"],
      { stdio: "pipe", encoding: "utf8" }
    );
    if (r.status !== 0) {
      console.warn(`[pakalon] ⚠ Skipped (no wheel): ${pkg}`);
      skip++;
    } else {
      ok++;
    }
  }
  console.log(`[pakalon] ✓ Python environment ready (${ok} installed, ${skip} skipped — skipped packages require C++ Build Tools).`);
} else {
  console.log("[pakalon] ✓ Python environment ready.");
}
