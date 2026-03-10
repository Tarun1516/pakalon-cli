export function getShellWidth(terminalWidth = process.stdout.columns ?? 80): number {
  if (terminalWidth <= 72) {
    return Math.max(26, terminalWidth - 4);
  }

  if (terminalWidth <= 96) {
    return Math.max(32, terminalWidth - 8);
  }

  return 72;
}

export function makeHorizontalRule(width: number, character = "─"): string {
  return character.repeat(Math.max(0, width));
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (maxLength <= 3 || value.length <= maxLength) {
    return value;
  }

  const visible = maxLength - 3;
  const start = Math.ceil(visible / 2);
  const end = Math.floor(visible / 2);
  return `${value.slice(0, start)}...${value.slice(value.length - end)}`;
}
