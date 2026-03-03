/**
 * SplashLoginScreen — shown when user has never logged in before.
 *
 * Flow:
 *   1. Play video animation (LogoAnimated) while silently fetching a device code
 *   2. Once animation completes (or times out), show the auth UI:
 *        • URL to visit on the website
 *        • 6-digit code displayed large and prominently
 *        • Polling spinner
 *   3. On approval → call onAuthenticated()
 *
 * For subsequent logins (not first-ever), this screen is also shown but
 * without the video animation (showAnimation=false).
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Box, Text } from "ink";
import Spinner from "@/components/ui/Spinner.js";
import {
  requestDeviceCode,
  pollForToken,
  type DeviceCodeResult,
} from "@/auth/device-flow.js";
import { useAuth } from "@/store/index.js";
import type { StoredCredentials } from "@/auth/storage.js";

import LogoAnimatedImport from "@/frontend/animations/LogoAnimated.js";

// Lazy-load the video animation to avoid crashing if asset is unavailable
const LogoAnimatedComponent: React.ComponentType<{
  loop?: boolean;
  hasDarkBackground?: boolean;
  onFinished?: () => void;
}> | null = LogoAnimatedImport ?? null;

// ─────────────────────────────────────────────────────────────────────────────
// Big Code Display helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Render the 6-char device code as large block characters */
function BigCode({ code }: { code: string }) {
  return (
    <Box flexDirection="column" alignItems="center" marginY={1}>
      <Text dimColor>Your device code:</Text>
      <Box
        borderStyle="double"
        borderColor="yellowBright"
        paddingX={3}
        paddingY={0}
        marginTop={1}
      >
        <Text color="yellowBright" bold>
          {code.split("").join("  ")}
        </Text>
      </Box>
      <Text dimColor>(enter this code on the website)</Text>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

type Stage =
  | "animation"   // showing video animation, fetching code in background
  | "waiting"     // showing URL + code, polling for approval
  | "approved"    // approved, logging in…
  | "error";

interface SplashLoginScreenProps {
  /**
   * When true, play the video animation before showing the auth UI.
   * Set to true on first-ever launch, false for subsequent logins.
   */
  showAnimation?: boolean;
  onAuthenticated?: () => void;
}

const SplashLoginScreen: React.FC<SplashLoginScreenProps> = ({
  showAnimation = false,
  onAuthenticated,
}) => {
  const { login } = useAuth();

  const [stage, setStage] = useState<Stage>(showAnimation ? "animation" : "waiting");
  const [codeInfo, setCodeInfo] = useState<DeviceCodeResult | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // ── Fetch device code immediately (runs in background during animation) ──
  useEffect(() => {
    let cancelled = false;
    cancelledRef.current = false;

    async function fetchCode() {
      try {
        const result = await requestDeviceCode();
        if (cancelled || cancelledRef.current) return;
        setCodeInfo(result);
      } catch (err: unknown) {
        if (cancelled || cancelledRef.current) return;
        setError((err as Error).message ?? "Failed to request device code");
        setStage("error");
      }
    }

    fetchCode();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Start polling once we have a code and we're in "waiting" stage ──
  useEffect(() => {
    if (stage !== "waiting" || !codeInfo) return;
    let cancelled = false;

    async function poll() {
      try {
        const auth = await pollForToken(codeInfo!.deviceId, (attempt) => {
          if (!cancelled) setPollAttempt(attempt);
        });
        if (cancelled) return;

        const creds: StoredCredentials = {
          token: auth.token,
          userId: auth.userId,
          plan: auth.plan,
          storedAt: new Date().toISOString(),
        };
        login(creds);
        setStage("approved");
        onAuthenticated?.();
      } catch (err: unknown) {
        if (cancelled) return;
        setError((err as Error).message ?? "Authentication failed");
        setStage("error");
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [stage, codeInfo, login, onAuthenticated]);

  // ── Animation finished callback ──
  const handleAnimationDone = useCallback(() => {
    setStage("waiting");
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Render: Animation phase
  // ─────────────────────────────────────────────────────────────────────────
  if (stage === "animation") {
    return (
      <Box flexDirection="column" alignItems="center">
        {LogoAnimatedComponent ? (
          <LogoAnimatedComponent
            hasDarkBackground
            loop={false}
            onFinished={handleAnimationDone}
          />
        ) : (
          // Fallback: static title while code is fetching
          <Box flexDirection="column" alignItems="center" padding={2}>
            <Text color="cyan" bold>
              {"██████╗  █████╗ ██╗  ██╗ █████╗ ██╗      ██████╗ ███╗   ██╗"}
            </Text>
            <Spinner label="Loading…" />
          </Box>
        )}
        <Box marginTop={1}>
          <Spinner label={codeInfo ? "Ready — finishing animation…" : "Preparing login…"} />
        </Box>
      </Box>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render: Waiting for user to enter code on the website
  // ─────────────────────────────────────────────────────────────────────────
  if (stage === "waiting") {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        {/* Header */}
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
          <Text color="cyan" bold>
            {"██████╗  █████╗ ██╗  ██╗ █████╗ ██╗      ██████╗ ███╗   ██╗"}
          </Text>
          <Text color="cyan" bold>
            {"██╔══██╗██╔══██╗██║ ██╔╝██╔══██╗██║     ██╔═══██╗████╗  ██║"}
          </Text>
          <Text color="cyan" bold>
            {"██████╔╝███████║█████╔╝ ███████║██║     ██║   ██║██╔██╗ ██║"}
          </Text>
          <Text color="cyan" bold>
            {"██╔═══╝ ██╔══██║██╔═██╗ ██╔══██║██║     ██║   ██║██║╚██╗██║"}
          </Text>
          <Text color="cyan" bold>
            {"██║     ██║  ██║██║  ██╗██║  ██║███████╗╚██████╔╝██║ ╚████║"}
          </Text>
          <Text color="cyan" bold>
            {"╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝"}
          </Text>
        </Box>

        <Text bold color="white">
          Sign in to Pakalon
        </Text>

        {/* Step 1 — Open the website */}
        <Box flexDirection="column" gap={0}>
          <Text>1. Open this URL in your browser:</Text>
          <Box marginLeft={3}>
            <Text color="blueBright" underline>
              {codeInfo?.loginUrl ?? "https://pakalon.com/login"}
            </Text>
          </Box>
        </Box>

        {/* Step 2 — Show the 6-digit code */}
        <Box flexDirection="column" gap={0}>
          <Text>2. Log in or create an account, then enter this code:</Text>
          {codeInfo ? (
            <BigCode code={codeInfo.code} />
          ) : (
            <Box marginLeft={3}>
              <Spinner label="Generating code…" />
            </Box>
          )}
        </Box>

        {/* Polling status */}
        <Box marginTop={1}>
          {codeInfo ? (
            <Spinner
              label={`Waiting for confirmation… (${pollAttempt * 3}s elapsed)`}
            />
          ) : (
            <Spinner label="Connecting to Pakalon servers…" />
          )}
        </Box>

        {/* Expiry hint */}
        {codeInfo && (
          <Text dimColor>
            Code expires in {Math.floor(codeInfo.expiresIn / 60)} minute
            {codeInfo.expiresIn >= 120 ? "s" : ""}. Press Ctrl+C to cancel.
          </Text>
        )}
      </Box>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render: Approved
  // ─────────────────────────────────────────────────────────────────────────
  if (stage === "approved") {
    return (
      <Box flexDirection="column" padding={1} alignItems="center" gap={1}>
        <Text color="greenBright" bold>
          ✓  Authenticated successfully!
        </Text>
        <Spinner label="Starting Pakalon…" />
      </Box>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render: Error
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Text color="red" bold>✗  Authentication failed</Text>
      <Text color="red">{error}</Text>
      <Text dimColor>Run `pakalon` again to retry.</Text>
    </Box>
  );
};

export default SplashLoginScreen;
