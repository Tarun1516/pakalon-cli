/**
 * DiffViewer.tsx — Ink component for displaying file diffs in the TUI.
 * T3-14: Shows colored line-by-line unified diffs before applying changes.
 */

import React from "react";
import { Box, Text } from "ink";

export interface DiffLine {
  type: "added" | "removed" | "context" | "hunk-header" | "file-header";
  content: string;
  lineNumber?: number;
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  lines: DiffLine[];
  hunks: number;
  additions: number;
  deletions: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser: unified diff text → DiffFile[]
// ─────────────────────────────────────────────────────────────────────────────

export function parseDiff(rawDiff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let lineNo = 0;

  for (const raw of rawDiff.split("\n")) {
    const line = raw;

    if (line.startsWith("diff --git ") || line.startsWith("--- ") && current === null) {
      if (current) files.push(current);
      current = { oldPath: "", newPath: "", lines: [], hunks: 0, additions: 0, deletions: 0 };
    }

    if (!current) {
      current = { oldPath: "", newPath: "", lines: [], hunks: 0, additions: 0, deletions: 0 };
    }

    if (line.startsWith("--- ")) {
      current.oldPath = line.replace(/^--- (a\/)?/, "");
      current.lines.push({ type: "file-header", content: line });
    } else if (line.startsWith("+++ ")) {
      current.newPath = line.replace(/^\+\+\+ (b\/)?/, "");
      current.lines.push({ type: "file-header", content: line });
    } else if (line.startsWith("@@ ")) {
      const m = line.match(/@@ .* \+(\d+)/);
      lineNo = m ? parseInt(m[1]!, 10) - 1 : 0;
      current.hunks++;
      current.lines.push({ type: "hunk-header", content: line });
    } else if (line.startsWith("+")) {
      current.additions++;
      current.lines.push({ type: "added", content: line.slice(1), lineNumber: ++lineNo });
    } else if (line.startsWith("-")) {
      current.deletions++;
      current.lines.push({ type: "removed", content: line.slice(1) });
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "context", content: line.slice(1), lineNumber: ++lineNo });
    }
  }

  if (current) files.push(current);
  return files.filter((f) => f.lines.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// DiffLineView: single line
// ─────────────────────────────────────────────────────────────────────────────

const DiffLineView: React.FC<{ line: DiffLine; showLineNumbers: boolean }> = ({ line, showLineNumbers }) => {
  if (line.type === "file-header") {
    return (
      <Text bold color="#ff8c00">
        {line.content}
      </Text>
    );
  }

  if (line.type === "hunk-header") {
    return (
      <Text color="#ff8c00" dimColor>
        {line.content}
      </Text>
    );
  }

  const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
  const color = line.type === "added" ? "#ff8c00" : line.type === "removed" ? "red" : undefined;
  const lineNumStr = showLineNumbers && line.lineNumber !== undefined ? String(line.lineNumber).padStart(4) + " " : "     ";

  return (
    <Box>
      {showLineNumbers && <Text dimColor>{lineNumStr}</Text>}
      <Text color={color}>
        {prefix}
        {line.content}
      </Text>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// DiffFileView: one file's diff
// ─────────────────────────────────────────────────────────────────────────────

const DiffFileView: React.FC<{ file: DiffFile; maxLines?: number; showLineNumbers?: boolean }> = ({
  file,
  maxLines = 60,
  showLineNumbers = true,
}) => {
  const displayLines = file.lines.slice(0, maxLines);
  const truncated = file.lines.length > maxLines;

  const addColor: string = "green";
  const delColor: string = "red";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold>{file.newPath || file.oldPath}</Text>
        <Text>{"  "}</Text>
        <Text color={addColor}>+{file.additions}</Text>
        <Text> </Text>
        <Text color={delColor}>-{file.deletions}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {displayLines.map((line, idx) => (
          <DiffLineView key={idx} line={line} showLineNumbers={showLineNumbers} />
        ))}
        {truncated && (
          <Text dimColor>
            … {file.lines.length - maxLines} more line(s) (use /diff --full to see all)
          </Text>
        )}
      </Box>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// DiffViewer: top-level component — accepts raw diff string or DiffFile[]
// ─────────────────────────────────────────────────────────────────────────────

export interface DiffViewerProps {
  /** Raw unified diff string OR pre-parsed DiffFile array. */
  diff: string | DiffFile[];
  /** Maximum lines to show per file (default 60). */
  maxLinesPerFile?: number;
  /** Show line numbers (default true). */
  showLineNumbers?: boolean;
  /** Title shown above the diff. */
  title?: string;
}

const DiffViewer: React.FC<DiffViewerProps> = ({
  diff,
  maxLinesPerFile = 60,
  showLineNumbers = true,
  title,
}) => {
  const files: DiffFile[] = typeof diff === "string" ? parseDiff(diff) : diff;

  if (!files.length) {
    return <Text dimColor>(no changes)</Text>;
  }

  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <Box flexDirection="column">
      {title && (
        <Box marginBottom={1}>
          <Text bold underline>
            {title}
          </Text>
        </Box>
      )}
      <Box marginBottom={1}>
        <Text dimColor>
          {files.length} file(s) changed · {" "}
        </Text>
        <Text color="#ff8c00">+{totalAdditions}</Text>
        <Text> </Text>
        <Text color="red">-{totalDeletions}</Text>
      </Box>
      {files.map((file, idx) => (
        <DiffFileView
          key={idx}
          file={file}
          maxLines={maxLinesPerFile}
          showLineNumbers={showLineNumbers}
        />
      ))}
    </Box>
  );
};

export default DiffViewer;
