/**
 * Penpot Sync Service - TypeScript implementation
 * 
 * Manages the sync between Penpot frontend changes and backend files.
 * This service:
 * - Starts/stops the sync.js background process
 * - Monitors Penpot container lifecycle
 * - Handles cooldown to prevent excessive token usage
 * 
 * Used by the /penpot CLI command
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { PenpotTool } from "../tools/penpot.js";

const SYNC_SCRIPT_PATH = path.join(
  process.cwd(),
  "pakalon-cli",
  "python",
  "agents",
  "sync.js"
);

const DEFAULT_COOLDOWN_MS = 30000; // 30 seconds

export interface SyncOptions {
  projectId?: string;
  fileId?: string;
  outputDir?: string;
  pollInterval?: number;
  cooldownPeriod?: number;
}

export interface SyncStatus {
  isRunning: boolean;
  isPenpotRunning: boolean;
  lastSyncTime: Date | null;
  lastChangeTime: Date | null;
  inCooldown: boolean;
}

class PenpotSyncService {
  private syncProcess: ChildProcess | null = null;
  private penpotTool: PenpotTool;
  private options: SyncOptions = {};
  private lastSyncTime: Date | null = null;
  private lastChangeTime: Date | null = null;
  private cooldownEndTime: number = 0;

  constructor() {
    this.penpotTool = new PenpotTool();
  }

  /**
   * Check if Penpot Docker container is running
   */
  isPenpotRunning(): boolean {
    return this.penpotTool.is_running();
  }

  /**
   * Start Penpot container
   */
  async startPenpot(): Promise<boolean> {
    console.log("[penpot-sync] Starting Penpot container...");
    return this.penpotTool.start_container();
  }

  /**
   * Stop Penpot container
   */
  async stopPenpot(): Promise<boolean> {
    console.log("[penpot-sync] Stopping Penpot container...");
    try {
      execSync("docker stop pakalon-penpot", { stdio: "inherit", timeout: 30000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start the sync process
   */
  async startSync(options: SyncOptions = {}): Promise<boolean> {
    this.options = {
      pollInterval: 5000,
      cooldownPeriod: DEFAULT_COOLDOWN_MS,
      outputDir: ".pakalon-agents",
      ...options,
    };

    // Check if sync script exists
    if (!existsSync(SYNC_SCRIPT_PATH)) {
      console.error("[penpot-sync] Sync script not found:", SYNC_SCRIPT_PATH);
      return false;
    }

    // Start Penpot if not running
    if (!this.isPenpotRunning()) {
      await this.startPenpot();
    }

    // Build arguments
    const args = [
      SYNC_SCRIPT_PATH,
      "--watch",
      "--interval",
      String(this.options.pollInterval),
    ];

    if (this.options.fileId) {
      args.push("--file", this.options.fileId);
    }

    if (this.options.projectId) {
      args.push("--project", this.options.projectId);
    }

    if (this.options.outputDir) {
      args.push("--output", this.options.outputDir);
    }

    // Start sync process
    console.log("[penpot-sync] Starting sync process...");
    this.syncProcess = spawn("node", args, {
      stdio: "inherit",
      detached: true,
    });

    this.syncProcess.on("error", (error) => {
      console.error("[penpot-sync] Sync process error:", error);
    });

    this.syncProcess.on("exit", (code) => {
      console.log("[penpot-sync] Sync process exited with code:", code);
      this.syncProcess = null;
    });

    return true;
  }

  /**
   * Stop the sync process
   */
  async stopSync(): Promise<boolean> {
    if (this.syncProcess) {
      console.log("[penpot-sync] Stopping sync process...");
      this.syncProcess.kill("SIGTERM");
      this.syncProcess = null;
    }

    // Optionally stop Penpot
    // await this.stopPenpot();

    return true;
  }

  /**
   * Open Penpot in browser
   */
  openInBrowser(fileId?: string): void {
    const { exec } = require("child_process");
    const url = fileId
      ? `http://localhost:3449/#/project/${fileId}`
      : "http://localhost:3449";

    // Detect OS and open browser
    if (process.platform === "win32") {
      exec(`start "" "${url}"`);
    } else if (process.platform === "darwin") {
      exec(`open "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }

    console.log("[penpot-sync] Opened Penpot in browser:", url);
  }

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    return {
      isRunning: this.syncProcess !== null,
      isPenpotRunning: this.isPenpotRunning(),
      lastSyncTime: this.lastSyncTime,
      lastChangeTime: this.lastChangeTime,
      inCooldown: Date.now() < this.cooldownEndTime,
    };
  }

  /**
   * Trigger cooldown manually
   */
  triggerCooldown(): void {
    const cooldownPeriod = this.options.cooldownPeriod || DEFAULT_COOLDOWN_MS;
    this.cooldownEndTime = Date.now() + cooldownPeriod;
    this.lastChangeTime = new Date();
    console.log(
      `[penpot-sync] Cooldown triggered for ${cooldownPeriod / 1000}s`
    );
  }

  /**
   * Check if in cooldown period
   */
  isInCooldown(): boolean {
    return Date.now() < this.cooldownEndTime;
  }
}

// Export singleton instance
export const penpotSync = new PenpotSyncService();
export default penpotSync;
