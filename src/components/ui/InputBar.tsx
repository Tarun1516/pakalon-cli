/**
 * InputBar — user text input with slash-command detection and @agent autocomplete.
 *
 * Design: Golden separator line with prompt input
 * ───────────────────────────────────────────────────────────────
 * › <input message or /help>
 * ───────────────────────────────────────────────────────────────
 *
 * Keyboard shortcuts:
 *   Shift+Tab  → cycle visible interaction mode
 *   Ctrl+O     → toggle verbose panel (T164)
 *   Enter      → submit
 *
 * @ Autocomplete (T-CLI-10 / T-CLI-P9): When input contains "@", shows a filterable
 * list of configured agents with their name, description, and model.
 * Selecting one inserts @agentname into the message.
 */
import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useStore } from "@/store/index.js";
import type { PermissionMode } from "@/store/slices/mode.slice.js";
import { readdirSync, statSync } from "fs";
import { join, relative, extname } from "path";
// T-MCP-07: MCP resource mentions
import { getMcpResources, getMcpPromptCommands } from "@/mcp/manager.js";
import { PAKALON_GOLD, TEXT_SECONDARY } from "@/constants/colors.js";
import { getShellWidth, makeHorizontalRule } from "@/utils/shell-layout.js";

// T-CLI-P9: Rich agent suggestion items including description and color
interface AgentSuggestion {
  name: string;          // "@agent-name"
  description: string;
  color: string;
}

let _agentSuggestions: AgentSuggestion[] | null = null;

function getAgentSuggestions(): AgentSuggestion[] {
  if (_agentSuggestions) return _agentSuggestions;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAllAgents } = require("@/commands/agents.js") as {
      getAllAgents: () => Array<{ name: string; description?: string; color?: string }>;
    };
    _agentSuggestions = getAllAgents().map((a) => ({
      name: `@${a.name.toLowerCase().replace(/\s+/g, "-")}`,
      description: a.description ?? "",
      color: a.color ?? "orange",
    }));
  } catch {
    _agentSuggestions = [];
  }
  return _agentSuggestions;
}

/** Legacy helper kept for compatibility */
function getAgentNames(): string[] {
  return getAgentSuggestions().map((s) => s.name);
}

// T-CLI-09: Enumerate source files from cwd for @file autocomplete
const FILE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".md", ".json", ".yaml", ".yml", ".toml", ".sh", ".env"]);
const MAX_FILES = 200; // limit scan depth
let _fileSuggestions: string[] | null = null;
let _fileScanDir: string | null = null;

function scanFiles(dir: string, base: string, results: string[], depth = 0): void {
  if (depth > 4 || results.length >= MAX_FILES) return;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "__pycache__" || entry === "dist" || entry === "build") continue;
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          results.push(`${relative(base, full).replace(/\\/g, "/")}/`);
          scanFiles(full, base, results, depth + 1);
        } else if (FILE_EXTS.has(extname(entry).toLowerCase())) {
          results.push(relative(base, full).replace(/\\/g, "/"));
        }
      } catch { /* skip unreadable */ }
      if (results.length >= MAX_FILES) return;
    }
  } catch { /* skip unreadable dir */ }
}

// T-MCP-07: Cached MCP resource list — refreshed once per session
interface McpResourceItem {
  server: string;
  uri: string;
  name: string;
  description?: string;
}
let _mcpResourceCache: McpResourceItem[] | null = null;
let _mcpResourceFetchPending = false;

function getMcpResourceSuggestions(): McpResourceItem[] {
  return _mcpResourceCache ?? [];
}

async function ensureMcpResourceCache(): Promise<void> {
  if (_mcpResourceCache !== null || _mcpResourceFetchPending) return;
  _mcpResourceFetchPending = true;
  try {
    const results = await getMcpResources();
    _mcpResourceCache = [];
    for (const { server, resources } of results) {
      for (const r of resources as Array<{ uri: string; name?: string; description?: string }>) {
        _mcpResourceCache.push({
          server,
          uri: r.uri ?? "",
          name: r.name ?? r.uri ?? "",
          description: r.description,
        });
      }
    }
  } catch {
    _mcpResourceCache = [];
  } finally {
    _mcpResourceFetchPending = false;
  }
}

function getFileSuggestions(cwd: string): string[] {
  if (_fileSuggestions && _fileScanDir === cwd) return _fileSuggestions;
  const results: string[] = [];
  scanFiles(cwd, cwd, results);
  _fileSuggestions = results.sort();
  _fileScanDir = cwd;
  return _fileSuggestions;
}

