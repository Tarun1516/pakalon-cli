/**
 * Banner — ASCII art header showing logo, username, and active model.
 * Uses figlet for dynamic banner rendering; falls back to static art if unavailable.
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";

const STATIC_LOGO = `
  ▄███████▄  ▄████████  ▄█   ▄█▄    ▄████████  ▄█        ▄██████▄  ███▄▄▄▄   
  ███    ███ ███    ███ ███ ▄███▀   ███    ███ ███       ███    ███ ███▀▀▀██▄ 
  ███    ███ ███    ███ ███▐██▀     ███    ███ ███       ███    ███ ███    ███
  ████████▀  ██████████ █████▀      ██████████ ███       ███    ███ ███    ███
  ███        ███    ███ ███▀▀██▄    ███    ███ ███       ███    ███ ███    ███
  ███        ███    ███ ███   ███   ███    ███ ███       ███    ███ ███    ███
 ▄████▀      ███    ███ ███    ███  ███    ███ ███▌    ▄ ████████▀   ███    ███
             ███    █▀  ▀████████▀  ███    █▀  █████▄▄██             ▀██████▀ 
`.replace(/^\n/, "").replace(/\n$/, "");

/** Generate figlet banner synchronously at mount, fall back to static art. */
function useBannerText(text: string, font?: string): string {
  return useMemo(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const figlet = require("figlet") as {
        textSync: (txt: string, options?: { font?: string }) => string;
        fontsSync: () => string[];
      };
      const availableFonts = figlet.fontsSync();
      const preferredFonts = ["Small Slant", "Small", "Lean", "Calvin S"];
      const selectedFont = font ?? preferredFonts.find((f) => availableFonts.includes(f)) ?? "Standard";
      return figlet.textSync(text, { font: selectedFont });
    } catch {
      return STATIC_LOGO;
    }
  }, [text, font]);
}

interface BannerProps {
  version?: string;
  plan?: string;
  githubLogin?: string;
  /** Active model ID — displayed prominently beneath the logo */
  modelId?: string | null;
  /** Override figlet font (optional) */
  font?: string;
}

const Banner: React.FC<BannerProps> = ({ version = "0.1.0", plan, githubLogin, modelId, font }) => {
  const logoText = STATIC_LOGO;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="white" backgroundColor="black" bold>
        {logoText}
      </Text>
      <Box gap={2} marginTop={1}>
        {/* Username */}
        {githubLogin && (
          <Box gap={1}>
            <Text dimColor>user</Text>
            <Text color="#ff8c00" bold>@{githubLogin}</Text>
          </Box>
        )}
        {/* Active model */}
        {modelId && (
          <Box gap={1}>
            <Text dimColor>model</Text>
            <Text color="yellow" bold>
              {modelId.length > 45 ? `…${modelId.slice(-42)}` : modelId}
            </Text>
          </Box>
        )}
        {/* Version (smaller, dimmed) */}
        <Text dimColor>v{version}</Text>
        {plan && (
          <Text color={plan === "pro" ? "yellow" : "white"}>
            [{plan.toUpperCase()}]
          </Text>
        )}
      </Box>
    </Box>
  );
};

export default Banner;

