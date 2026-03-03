/**
 * FileChangeSummary — session-wide file-change stats panel.
 *
 * Displayed below the chat input bar. Shows:
 *   ±  +312 lines  -48 lines  across 7 files
 *
 * Also shows a per-file breakdown (up to maxFiles) when expanded.
 */
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useFileChanges } from "@/store/index.js";

interface FileChangeSummaryProps {
  /** Max files shown in expanded view (default 8) */
  maxFiles?: number;
}

const FileChangeSummary: React.FC<FileChangeSummaryProps> = ({
  maxFiles = 8,
}) => {
  const { sessionLinesAdded, sessionLinesDeleted, changedFiles } = useFileChanges();
  const [expanded, setExpanded] = useState(false);

  // Toggle expanded view with 'd' key (d = diff)
  useInput((input) => {
    if (input === "d") setExpanded((e) => !e);
  });

  const hasChanges = sessionLinesAdded > 0 || sessionLinesDeleted > 0;

  if (!hasChanges) {
    return (
      <Box paddingX={1} borderStyle="single" borderColor="gray">
        <Text dimColor>No file changes this session. </Text>
        <Text dimColor> Press </Text>
        <Text color="white">d</Text>
        <Text dimColor> to toggle diff panel.</Text>
      </Box>
    );
  }

  const filesSorted = [...changedFiles]
    .sort((a, b) => (b.linesAdded + b.linesDeleted) - (a.linesAdded + a.linesDeleted))
    .slice(0, maxFiles);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {/* Summary row */}
      <Box flexDirection="row" gap={2}>
        <Text dimColor>changes</Text>
        <Text color="greenBright" bold>+{sessionLinesAdded}</Text>
        <Text color="redBright" bold>-{sessionLinesDeleted}</Text>
        <Text dimColor>across {changedFiles.length} file{changedFiles.length !== 1 ? "s" : ""}</Text>
        <Text dimColor>  [press </Text>
        <Text color="white">d</Text>
        <Text dimColor> to {expanded ? "collapse" : "expand"}]</Text>
      </Box>

      {/* Per-file breakdown */}
      {expanded && (
        <Box flexDirection="column" marginTop={1}>
          {filesSorted.map((f) => {
            // Shorten long paths: show last 2 segments
            const segments = f.path.replace(/\\/g, "/").split("/");
            const shortPath =
              segments.length > 2
                ? `…/${segments.slice(-2).join("/")}`
                : f.path;

            return (
              <Box key={f.path} gap={1} flexDirection="row">
                <Text dimColor>{shortPath.padEnd(40)}</Text>
                <Text color="greenBright">+{f.linesAdded}</Text>
                <Text color="redBright">-{f.linesDeleted}</Text>
              </Box>
            );
          })}
          {changedFiles.length > maxFiles && (
            <Text dimColor>  … and {changedFiles.length - maxFiles} more file(s)</Text>
          )}
        </Box>
      )}
    </Box>
  );
};

export default FileChangeSummary;
