/**
 * Python bridge manager — spawns and monitors the local bridge server process.
 */
import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { bridgePing } from "./client.js";
import logger from "@/utils/logger.js";
import { BRIDGE_PORT } from "./types.js";

let _bridgeProcess: ChildProcess | null = null;
let _startPromise: Promise<void> | null = null;

const BRIDGE_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "../../python/bridge/server.py"
);

const PYTHON_VENV = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "../../python/.venv"
);

function getPythonExecutable(): string {
  const venvPython = os.platform() === "win32"
    ? path.join(PYTHON_VENV, "Scripts", "python.exe")
    : path.join(PYTHON_VENV, "bin", "python");

  if (fs.existsSync(venvPython)) return venvPython;
  return os.platform() === "win32" ? "python" : "python3";
}

export async function startBridge(timeoutMs = 10_000): Promise<void> {
  if (_startPromise) return _startPromise;

  _startPromise = new Promise(async (resolve, reject) => {
    // Check if already running
    if (await bridgePing()) {
      logger.debug("Bridge already running");
      resolve();
      return;
    }

    if (!fs.existsSync(BRIDGE_SCRIPT)) {
      reject(new Error(`Bridge script not found: ${BRIDGE_SCRIPT}`));
      return;
    }

    const python = getPythonExecutable();
    const logDir = path.join(os.homedir(), ".config", "pakalon");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = fs.openSync(path.join(logDir, "bridge.log"), "a");

    logger.debug("Spawning bridge", { python, script: BRIDGE_SCRIPT, port: BRIDGE_PORT });

    _bridgeProcess = spawn(python, [BRIDGE_SCRIPT, "--port", String(BRIDGE_PORT)], {
      detached: false,
      stdio: ["ignore", logFile, logFile],
      env: { ...process.env },
    });

    _bridgeProcess.on("error", (err) => {
      logger.error("Bridge spawn error", { err: err.message });
      _startPromise = null;
      reject(err);
    });

    // Wait for bridge to become ready
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      if (await bridgePing()) {
        logger.debug("Bridge ready");
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Bridge did not start within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 300);
    };
    setTimeout(poll, 500);
  });

  return _startPromise;
}

export function stopBridge(): void {
  if (_bridgeProcess) {
    _bridgeProcess.kill("SIGTERM");
    _bridgeProcess = null;
    _startPromise = null;
    logger.debug("Bridge stopped");
  }
}

export function isBridgeRunning(): boolean {
  return _bridgeProcess !== null && !_bridgeProcess.killed;
}
