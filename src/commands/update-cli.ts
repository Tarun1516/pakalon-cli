/**
 * pakalon update — check for and install latest Pakalon version.
 */
import { execSync } from "child_process";
import { debugLog } from "@/utils/logger.js";

interface NpmPackageInfo {
  "dist-tags": { latest: string };
  version?: string;
}

async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/pakalon/latest", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json() as { version: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function getCurrentVersion(): string {
  try {
    // Try to read version from package.json via process
    return process.env["npm_package_version"] ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function compareVersions(current: string, latest: string): number {
  const toNum = (v: string) => v.split(".").map((n) => parseInt(n, 10));
  const c = toNum(current);
  const l = toNum(latest);
  for (let i = 0; i < 3; i++) {
    const ci = c[i] ?? 0;
    const li = l[i] ?? 0;
    if (ci < li) return -1;
    if (ci > li) return 1;
  }
  return 0;
}

export async function cmdUpdateCli(opts: { yes?: boolean } = {}): Promise<void> {
  console.log("\n✦ Checking for updates...\n");

  const current = getCurrentVersion();
  console.log(`  Current version: ${current}`);

  const latest = await getLatestVersion();
  if (!latest) {
    console.error("  ✗ Could not check latest version. Check your internet connection.");
    process.exit(1);
  }

  console.log(`  Latest version:  ${latest}`);

  const cmp = compareVersions(current, latest);
  if (cmp >= 0) {
    console.log("\n✓ Pakalon is already up to date!\n");
    return;
  }

  console.log(`\n  New version available: ${current} → ${latest}`);

  if (!opts.yes) {
    const response = await new Promise<string>((resolve) => {
      process.stdout.write("\n  Update now? [Y/n]: ");
      let data = "";
      const stdin = process.stdin;
      stdin.setEncoding("utf-8");
      const onData = (chunk: string) => {
        data += chunk;
        if (data.includes("\n")) {
          stdin.removeListener("data", onData);
          stdin.pause();
          resolve(data.trim());
        }
      };
      stdin.on("data", onData);
      stdin.resume();
    });

    if (response.toLowerCase() === "n" || response.toLowerCase() === "no") {
      console.log("\n  Update skipped.\n");
      return;
    }
  }

  console.log(`\n  Installing pakalon@${latest}...\n`);

  try {
    execSync(`npm install -g pakalon@latest`, { stdio: "inherit" });
    console.log(`\n✓ Successfully updated to pakalon@${latest}!\n`);
    debugLog(`[update-cli] Updated from ${current} to ${latest}`);
  } catch (err) {
    console.error(`\n✗ Update failed: ${String(err)}`);
    console.log("  Try manually: npm install -g pakalon@latest");
    process.exit(1);
  }
}
