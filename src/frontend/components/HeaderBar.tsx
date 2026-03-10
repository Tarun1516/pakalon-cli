/**
 * HeaderBar — single authenticated header card.
 *
 * Contains one outer border only, with the logo plus: user name, model, and session id.
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { useAuth, useModel, useSession } from "@/store/index.js";
import PakalonLogo from "@/frontend/components/PakalonLogo.js";

interface HeaderBarProps {
  /** Show the logo above the info bar (default true) */
  showLogo?: boolean;
}

const HeaderBar: React.FC<HeaderBarProps> = ({ showLogo = true }) => {
  const { githubLogin, displayName } = useAuth();
  const { selectedModel } = useModel();
  const { sessionId } = useSession();

  const modelShort = selectedModel
    ? selectedModel.length > 36
      ? `…${selectedModel.slice(-33)}`
      : selectedModel
    : "none";
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

  const sessionShort = sessionId
    ? sessionId.length > 24
      ? `${sessionId.slice(0, 12)}…${sessionId.slice(-8)}`
      : sessionId
    : "creating…";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="white" paddingX={2} paddingY={1} marginBottom={0}>
      {showLogo && (
        <Box justifyContent="center" marginBottom={1}>
          <PakalonLogo variant="header" align="center" />
        </Box>
      )}

      <Box justifyContent="center" gap={4} flexWrap="wrap">
        <Box gap={1}>
          <Text dimColor>user</Text>
          <Text color="whiteBright" bold>{primaryName}</Text>
          {secondaryIdentity && <Text dimColor>({secondaryIdentity})</Text>}
        </Box>

        <Box gap={1}>
          <Text dimColor>model</Text>
          <Text color="cyanBright">{modelShort}</Text>
        </Box>

        <Box gap={1}>
          <Text dimColor>session</Text>
          <Text color="yellowBright">{sessionShort}</Text>
        </Box>
      </Box>
    </Box>
  );
};

export default HeaderBar;
