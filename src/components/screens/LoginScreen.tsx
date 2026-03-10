/**
 * LoginScreen — shown when the user is not authenticated.
 * Walks through the device code flow with Ink UI.
 */
import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import Spinner from "@/components/ui/Spinner.js";
import {
  requestDeviceCode,
  pollForToken,
  type DeviceCodeResult,
} from "@/auth/device-flow.js";
import { useStore } from "@/store/index.js";
import type { StoredCredentials } from "@/auth/storage.js";

type FlowState =
  | "requesting"
  | "waiting"
  | "authenticated"
  | "error";

export const LoginScreen: React.FC = () => {
  const { app } = { app: useApp() };
  const login = useStore((s) => s.login);

  const [state, setState] = useState<FlowState>("requesting");
  const [codeInfo, setCodeInfo] = useState<DeviceCodeResult | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        setState("requesting");
        const result = await requestDeviceCode();
        if (cancelled) return;
        setCodeInfo(result);
        setState("waiting");

        const auth = await pollForToken(result.deviceId, (attempt) => {
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
        setState("authenticated");
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message ?? "Authentication failed");
          setState("error");
        }
      }
    }

    start();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "requesting") {
    return (
      <Box flexDirection="column" padding={1}>
        <Spinner label="Requesting device code..." />
      </Box>
    );
  }

  if (state === "waiting" && codeInfo) {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Text bold color="#ff8c00">
          Sign in to Pakalon
        </Text>
        <Text>
          Open this URL in your browser:
        </Text>
        <Text color="#ff8c00" underline>
          {codeInfo.loginUrl}
        </Text>
        <Box marginTop={1}>
          <Text>Your device code: </Text>
          <Text bold color="yellow">
            {codeInfo.code}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Spinner label={`Waiting for confirmation... (${pollAttempt * 3}s)`} />
        </Box>
        <Text dimColor>
          Code expires in {Math.floor(codeInfo.expiresIn / 60)} minutes.
          Press Ctrl+C to cancel.
        </Text>
      </Box>
    );
  }

  if (state === "authenticated") {
    return (
      <Box padding={1}>
        <Text color="#ff8c00" bold>
          ✓ Authenticated successfully! Starting Pakalon...
        </Text>
      </Box>
    );
  }

  if (state === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>
          Authentication failed
        </Text>
        <Text>{error}</Text>
        <Text dimColor>Run `pakalon` again to retry.</Text>
      </Box>
    );
  }

  return null;
};

export default LoginScreen;
