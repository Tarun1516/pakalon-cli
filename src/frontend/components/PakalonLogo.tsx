import React from "react";
import { Box } from "ink";
import InkBlack from "../../../assets/text-animation/ink-black.js";

type PakalonLogoVariant = "splash" | "header";

interface PakalonLogoProps {
  variant?: PakalonLogoVariant;
  align?: "flex-start" | "center" | "flex-end";
}

export function getPakalonLogoWidth(
  variant: PakalonLogoVariant,
  terminalWidth = process.stdout.columns ?? 120
): number {
  return 63; // Correct width of the ink-black animation asset
}

const PakalonLogo: React.FC<PakalonLogoProps> = ({
  variant = "splash",
  align = "center",
}) => {
  return (
    <Box flexDirection="column" alignItems={align} flexShrink={0}>
      <InkBlack loop={true} autoPlay={true} />
    </Box>
  );
};

export default PakalonLogo;
