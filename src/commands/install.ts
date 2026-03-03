/**
 * pakalon install — set up Python venv and install bridge dependencies.
 */
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { debugLog } from "@/utils/logger.js";

const VENV_DIR = path.join(os.homedir(), ".config", "pakalon", "venv");
const REQUIREMENTS_FILE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "python",
  "requirements.txt"
);

function findPython312(): string | null {
  for (const cmd of ["python3.12", "python3", "python"]) {
    try {
      const out = execSync(`${cmd} --version`, { encoding: "utf-8" }).trim();
      const match = out.match(/(\d+)\.(\d+)/);
      if (match) {
        const [, major, minor] = match.map(Number);
        if (major !== undefined && minor !== undefined && major === 3 && minor >= 10) return cmd;
      }
    } catch { /* try next */ }
  }
  return null;
}

export async function cmdInstall(): Promise<void> {
  console.log("\n✦ Pakalon Install — Setting up Python bridge\n");

  // Step 1: Find Python
  const pythonCmd = findPython312();
  if (!pythonCmd) {
    console.error("✗ Python 3.10+ not found. Install it from https://python.org");
    process.exit(1);
  }
  console.log(`  ✓ Found Python: ${pythonCmd}`);

  // Step 2: Create venv
  console.log(`\n  Creating virtual environment at ${VENV_DIR}...`);
  try {
    fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
    execSync(`${pythonCmd} -m venv "${VENV_DIR}"`, { stdio: "pipe" });
    console.log("  ✓ Virtual environment created");
  } catch (err) {
    console.error(`  ✗ Failed to create venv: ${String(err)}`);
    process.exit(1);
  }

  // Step 3: Get pip path
  const pip = os.platform() === "win32"
    ? path.join(VENV_DIR, "Scripts", "pip")
    : path.join(VENV_DIR, "bin", "pip");

  // Step 4: Upgrade pip
  console.log("\n  Upgrading pip...");
  try {
    execSync(`"${pip}" install --upgrade pip`, { stdio: "pipe" });
    console.log("  ✓ pip upgraded");
  } catch { /* non-fatal */ }

  // Step 5: Install requirements
  const reqFile = fs.existsSync(REQUIREMENTS_FILE)
    ? REQUIREMENTS_FILE
    : path.join(process.cwd(), "python", "requirements.txt");

  if (!fs.existsSync(reqFile)) {
    console.error(`  ✗ requirements.txt not found at ${reqFile}`);
    process.exit(1);
  }

  console.log(`\n  Installing Python dependencies from ${path.basename(reqFile)}...`);
  console.log("  (This may take a few minutes)\n");

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(pip, ["install", "-r", reqFile, "--progress-bar", "on"], {
      stdio: "inherit",
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pip exited with code ${code}`));
    });
    proc.on("error", reject);
  }).catch((err) => {
    console.error(`\n  ✗ Failed to install dependencies: ${String(err)}`);
    process.exit(1);
  });

  console.log("\n  ✓ Python dependencies installed");

  // Step 6: Check Docker for Penpot
  console.log("\n  Checking Docker for Penpot...");
  try {
    execSync("docker info", { stdio: "pipe" });
    console.log("  ✓ Docker running");
    console.log("  Note: Penpot will be pulled automatically when agentic mode first runs.");
  } catch {
    console.log("  ⚠ Docker not running — Penpot wireframe generation will be unavailable");
    console.log("    Install Docker Desktop: https://docker.com/products/docker-desktop");
  }

  console.log("\n✓ Installation complete! Run `pakalon` to get started.\n");
  debugLog("[install] Installation completed successfully");
}
