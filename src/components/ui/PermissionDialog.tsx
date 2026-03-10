/**
 * PermissionDialog — HIL approval prompt rendered in the TUI.
 * Shown when the AI agent requests a destructive action in "edit" mode.
 *
 * Displays structured payload: what/why/risk/affected files.
 * User choices: Accept Once | Accept for Session | Decline.
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { permissionGate, type PermissionRequest, type RiskLevel } from "@/ai/permission-gate.js";

interface PermissionDialogProps {
  onDismiss?: (() => void) | undefined;
}

const RISK_COLORS: Record<RiskLevel, string> = {
  low: "green",
  medium: "yellow",
  high: "red",
  critical: "magenta",
};

const CHOICES = [
  { label: "Allow once  — approve this single action", value: "once" },
  { label: "Allow session — approve all future actions of this type", value: "session" },
  { label: "Deny  — block this action", value: "deny" },
];

const PermissionDialog = ({ onDismiss }: PermissionDialogProps) => {
  const [request, setRequest] = useState<PermissionRequest | null>(null);

  useEffect(() => {
    const listener = (req: PermissionRequest) => {
      setRequest(req);
    };
    permissionGate.onRequest(listener);
    // Pick up any already-pending request (e.g. queue while dialog was unmounted)
    const existing = permissionGate.getPendingRequest();
    if (existing) setRequest(existing);
    return () => {
      permissionGate.offRequest(listener);
    };
  }, []);

  if (!request) return null;

  const risk = request.risk ?? "medium";
  const riskColor = RISK_COLORS[risk] ?? "yellow";

  const handleSelect = (item: { value: string }) => {
    permissionGate.resolve(request.id, item.value as "once" | "session" | "deny");
    setRequest(null);
    onDismiss?.();
  };

  return (
    <Box
      borderStyle="round"
      borderColor={riskColor}
      flexDirection="column"
      paddingX={1}
      marginY={1}
    >
      {/* Header */}
      <Text bold color={riskColor}>
        Permission Required
      </Text>

      <Box marginTop={1} flexDirection="column" gap={0}>
        {/* Tool */}
        <Box gap={1}>
          <Text bold>Tool:</Text>
          <Text color="cyan">{request.tool}</Text>
          {request.agentId && <Text dimColor> (agent: {request.agentId})</Text>}
        </Box>

        {/* What */}
        <Box gap={1}>
          <Text bold>What:</Text>
          <Text>{request.what}</Text>
        </Box>

        {/* Why */}
        {request.why && (
          <Box gap={1}>
            <Text bold>Why:</Text>
            <Text dimColor>{request.why.slice(0, 120)}</Text>
          </Box>
        )}

        {/* Risk level */}
        <Box gap={1}>
          <Text bold>Risk:</Text>
          <Text color={riskColor} bold>{risk.toUpperCase()}</Text>
        </Box>

        {/* Affected files */}
        {request.affectedFiles.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Files:</Text>
            {request.affectedFiles.slice(0, 4).map((f, i) => (
              <Text key={i} dimColor>  {f}</Text>
            ))}
            {request.affectedFiles.length > 4 && (
              <Text dimColor>  …and {request.affectedFiles.length - 4} more</Text>
            )}
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <SelectInput items={CHOICES} onSelect={handleSelect} />
      </Box>
    </Box>
  );
};

export default PermissionDialog;
