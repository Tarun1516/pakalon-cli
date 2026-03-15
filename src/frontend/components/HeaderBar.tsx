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
import LogoStatic from "@/frontend/animations/LogoStatic.js";
import { PAKALON_GOLD, TEXT_SECONDARY } from "@/constants/colors.js";
import { getShellWidth } from "@/utils/shell-layout.js";

interface HeaderBarProps {
  /** Show the logo above the info bar (default true) */
  showLogo?: boolean;
  sessionId?: string;
}

const IdentityField: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Text>
    <Text color="white" bold>{label} </Text>
    <Text color={PAKALON_GOLD}>{value}</Text>
  </Text>
);

const HeaderBar: React.FC<HeaderBarProps> = ({ showLogo = true, sessionId: sessionIdOverride }) => {
  const { githubLogin, displayName } = useAuth();
  const { selectedModel } = useModel();
  const sessionId = useStore((s) => s.sessionId);
  const terminalWidth = process.stdout.columns ?? 120;
  const baseWidth = getShellWidth(terminalWidth);
  // Static logo width is fixed at 63 characters
  const logoWidth = showLogo ? 63 : 0;
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
            <LogoStatic />
          </Box>
        )}

        <Box flexDirection="column" gap={compactLayout ? 0 : 1} marginBottom={1}>
          <Box justifyContent="center" gap={compactLayout ? 2 : 4} flexWrap="wrap">
            <IdentityField label="User" value={identityDisplay} />
            <IdentityField label="Model" value={modelDisplay} />
          </Box>
          <Box justifyContent="center" flexWrap="wrap">
            <IdentityField label="Session ID" value={currentSessionDisplay} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export default HeaderBar;