interface InputBarProps {
  onSubmit: (value: string) => void;
  isDisabled?: boolean | undefined;
  /** Overrides the displayed mode label (e.g. "agent"). Falls back to permissionMode from store. */
  mode?: string | undefined;
  /** T-CLI-80: Vim mode — enables normal/insert/visual key handling */
  vimMode?: boolean | undefined;
  /** T-CLI-09: project directory for @file autocomplete */
  projectDir?: string | undefined;
  /** T-CLI-57: Prior user messages for ghost-text prompt suggestions */
  historyItems?: string[] | undefined;
}

interface CommandSuggestion {
  label: string;
  insertValue: string;
  description: string;
}

const COMMAND_SUGGESTIONS: CommandSuggestion[] = [
  { label: "/init", insertValue: "/init", description: "Initialize Pakalon workspace files" },
  { label: "/pakalon", insertValue: "/pakalon ", description: "Start the Pakalon pipeline" },
  { label: "/plugins", insertValue: "/plugins", description: "Manage installed plugins" },
  { label: "/models", insertValue: "/models", description: "List models available for your plan" },
  { label: "/workflows", insertValue: "/workflows", description: "Create and run workflows" },
  { label: "/directory", insertValue: "/directory", description: "Show the current project tree" },
  { label: "/agents", insertValue: "/agents", description: "Manage saved agents" },
  { label: "/web", insertValue: "/web ", description: "Analyze a web page or browse the web" },
  { label: "/history", insertValue: "/history", description: "Show recent conversation history" },
  { label: "/session", insertValue: "/session", description: "Show available chat sessions" },
  { label: "/new", insertValue: "/new", description: "Start a brand new chat session" },
  { label: "/resume", insertValue: "/resume ", description: "Resume a previous session" },
  { label: "/resume<session_id>", insertValue: "/resume ", description: "Resume a specific session id" },
  { label: "/agents", insertValue: "/agents", description: "Manage saved agents" },
  { label: "/update", insertValue: "/update ", description: "Apply an update task to the codebase" },
  { label: "/penpot", insertValue: "/penpot", description: "Open the Penpot design workflow" },
  { label: "/agent", insertValue: "/agent", description: "Switch to agent mode" },
  { label: "/automations", insertValue: "/automations", description: "Manage automations and connectors" },
];

// T-MCP-08: Append MCP prompt commands (e.g. "/mcp__context7__") dynamically at runtime.
// getMcpPromptCommands() returns partial prefixes like "/mcp__context7__" for autocomplete.
function getAllSlashCommands(): string[] {
  try {
    const mcpPrompts = getMcpPromptCommands();
    const commands = COMMAND_SUGGESTIONS
      .filter((item) => item.label.startsWith("/"))
      .map((item) => item.insertValue.trimEnd());
    if (mcpPrompts.length > 0) return [...commands, ...mcpPrompts];
  } catch { /* ignore */ }
  return COMMAND_SUGGESTIONS
    .filter((item) => item.label.startsWith("/"))
    .map((item) => item.insertValue.trimEnd());
}

const PERMISSION_MODE_COLORS: Record<PermissionMode, string> = {
  plan: "orange",
  "auto-accept": "orange",
  orchestration: "yellow",
  normal: "white",
};

// T-CLI-P9: Rich dropdown item — includes description for agent suggestions
interface RichSelectItem {
  label: string;
  value: string;
  // Extra metadata for rendering
  description?: string;
  agentColor?: string;
}

const PAKALON_ACCENT_COLOR = PAKALON_GOLD; // golden accent from design

