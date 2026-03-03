/**
 * env-mask.ts — Strip .env file contents and secrets from LLM context.
 * T1-8: Prevent private keys, passwords, and tokens from being sent to OpenRouter.
 */

import fs from "fs";
import path from "path";

/** File patterns that should never be read into LLM context. */
const BLOCKED_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  ".env.staging",
  ".env.example", // technically safe to read, but mask anyway
  ".envrc",
  "secrets.yaml",
  "secrets.yml",
  ".secrets",
  "credentials",
  "credentials.json",
  "service-account.json",
  "serviceaccount.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
]);

/** Regex patterns for secret values within file content. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(?i:api[_\-]?key)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{16,})/g, label: "api_key" },
  { pattern: /(?i:password|passwd|pwd)\s*[:=]\s*['"]([^'"]{6,})/g, label: "password" },
  { pattern: /(?i:secret[_\-]?key?)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{16,})/g, label: "secret" },
  { pattern: /bearer\s+([A-Za-z0-9\-_.]{20,})/gi, label: "bearer_token" },
  { pattern: /sk-[A-Za-z0-9]{32,}/g, label: "openai_key" },
  { pattern: /ghp_[A-Za-z0-9]{36}/g, label: "github_pat" },
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "aws_access_key" },
  { pattern: /(?i:mongodb(?:\+srv)?:\/\/[^\s'"]+)/g, label: "mongodb_uri" },
  { pattern: /(?i:postgres(?:ql)?:\/\/[^\s'"]+)/g, label: "postgres_uri" },
  { pattern: /(?i:mysql:\/\/[^\s'"]+)/g, label: "mysql_uri" },
  { pattern: /(?i:redis:\/\/[^\s'"]+)/g, label: "redis_uri" },
];

/**
 * Returns true if a file path should be blocked from LLM context.
 */
export function isBlockedFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return BLOCKED_FILENAMES.has(basename) || basename.startsWith(".env");
}

/**
 * Mask secret values in file content before sending to LLM.
 * Returns the masked string.
 */
export function maskSecrets(content: string): string {
  let masked = content;
  for (const { pattern, label } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (match, captured) => {
      if (captured && captured.length >= 6) {
        const keep = Math.min(4, Math.floor(captured.length / 4));
        const stars = "*".repeat(Math.max(4, captured.length - keep));
        return match.replace(captured, captured.slice(0, keep) + stars);
      }
      return `[REDACTED_${label.toUpperCase()}]`;
    });
  }
  return masked;
}

/**
 * Read a file for LLM context, applying masking and blocking rules.
 * Returns null if the file is blocked.
 * Returns masked content otherwise.
 */
export function safeReadForContext(filePath: string): string | null {
  if (isBlockedFile(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return maskSecrets(content);
  } catch {
    return null;
  }
}

/**
 * Filter a list of file paths, removing any that are blocked.
 * Returns the filtered list with a list of blocked files for logging.
 */
export function filterContextFiles(filePaths: string[]): {
  safe: string[];
  blocked: string[];
} {
  const safe: string[] = [];
  const blocked: string[] = [];
  for (const fp of filePaths) {
    if (isBlockedFile(fp)) {
      blocked.push(fp);
    } else {
      safe.push(fp);
    }
  }
  return { safe, blocked };
}

/**
 * Scan a directory for .env files and return their paths (for warning purposes).
 */
export function findEnvFiles(dir: string): string[] {
  const found: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && isBlockedFile(entry.name)) {
        found.push(path.join(dir, entry.name));
      }
    }
  } catch {
    // Ignore read errors
  }
  return found;
}
