/**
 * Secure credential storage — reads and writes the Pakalon JWT token
 * to the OS-appropriate config directory.
 */
import fs from "fs";
import path from "path";
import os from "os";

export interface StoredCredentials {
  token: string;
  userId: string;
  plan: string;
  githubLogin?: string;
  displayName?: string;
  trialDaysRemaining?: number | null;
  billingDaysRemaining?: number | null;
  storedAt: string; // ISO timestamp
}

// Config directory: ~/.config/pakalon/ on Linux/macOS, %APPDATA%\pakalon\ on Windows
function getConfigDir(): string {
  const base =
    process.env.PAKALON_CONFIG_DIR ||
    (process.platform === "win32"
      ? path.join(process.env.APPDATA || os.homedir(), "pakalon")
      : path.join(os.homedir(), ".config", "pakalon"));

  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  }
  return base;
}

function getCredentialsPath(): string {
  return path.join(getConfigDir(), "credentials.json");
}

/**
 * Save credentials to disk (600 permissions on Unix).
 */
export function saveCredentials(creds: StoredCredentials): void {
  const credPath = getCredentialsPath();
  const content = JSON.stringify(creds, null, 2);
  fs.writeFileSync(credPath, content, { encoding: "utf8", mode: 0o600 });
}

/**
 * Load credentials from disk.
 * Returns null if no credentials file exists.
 */
export function loadCredentials(): StoredCredentials | null {
  const credPath = getCredentialsPath();
  if (!fs.existsSync(credPath)) return null;

  try {
    const raw = fs.readFileSync(credPath, "utf8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

/**
 * Delete the stored credentials (logout).
 */
export function clearCredentials(): void {
  const credPath = getCredentialsPath();
  if (fs.existsSync(credPath)) {
    fs.unlinkSync(credPath);
  }
}

/**
 * Return true if valid credentials are stored and the JWT has not expired.
 */
export function isAuthenticated(): boolean {
  const creds = loadCredentials();
  if (!creds?.token) return false;

  try {
    // Decode JWT payload without verification (expiry check only)
    const parts = creds.token.split(".");
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    const exp: number = payload.exp;
    if (!exp) return false;
    // Check if token expires in more than 5 minutes
    return exp * 1000 > Date.now() + 5 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Decode the plan from the stored JWT without verification.
 */
export function getPlanFromToken(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return "free";
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    return payload.plan ?? "free";
  } catch {
    return "free";
  }
}
