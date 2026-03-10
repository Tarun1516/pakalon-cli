import React from "react";
import { Box, Text } from "ink";
import chalk from "chalk";

type PakalonLogoVariant = "splash" | "header";

interface PakalonLogoProps {
  variant?: PakalonLogoVariant;
  align?: "flex-start" | "center" | "flex-end";
}

const WHITE_FILL = chalk.whiteBright;

const FALLBACK_TEXT: Record<PakalonLogoVariant, string> = {
  splash: "PAKALON",
  header: "PAKALON",
};

const CUSTOM_LOGO_LINES = [
  "██████╗  █████╗ ██╗  ██╗ █████╗ ██╗      ██████╗ ███╗   ██╗",
  "██╔══██╗██╔══██╗██║ ██╔╝██╔══██╗██║     ██╔═══██╗████╗  ██║",
  "██████╔╝███████║█████╔╝ ███████║██║     ██║   ██║██╔██╗ ██║",
  "██╔═══╝ ██╔══██║██╔═██╗ ██╔══██║██║     ██║   ██║██║╚██╗██║",
  "██║     ██║  ██║██║  ██╗██║  ██║███████╗╚██████╔╝██║ ╚████║",
  "╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝",
];

function styleCustomLogo(lines: string[]): string[] {
  return lines.map((line) =>
    Array.from(line)
      .map((char) => (char === " " ? char : WHITE_FILL(char)))
      .join("")
  );
}

function getLogoLines(variant: PakalonLogoVariant): string[] {
  const terminalWidth = process.stdout.columns ?? 120;
  const widestLine = Math.max(...CUSTOM_LOGO_LINES.map((line) => line.length), 0);
  const minimumPadding = variant === "header" ? 10 : 4;

  if (widestLine + minimumPadding <= terminalWidth) {
    return styleCustomLogo(CUSTOM_LOGO_LINES);
  }

  return [WHITE_FILL(FALLBACK_TEXT[variant])];
}

const PakalonLogo: React.FC<PakalonLogoProps> = ({
  variant = "splash",
  align = "center",
}) => {
  const lines = getLogoLines(variant);

  return (
    <Box flexDirection="column" alignItems={align}>
      {lines.map((line, index) => (
        <Text key={`${variant}-${index}`}>{line}</Text>
      ))}
    </Box>
  );
};

export default PakalonLogo;
