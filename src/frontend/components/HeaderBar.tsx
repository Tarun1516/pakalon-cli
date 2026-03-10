/**
 * HeaderBar — single authenticated header card.
 *
 * Design: Black background with golden (#E8AA41) border box containing:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │                      [PAKALON LOGO]                          │
 *   │                user: actual-user • model: active-model       │
 *   │                 session_id: live-backend-session-id          │
 *   └──────────────────────────────────────────────────────────────┘
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { useAuth, useModel, useStore } from "@/store/index.js";
import PakalonLogo, { getPakalonLogoWidth } from "@/frontend/components/PakalonLogo.js";
import { PAKALON_GOLD, TEXT_SECONDARY } from "@/constants/colors.js";
import { getShellWidth, truncateMiddle } from "@/utils/shell-layout.js";

interface HeaderBarProps {
  /** Show the logo above the info bar (default true) */
  showLogo?: boolean;
  sessionId?: string;
}

const IdentityField: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Text>
    <Text color="white" bold>{label} </Text>
    <Text color={PAKALON_GOLD}>&lt;{value}&gt;</Text>
  </Text>
);

const HeaderBar: React.FC<HeaderBarProps> = ({ showLogo = true, sessionId: sessionIdOverride }) => {
  const { githubLogin, displayName } = useAuth();
  const { selectedModel } = useModel();
  const sessionId = useStore((s) => s.sessionId);
  const terminalWidth = process.stdout.columns ?? 120;
  const baseWidth = getShellWidth(terminalWidth);
  const logoWidth = showLogo ? getPakalonLogoWidth("header", terminalWidth) : 0;
  const shellWidth = Math.max(logoWidth + 4, Math.min(85, terminalWidth - 2));
  const compactLayout = terminalWidth < 68;

  const modelDisplay = selectedModel?.trim() || "none";
  const primaryName = useMemo(() => {
    const trimmedDisplay = displayName?.trim();
    if (trimmedDisplay) return trimmedDisplay;
    const trimmedLogin = githubLogin?.trim();
    return trimmedLogin || "Pakalon User";
  }, [displayName, githubLogin]);

  const secondaryIdentity = useMemo(() => {
    const trimmedDisplay = displayName?.trim()?.toLowerCase();
    const trimmedLogin = githubLogin?.trim();
    if (!trimmedLogin) return null;
    if (trimmedDisplay && trimmedDisplay === trimmedLogin.toLowerCase()) return null;
    return trimmedLogin;
  }, [displayName, githubLogin]);

  const identityDisplay = secondaryIdentity ? `${primaryName} (${secondaryIdentity})` : primaryName;
  const currentSessionDisplay = sessionIdOverride ?? sessionId ?? "creating...";
  const userMaxLength = compactLayout ? 12 : 16;
  const modelMaxLength = compactLayout ? 16 : 22;
  const sessionMaxLength = compactLayout ? 10 : 14;

  const justify = shellWidth >= terminalWidth - 2 ? "flex-start" : "center";

  return (
    <Box width="100%" justifyContent={justify} marginTop={0} flexShrink={0} overflow="hidden">
      <Box
        borderStyle="single"
        borderColor={PAKALON_GOLD}
        flexDirection="column"
        width={shellWidth}
        paddingX={compactLayout ? 1 : 2}
        paddingY={0}
        flexShrink={0}
      >
        {showLogo && (
          <Box justifyContent="center" marginBottom={1} marginTop={1}>
            <PakalonLogo variant="header" align="center" />
          </Box>
        )}

        <Box justifyContent="center" gap={compactLayout ? 2 : 3} marginBottom={1}>
          <IdentityField label="User" value={truncateMiddle(identityDisplay, userMaxLength)} />
          <IdentityField label="Model" value={truncateMiddle(modelDisplay, modelMaxLength)} />
          <IdentityField label="Session" value={truncateMiddle(currentSessionDisplay, sessionMaxLength)} />
        </Box>
      </Box>
    </Box>
  );
};

export default HeaderBar;