const InputBar: React.FC<InputBarProps> = ({ onSubmit, isDisabled, mode, vimMode, projectDir, historyItems }) => {
  const [value, setValue] = useState("");
  const [atItems, setAtItems] = useState<RichSelectItem[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  // T-CLI-80: Vim mode state — "normal" waits for commands, "insert" allows typing
  const [vimEditMode, setVimEditMode] = useState<"normal" | "insert" | "visual">("insert");
  const [cursorPos, setCursorPos] = useState(0);
  // dd pending state (kept for compat; superseded by pendingMotionRef)
  const pendingDRef = useRef(false);
  // T-CLI-80: Extended vim state
  const undoStackRef = useRef<string[]>([]);   // undo history (max 50)
  const yankRef = useRef<string>("");           // yank/delete register
  const pendingMotionRef = useRef<string>(""); // accumulated multi-key sequence
  const visualAnchorRef = useRef<number>(0);   // visual mode selection anchor

  const slashItems = React.useMemo(() => {
    if (!value.startsWith("/")) return [] as CommandSuggestion[];
    const query = value.slice(1).trim().toLowerCase();
    const commandItems = COMMAND_SUGGESTIONS.filter((item) => item.label.startsWith("/"));
    if (!query) return commandItems;

    const startsWith = commandItems.filter((item) => item.label.slice(1).toLowerCase().startsWith(query));
    const includes = commandItems.filter(
      (item) => !startsWith.includes(item) && item.label.slice(1).toLowerCase().includes(query)
    );
    return [...startsWith, ...includes];
  }, [value]);

  const visibleSuggestions = React.useMemo<RichSelectItem[]>(() => {
    if (atItems.length > 0) return atItems;
    return slashItems.slice(0, 10).map((item) => ({
      label: item.label,
      value: item.insertValue,
      description: item.description,
      agentColor: "cyan",
    }));
  }, [atItems, slashItems]);

  // T-CLI-57: Ghost text — prefer slash command completion, otherwise use prompt history.
  const ghostSuggestion = React.useMemo(() => {
    if (value.startsWith("/")) {
      const bestMatch = slashItems[0];
      if (!bestMatch) return "";
      const target = bestMatch.insertValue;
      return target.toLowerCase().startsWith(value.toLowerCase()) ? target.slice(value.length) : "";
    }

    if (!historyItems || value.length < 2) return "";
    const lv = value.toLowerCase();
    const match = historyItems.find((h) => h.toLowerCase().startsWith(lv) && h.length > value.length);
    return match ? match.slice(value.length) : "";
  }, [value, historyItems, slashItems]);
  const permissionMode = useStore((s) => s.permissionMode);
  const cyclePermissionMode = useStore((s) => s.cyclePermissionMode);
  const toggleVerbose = useStore((s) => s.toggleVerbose);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [value, atItems, slashItems]);

  const applySuggestion = (item: RichSelectItem) => {
    if (atItems.length > 0) {
      handleAtSelect(item);
      return;
    }

    setValue(item.value);
  };

  const submitCurrentValue = React.useCallback((nextValue?: string) => {
    const finalValue = (nextValue ?? value).trim();
    if (!finalValue || isDisabled) return;
    setAtItems([]);
    onSubmit(finalValue);
    setValue("");
    setCursorPos(0);
    if (vimMode) setVimEditMode("normal");
  }, [isDisabled, onSubmit, value, vimMode]);

  // Sync cursorPos with value length when value changes externally
  useEffect(() => {
    if (cursorPos > value.length) setCursorPos(value.length);
  }, [value, cursorPos]);

  // When vim mode is toggled on, start in normal mode; when toggled off, stay in insert
  useEffect(() => {
    if (vimMode) {
      setVimEditMode("normal");
    } else {
      setVimEditMode("insert");
    }
  }, [vimMode]);

  // Update @mention suggestions whenever the value changes
  // T-CLI-10 / T-CLI-P9: detect @mention at ANY position; show name + description
  // T-CLI-09: also show file completions when fragment looks like a path
  // T-MCP-07: also show MCP @server:resource completions
  useEffect(() => {
    const lastAtIdx = value.lastIndexOf("@");
    if (lastAtIdx === -1) {
      if (atItems.length) setAtItems([]);
      return;
    }
    // Fragment from the last @ onward (e.g. "@but" or just "@")
    const fragment = value.slice(lastAtIdx).toLowerCase();
    // If there's a space after @, the mention is already complete — hide dropdown
    if (fragment.length > 1 && fragment.includes(" ")) {
      if (atItems.length) setAtItems([]);
      return;
    }
    const query = fragment.slice(1); // strip leading @

    // T-MCP-07: "server:resource" pattern — show MCP resource completions
    // Detect if query looks like "@server:..." or "@server:/..."
    const colonIdx = query.indexOf(":");
    if (colonIdx !== -1) {
      const serverPrefix = query.slice(0, colonIdx);
      const resourcePrefix = query.slice(colonIdx + 1).toLowerCase();
      const resources = getMcpResourceSuggestions();
      const resourceItems = resources
        .filter((r) =>
          (serverPrefix === "" || r.server.toLowerCase().startsWith(serverPrefix)) &&
          (resourcePrefix === "" || r.uri.toLowerCase().includes(resourcePrefix) || r.name.toLowerCase().includes(resourcePrefix))
        )
        .slice(0, 8)
        .map((r) => ({
          label: `@${r.server}:${r.uri}${r.description ? `  ${r.description.slice(0, 35)}` : ""}`,
          value: `@${r.server}:${r.uri}`,
          description: r.description,
          agentColor: "magenta" as string,
        }));
      setAtItems(resourceItems);
      // Eagerly warm the cache for next time
      void ensureMcpResourceCache();
      return;
    }

    // If user just typed "@" (no colon yet), pre-fetch MCP resources in background
    void ensureMcpResourceCache();

    // Show agents AND files together; files shown when there's a dot or slash in query
    const agents = getAgentSuggestions();
    const agentItems = agents
      .filter((s) => s.name.startsWith(fragment) || fragment === "@")
      .slice(0, 5)
      .map((s) => ({
        label: s.description ? `${s.name}  ${s.description.slice(0, 40)}` : s.name,
        value: s.name,
        description: s.description,
        agentColor: s.color,
      }));

    // T-CLI-09: File suggestions — only when query is non-empty or looks like a path fragment
    const cwd = projectDir ?? process.cwd();
    const files = getFileSuggestions(cwd);
    const fileItems = query.length > 0
      ? files
          .filter((f) => f.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 6)
          .map((f) => ({
            label: f.endsWith("/") ? `${f}  folder` : `${f}  file`,
            value: `@${f}`,
            description: undefined,
            agentColor: "white",
          }))
      : [];

    // T-MCP-07: Also show MCP server prefixes as hints when @ is typed without a colon
    const mcpServers = getMcpResourceSuggestions()
      .reduce((acc, r) => {
        if (!acc.includes(r.server)) acc.push(r.server);
        return acc;
      }, [] as string[])
      .filter((s) => query === "" || s.toLowerCase().startsWith(query))
      .slice(0, 3)
      .map((s) => ({
        label: `@${s}:  MCP resource`,
        value: `@${s}:`,
        description: "MCP resource reference",
        agentColor: "magenta" as string,
      }));

    const combined = [...agentItems, ...fileItems, ...mcpServers].slice(0, 10);
    setAtItems(combined);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shift+Tab → cycle permission mode; T164: Ctrl+O → verbose
  useInput(
    (_input, key) => {
      if (isDisabled) return;

      if (visibleSuggestions.length > 0) {
        if (key.downArrow) {
          setSelectedSuggestionIndex((current) => (current + 1) % visibleSuggestions.length);
          return;
        }
        if (key.upArrow) {
          setSelectedSuggestionIndex((current) => (current - 1 + visibleSuggestions.length) % visibleSuggestions.length);
          return;
        }
        if (_input === " ") {
          applySuggestion(visibleSuggestions[selectedSuggestionIndex]!);
          return;
        }
        if (key.return) {
          const selectedSuggestion = visibleSuggestions[selectedSuggestionIndex]!;
          if (atItems.length > 0) {
            applySuggestion(selectedSuggestion);
            return;
          }

          submitCurrentValue(selectedSuggestion.value);
          return;
        }
      }

      // T-CLI-80: Vim normal mode — full key handling: motions, text objects, undo, yank, paste
      if (vimMode && vimEditMode === "normal") {
        // --- helpers (close over current value / cursorPos) ---
        const pushUndo = () => {
          undoStackRef.current.push(value);
          if (undoStackRef.current.length > 50) undoStackRef.current.shift();
        };
        const wEnd = (p = cursorPos): number => {
          let i = p; while (i < value.length && value[i] !== " ") i++; while (i < value.length && value[i] === " ") i++; return i;
        };
        const wBack = (p = cursorPos): number => {
          let i = p - 1; while (i > 0 && value[i] === " ") i--; while (i > 0 && value[i - 1] !== " ") i--; return Math.max(0, i);
        };
        const eEnd = (p = cursorPos): number => {
          let i = p + 1; while (i < value.length && value[i] === " ") i++;
          while (i < value.length - 1 && value[i + 1] !== " ") i++;
          return Math.min(i, Math.max(0, value.length - 1));
        };
        const innerWord = (): [number, number] => {
          let s = cursorPos, e = cursorPos;
          while (s > 0 && value[s - 1] !== " ") s--;
          while (e < value.length && value[e] !== " ") e++;
          return [s, e];
        };
        const aroundWord = (): [number, number] => {
          let [s, e] = innerWord();
          while (s > 0 && value[s - 1] === " ") s--;
          while (e < value.length && value[e] === " ") e++;
          return [s, e];
        };
        const innerObj = (delim: string, around: boolean): [number, number] | null => {
          const pairs: Record<string, [string, string]> = {
            "(": ["(", ")"], ")": ["(", ")"],
            "[": ["[", "]"], "]": ["[", "]"],
            "{": ["{", "}"], "}": ["{", "}"],
            "<": ["<", ">"], ">": ["<", ">"],
          };
          if (['"', "'", "`"].includes(delim)) {
            const left = value.lastIndexOf(delim, cursorPos - 1);
            const right = value.indexOf(delim, cursorPos);
            if (left === -1 || right === -1 || left === right) return null;
            return around ? [left, right] : [left + 1, right - 1];
          }
          const pair = pairs[delim];
          if (!pair) return null;
          let depth = 0, start = -1;
          for (let i = cursorPos; i >= 0; i--) {
            if (value[i] === pair[1]) depth++;
            else if (value[i] === pair[0]) { if (depth === 0) { start = i; break; } depth--; }
          }
          if (start === -1) return null;
          depth = 0; let end = -1;
          for (let i = start + 1; i < value.length; i++) {
            if (value[i] === pair[0]) depth++;
            else if (value[i] === pair[1]) { if (depth === 0) { end = i; break; } depth--; }
          }
          if (end === -1) return null;
          return around ? [start, end] : [start + 1, end - 1];
        };

        // --- resolve pending multi-key sequence ---
        const pending = pendingMotionRef.current;
        if (pending) {
          pendingMotionRef.current = "";
          // r<char> — replace
          if (pending === "r") {
            if (_input && _input.length === 1) { pushUndo(); setValue(value.slice(0, cursorPos) + _input + value.slice(cursorPos + 1)); }
            return;
          }
          // f/F/t/T<char> — find / till
          if (pending === "f") { const idx = value.indexOf(_input, cursorPos + 1); if (idx !== -1) setCursorPos(idx); return; }
          if (pending === "F") { const idx = value.lastIndexOf(_input, cursorPos - 1); if (idx !== -1) setCursorPos(idx); return; }
          if (pending === "t") { const idx = value.indexOf(_input, cursorPos + 1); if (idx !== -1) setCursorPos(Math.max(0, idx - 1)); return; }
          if (pending === "T") { const idx = value.lastIndexOf(_input, cursorPos - 1); if (idx !== -1) setCursorPos(idx + 1); return; }
          // g<key>
          if (pending === "g") {
            if (_input === "g") { setCursorPos(0); return; }
            if (_input === "e") { let i = cursorPos - 1; while (i > 0 && value[i] === " ") i--; while (i > 0 && value[i - 1] !== " ") i--; setCursorPos(Math.max(0, i)); }
            return;
          }
          // d<motion>
          if (pending === "d") {
            if (_input === "d") { pushUndo(); yankRef.current = value; setValue(""); setCursorPos(0); return; }
            if (_input === "w") { const e = wEnd(); pushUndo(); yankRef.current = value.slice(cursorPos, e); const nv = value.slice(0, cursorPos) + value.slice(e); setValue(nv); setCursorPos(Math.min(cursorPos, Math.max(0, nv.length - 1))); return; }
            if (_input === "b") { const s = wBack(); pushUndo(); yankRef.current = value.slice(s, cursorPos); const nv = value.slice(0, s) + value.slice(cursorPos); setValue(nv); setCursorPos(Math.max(0, s)); return; }
            if (_input === "e") { const e = eEnd() + 1; pushUndo(); yankRef.current = value.slice(cursorPos, e); const nv = value.slice(0, cursorPos) + value.slice(e); setValue(nv); setCursorPos(Math.min(cursorPos, Math.max(0, nv.length - 1))); return; }
            if (_input === "$") { pushUndo(); yankRef.current = value.slice(cursorPos); setValue(value.slice(0, cursorPos)); setCursorPos(Math.max(0, cursorPos - 1)); return; }
            if (_input === "0") { pushUndo(); yankRef.current = value.slice(0, cursorPos); setValue(value.slice(cursorPos)); setCursorPos(0); return; }
            if (_input === "i") { pendingMotionRef.current = "di"; return; }
            if (_input === "a") { pendingMotionRef.current = "da"; return; }
            return;
          }
          // c<motion>
          if (pending === "c") {
            if (_input === "c") { pushUndo(); yankRef.current = value; setValue(""); setCursorPos(0); setVimEditMode("insert"); return; }
            if (_input === "w") { const e = wEnd(); pushUndo(); yankRef.current = value.slice(cursorPos, e); const nv = value.slice(0, cursorPos) + value.slice(e); setValue(nv); setCursorPos(cursorPos); setVimEditMode("insert"); return; }
            if (_input === "b") { const s = wBack(); pushUndo(); yankRef.current = value.slice(s, cursorPos); const nv = value.slice(0, s) + value.slice(cursorPos); setValue(nv); setCursorPos(s); setVimEditMode("insert"); return; }
            if (_input === "e") { const e = eEnd() + 1; pushUndo(); yankRef.current = value.slice(cursorPos, e); const nv = value.slice(0, cursorPos) + value.slice(e); setValue(nv); setCursorPos(cursorPos); setVimEditMode("insert"); return; }
            if (_input === "$") { pushUndo(); yankRef.current = value.slice(cursorPos); setValue(value.slice(0, cursorPos)); setVimEditMode("insert"); return; }
            if (_input === "0") { pushUndo(); yankRef.current = value.slice(0, cursorPos); setValue(value.slice(cursorPos)); setCursorPos(0); setVimEditMode("insert"); return; }
            if (_input === "i") { pendingMotionRef.current = "ci"; return; }
            if (_input === "a") { pendingMotionRef.current = "ca"; return; }
            return;
          }
          // y<motion>
          if (pending === "y") {
            if (_input === "y") { yankRef.current = value; return; }
            if (_input === "w") { yankRef.current = value.slice(cursorPos, wEnd()); return; }
            if (_input === "b") { yankRef.current = value.slice(wBack(), cursorPos); return; }
            if (_input === "e") { yankRef.current = value.slice(cursorPos, eEnd() + 1); return; }
            if (_input === "$") { yankRef.current = value.slice(cursorPos); return; }
            if (_input === "i") { pendingMotionRef.current = "yi"; return; }
            if (_input === "a") { pendingMotionRef.current = "ya"; return; }
            return;
          }
          // di/ci/yi/da/ca/ya + delimiter
          if (pending.length === 2 && ["di","ci","yi","da","ca","ya"].includes(pending)) {
            const op = pending[0] as "d"|"c"|"y";
            const around = pending[1] === "a";
            let range: [number, number] | null = null;
            if (_input === "w") {
              const [s, e] = around ? aroundWord() : innerWord();
              range = [s, e];
            } else {
              range = innerObj(_input, around);
            }
            if (range) {
              const [rs, re] = range;
              if (op !== "y") { pushUndo(); }
              yankRef.current = value.slice(rs, re + 1);
              if (op !== "y") {
                const nv = value.slice(0, rs) + value.slice(re + 1);
                setValue(nv);
                setCursorPos(Math.min(rs, Math.max(0, nv.length - 1)));
                if (op === "c") setVimEditMode("insert");
              }
            }
            return;
          }
          return;
        }

        // --- single-key commands ---
        if (key.escape) return;
        if (_input === "i") { setVimEditMode("insert"); return; }
        if (_input === "a") { setVimEditMode("insert"); setCursorPos(Math.min(cursorPos + 1, value.length)); return; }
        if (_input === "A") { setVimEditMode("insert"); setCursorPos(value.length); return; }
        if (_input === "I") { setVimEditMode("insert"); setCursorPos(0); return; }
        // motions
        if (_input === "h" || key.leftArrow) { setCursorPos((p) => Math.max(0, p - 1)); return; }
        if (_input === "l" || key.rightArrow) { setCursorPos((p) => Math.min(value.length > 0 ? value.length - 1 : 0, p + 1)); return; }
        if (_input === "0" || key.home) { setCursorPos(0); return; }
        if (_input === "$" || key.end) { setCursorPos(Math.max(0, value.length - 1)); return; }
        if (_input === "w") { let p = cursorPos; while (p < value.length && value[p] !== " ") p++; while (p < value.length && value[p] === " ") p++; setCursorPos(Math.min(p, Math.max(0, value.length - 1))); return; }
        if (_input === "b") { let p = cursorPos - 1; while (p > 0 && value[p] === " ") p--; while (p > 0 && value[p - 1] !== " ") p--; setCursorPos(Math.max(0, p)); return; }
        if (_input === "e") { setCursorPos(eEnd()); return; }
        // delete / change / yank
        if (_input === "x") { pushUndo(); yankRef.current = value[cursorPos] ?? ""; const nv = value.slice(0, cursorPos) + value.slice(cursorPos + 1); setValue(nv); setCursorPos(Math.min(cursorPos, Math.max(0, nv.length - 1))); return; }
        if (_input === "X") { if (cursorPos === 0) return; pushUndo(); yankRef.current = value[cursorPos - 1] ?? ""; const nv = value.slice(0, cursorPos - 1) + value.slice(cursorPos); setValue(nv); setCursorPos(Math.max(0, cursorPos - 1)); return; }
        if (_input === "D") { pushUndo(); yankRef.current = value.slice(cursorPos); setValue(value.slice(0, cursorPos)); setCursorPos(Math.max(0, cursorPos - 1)); return; }
        if (_input === "C") { pushUndo(); yankRef.current = value.slice(cursorPos); setValue(value.slice(0, cursorPos)); setVimEditMode("insert"); return; }
        if (_input === "s") { pushUndo(); yankRef.current = value[cursorPos] ?? ""; const nv = value.slice(0, cursorPos) + value.slice(cursorPos + 1); setValue(nv); setVimEditMode("insert"); return; }
        if (_input === "S") { pushUndo(); yankRef.current = value; setValue(""); setCursorPos(0); setVimEditMode("insert"); return; }
        // undo
        if (_input === "u") { if (undoStackRef.current.length > 0) { const prev = undoStackRef.current.pop()!; setValue(prev); setCursorPos(Math.min(cursorPos, Math.max(0, prev.length - 1))); } return; }
        // paste
        if (_input === "p") { if (yankRef.current) { pushUndo(); const nv = value.slice(0, cursorPos + 1) + yankRef.current + value.slice(cursorPos + 1); setValue(nv); setCursorPos(cursorPos + yankRef.current.length); } return; }
        if (_input === "P") { if (yankRef.current) { pushUndo(); const nv = value.slice(0, cursorPos) + yankRef.current + value.slice(cursorPos); setValue(nv); setCursorPos(cursorPos + yankRef.current.length - 1); } return; }
        // tilde — toggle case
        if (_input === "~") { if (cursorPos < value.length) { pushUndo(); const ch = value[cursorPos]!; const toggled = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(); setValue(value.slice(0, cursorPos) + toggled + value.slice(cursorPos + 1)); setCursorPos(Math.min(cursorPos + 1, value.length - 1)); } return; }
        // multi-key prefix
        if (_input === "r") { pendingMotionRef.current = "r"; return; }
        if (_input === "f") { pendingMotionRef.current = "f"; return; }
        if (_input === "F") { pendingMotionRef.current = "F"; return; }
        if (_input === "t") { pendingMotionRef.current = "t"; return; }
        if (_input === "T") { pendingMotionRef.current = "T"; return; }
        if (_input === "g") { pendingMotionRef.current = "g"; return; }
        if (_input === "d") { pendingMotionRef.current = "d"; return; }
        if (_input === "c") { pendingMotionRef.current = "c"; return; }
        if (_input === "y") { pendingMotionRef.current = "y"; return; }
        // visual mode
        if (_input === "v") { visualAnchorRef.current = cursorPos; setVimEditMode("visual"); return; }
        // submit
        if (key.return) { if (value.trim()) handleVimSubmit(); return; }
        return; // ignore unhandled
      }

      // T-CLI-80: Visual mode — hjkl moves cursor, d/y/c operate on selection
      if (vimMode && vimEditMode === "visual") {
        const anchor = visualAnchorRef.current;
        const selStart = Math.min(anchor, cursorPos);
        const selEnd = Math.max(anchor, cursorPos);
        if (key.escape) { setVimEditMode("normal"); return; }
        if (_input === "h" || key.leftArrow) { setCursorPos((p) => Math.max(0, p - 1)); return; }
        if (_input === "l" || key.rightArrow) { setCursorPos((p) => Math.min(value.length > 0 ? value.length - 1 : 0, p + 1)); return; }
        if (_input === "w") { let p = cursorPos; while (p < value.length && value[p] !== " ") p++; while (p < value.length && value[p] === " ") p++; setCursorPos(Math.min(p, Math.max(0, value.length - 1))); return; }
        if (_input === "b") { let p = cursorPos - 1; while (p > 0 && value[p] === " ") p--; while (p > 0 && value[p - 1] !== " ") p--; setCursorPos(Math.max(0, p)); return; }
        if (_input === "0") { setCursorPos(0); return; }
        if (_input === "$") { setCursorPos(Math.max(0, value.length - 1)); return; }
        if (_input === "d" || key.delete) {
          undoStackRef.current.push(value); yankRef.current = value.slice(selStart, selEnd + 1);
          const nv = value.slice(0, selStart) + value.slice(selEnd + 1);
          setValue(nv); setCursorPos(Math.min(selStart, Math.max(0, nv.length - 1)));
          setVimEditMode("normal"); return;
        }
        if (_input === "y") {
          yankRef.current = value.slice(selStart, selEnd + 1);
          setCursorPos(selStart); setVimEditMode("normal"); return;
        }
        if (_input === "c") {
          undoStackRef.current.push(value); yankRef.current = value.slice(selStart, selEnd + 1);
          const nv = value.slice(0, selStart) + value.slice(selEnd + 1);
          setValue(nv); setCursorPos(selStart); setVimEditMode("insert"); return;
        }
        if (_input === "~") {
          undoStackRef.current.push(value);
          const sel = value.slice(selStart, selEnd + 1).split("").map((c) => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join("");
          setValue(value.slice(0, selStart) + sel + value.slice(selEnd + 1));
          setCursorPos(selStart); setVimEditMode("normal"); return;
        }
        return;
      }

      // T-CLI-80: Vim insert mode — Esc returns to normal
      if (vimMode && vimEditMode === "insert") {
        if (key.escape) {
          setVimEditMode("normal");
          setCursorPos(Math.max(0, value.length - 1));
          return;
        }
        // All other keys handled by TextInput below
      }

      if (key.tab && key.shift) {
        cyclePermissionMode();
        return;
      }
      if (key.ctrl && _input === "o") {
        toggleVerbose();
      }
      // T-CLI-57: Right arrow / End accepts ghost text suggestion
      if ((key.rightArrow || key.end) && ghostSuggestion && atItems.length === 0) {
        setValue(value + ghostSuggestion);
        return;
      }
    },
    { isActive: !isDisabled }
  );

  const handleVimSubmit = () => {
    submitCurrentValue();
  };

  const handleSubmit = (val: string) => {
    submitCurrentValue(val);
  };

  const handleAtSelect = (item: { label: string; value: string }) => {
    // Replace only the @fragment (from the last @ to end) with selected agent name + space
    const lastAtIdx = value.lastIndexOf("@");
    if (lastAtIdx !== -1) {
      const before = value.slice(0, lastAtIdx);
      setValue(`${before}${item.value} `);
    } else {
      setValue(`${item.value} `);
    }
    setAtItems([]);
  };

  const prefixColor =
    mode
      ? isDisabled ? "gray" : "cyan"
      : PERMISSION_MODE_COLORS[permissionMode] ?? PAKALON_GOLD;

  const shellWidth = getShellWidth(process.stdout.columns ?? 80);
  const horizontalRule = makeHorizontalRule(shellWidth);

  // T-CLI-80: In vim normal mode, render cursor as highlighted character
  const renderVimNormalInput = () => {
    const before = value.slice(0, cursorPos);
    const cursorChar = value[cursorPos] ?? " ";
    const after = value.slice(cursorPos + 1);
    return (
      <Box gap={0}>
        <Text>{before}</Text>
        <Text backgroundColor="white" color="black">{cursorChar}</Text>
        <Text>{after}</Text>
        {!value && <Text dimColor backgroundColor="white" color="black"> </Text>}
      </Box>
    );
  };

  // T-CLI-80: In vim visual mode, render selection as highlighted range
  const renderVimVisualInput = () => {
    const anchor = visualAnchorRef.current;
    const selStart = Math.min(anchor, cursorPos);
    const selEnd = Math.max(anchor, cursorPos);
    const before = value.slice(0, selStart);
    const selected = value.slice(selStart, selEnd + 1) || " ";
    const after = value.slice(selEnd + 1);
    return (
      <Box gap={0}>
        <Text>{before}</Text>
        <Text backgroundColor="magenta" color="white">{selected}</Text>
        <Text>{after}</Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      {/* T-CLI-P9: @mention autocomplete dropdown — shows name + description */}
      {atItems.length > 0 && (
        <Box width="100%" justifyContent="center">
          <Box flexDirection="column" borderStyle="single" borderColor={PAKALON_ACCENT_COLOR} paddingX={1} width={shellWidth}>
            <Text dimColor>Suggestions — ↑/↓ move, Space selects, Enter confirms</Text>
            {atItems.map((item, index) => (
              <Box key={item.value} gap={1}>
                <Text color={index === selectedSuggestionIndex ? PAKALON_ACCENT_COLOR : (item.agentColor ?? "cyan")} bold={index === selectedSuggestionIndex}>
                  {index === selectedSuggestionIndex ? "➜" : " "} {item.value}
                </Text>
                {item.description ? (
                  <Text color={index === selectedSuggestionIndex ? PAKALON_ACCENT_COLOR : undefined} dimColor={index !== selectedSuggestionIndex}>{item.description.slice(0, 50)}</Text>
                ) : null}
              </Box>
            ))}
          </Box>
        </Box>
      )}
      {slashItems.length > 0 && (
        <Box width="100%" justifyContent="center">
          <Box flexDirection="column" borderStyle="single" borderColor={PAKALON_ACCENT_COLOR} paddingX={1} width={shellWidth}>
            <Text dimColor>Commands — ↑/↓ move, Space selects, Enter confirms</Text>
            {slashItems.slice(0, 10).map((item, index) => (
              <Box key={item.label} gap={1}>
                <Text color={index === selectedSuggestionIndex ? PAKALON_ACCENT_COLOR : "white"} bold={index === selectedSuggestionIndex}>
                  {index === selectedSuggestionIndex ? "➜" : " "} {item.label}
                </Text>
                <Text color={index === selectedSuggestionIndex ? PAKALON_ACCENT_COLOR : undefined} dimColor={index !== selectedSuggestionIndex}>{item.description}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
      <Box width="100%" justifyContent="center">
        <Box flexDirection="column" width={shellWidth}>
          <Text color={PAKALON_GOLD}>{horizontalRule}</Text>
          <Box paddingX={1}>
            {isDisabled ? (
              <Text color={prefixColor}>Generating response...</Text>
            ) : vimMode && vimEditMode === "normal" ? (
              // T-CLI-80: Normal mode — custom cursor rendering, TextInput inactive
              renderVimNormalInput()
            ) : vimMode && vimEditMode === "visual" ? (
              // T-CLI-80: Visual mode — selection highlighting
              renderVimVisualInput()
            ) : (
              <TextInput
                value={value}
                onChange={setValue}
                onSubmit={handleSubmit}
                placeholder="Enter your message here"
              />
            )}
          </Box>
          {/* T-CLI-57: Ghost text suggestion — shown as dimmed suffix (End accepts) */}
          {ghostSuggestion && !isDisabled && atItems.length === 0 && (
            <Box paddingX={1}>
              <Text color={TEXT_SECONDARY}>
                {value}
                <Text color={PAKALON_GOLD}>{ghostSuggestion}</Text>
                <Text color={TEXT_SECONDARY}>  End accepts</Text>
              </Text>
            </Box>
          )}
          <Text color={PAKALON_GOLD}>{horizontalRule}</Text>
        </Box>
      </Box>
    </Box>
  );
};

export default InputBar;
