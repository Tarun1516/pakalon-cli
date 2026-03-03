/**
 * Format utilities — token counts, durations, truncation.
 */

/** Format a token count for display: 1234 → "1.2k", 12345 → "12k" */
export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

/** Format milliseconds as a human-readable duration */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/** Truncate a string to maxLen, appending "…" if cut */
export function truncate(str: string, maxLen = 80): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/** Pad a string to a fixed width (right-pad with spaces) */
export function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/** Format bytes as human-readable */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Wrap text at word boundaries */
export function wordWrap(text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let curr = "";
  for (const word of words) {
    if (curr.length + word.length + 1 > width) {
      if (curr) lines.push(curr);
      curr = word;
    } else {
      curr = curr ? `${curr} ${word}` : word;
    }
  }
  if (curr) lines.push(curr);
  return lines;
}
