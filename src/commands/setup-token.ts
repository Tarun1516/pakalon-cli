/**
 * pakalon setup-token — manually set a JWT token (for CI/CD environments).
 */
import { saveCredentials, clearCredentials, getPlanFromToken } from "@/auth/storage.js";
import { createApiClient } from "@/api/client.js";
import { debugLog } from "@/utils/logger.js";

function promptToken(): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write("  Enter your Pakalon JWT token: ");
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
      if (data.includes("\n")) {
        process.stdin.pause();
        resolve(data.trim());
      }
    });
  });
}

export async function cmdSetupToken(): Promise<void> {
  console.log("\n✦ Pakalon Token Setup (CI/CD Mode)\n");
  console.log("Provide a Pakalon JWT token to authenticate without a browser.");
  console.log("Get your token from: https://pakalon.com/dashboard/profile\n");

  let token: string;

  const envToken = process.env["PAKALON_TOKEN"];
  if (envToken) {
    token = envToken;
    console.log("  Using token from PAKALON_TOKEN environment variable.");
  } else if (!process.stdin.isTTY) {
    // Read from stdin pipe
    token = await new Promise<string>((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk: string) => { data += chunk; });
      process.stdin.on("end", () => resolve(data.trim()));
    });
  } else {
    token = await promptToken();
  }

  if (!token || token.length < 20) {
    console.error("✗ Invalid token — too short or empty.");
    process.exit(1);
  }

  // Validate token against API
  console.log("\n  Validating token...");
  try {
    const api = createApiClient();
    // Manually set Authorization header for this one call
    const res = await api.get<{ id: string; plan: string; github_login?: string }>(
      "/auth/me",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const me = res.data;

    saveCredentials({
      token,
      userId: me.id,
      plan: me.plan,
      githubLogin: me.github_login,
      storedAt: new Date().toISOString(),
    });

    console.log(`  ✓ Token valid — logged in as: ${me.github_login ?? me.id}`);
    console.log(`  ✓ Plan: ${me.plan}`);
    console.log("\n✓ Token saved. Pakalon is ready to use.\n");
    debugLog(`[setup-token] Token configured for user ${me.id}`);
  } catch (err) {
    console.error(`\n  ✗ Token validation failed: ${String(err)}`);
    clearCredentials();
    process.exit(1);
  }
}
