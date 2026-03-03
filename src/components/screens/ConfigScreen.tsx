/**
 * ConfigScreen — /config tabbed settings TUI.
 *
 * Tabs: General | Models | Privacy | Memory | Hooks | Git
 *
 * Navigation:
 *   Left/Right (or h/l)  — switch tabs
 *   Up/Down   (or k/j)   — move row cursor within tab
 *   Enter / Space        — toggle boolean / enter edit mode
 *   Characters           — type value when in edit mode
 *   Escape               — cancel edit / exit screen
 *   Ctrl+S               — save current tab's pending changes
 *   s                    — save all changes immediately
 *   q / Ctrl+C           — exit screen
 */

import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import {
  getSettings,
  setSetting,
  type PakalonSettings,
  type SettingsScope,
} from "@/commands/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FieldType = "boolean" | "string" | "number" | "stringArray";

interface FieldDef {
  key: string;           // dotted path like "git.attribution"
  label: string;
  type: FieldType;
  description: string;
  defaultValue?: unknown;
}

interface TabDef {
  id: string;
  label: string;
  fields: FieldDef[];
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

const TABS: TabDef[] = [
  {
    id: "general",
    label: "General",
    fields: [
      { key: "defaultModel", label: "Default Model", type: "string", description: "Model ID used for all sessions (e.g. anthropic/claude-3-5-sonnet)" },
      { key: "fallbackModel", label: "Fallback Model", type: "string", description: "Model used when the default fails or rate-limits" },
      { key: "permissionMode", label: "Permission Mode", type: "string", description: "plan | edit | auto-accept | bypass" },
      { key: "maxBudgetUsd", label: "Max Budget (USD)", type: "number", description: "Session stops when this spend limit is reached" },
      { key: "autoCompact", label: "Auto Compact", type: "boolean", description: "Automatically compress context when it nears the window limit", defaultValue: true },
      { key: "verbose", label: "Verbose Output", type: "boolean", description: "Show extra debug info in the TUI" },
      { key: "disableSlashCommands", label: "Disable Slash Commands", type: "boolean", description: "Treat / input as plain text (useful for some workflows)" },
    ],
  },
  {
    id: "models",
    label: "Models",
    fields: [
      { key: "thinkingEnabled", label: "Extended Thinking", type: "boolean", description: "Enable Shift+Tab extended reasoning mode by default" },
      { key: "promptCaching", label: "Prompt Caching", type: "boolean", description: "Inject Anthropic cache_control breakpoints (saves ~90% on repeated context)", defaultValue: true },
      { key: "contextWindowFraction", label: "Context Window %", type: "number", description: "Fraction of context window to fill before compressing (0.1–1.0)", defaultValue: 0.8 },
    ],
  },
  {
    id: "privacy",
    label: "Privacy",
    fields: [
      { key: "privacyMode", label: "Privacy Mode", type: "boolean", description: "Add X-OpenRouter-No-Prompt-Training: true to all requests — opt out of model training" },
      { key: "telemetryEnabled", label: "OpenTelemetry", type: "boolean", description: "Export traces & metrics to PAKALON_OTEL_ENDPOINT when enabled" },
      { key: "shareUsageStats", label: "Share Usage Stats", type: "boolean", description: "Send anonymous line counts & model usage to Pakalon for product improvement" },
    ],
  },
  {
    id: "memory",
    label: "Memory",
    fields: [
      { key: "memory.autoSave", label: "Auto-Save PAKALON.md", type: "boolean", description: "Append session summary to PAKALON.md on exit", defaultValue: true },
      { key: "memory.autoSaveScope", label: "Save Scope", type: "string", description: "project = .pakalon/PAKALON.md  |  personal = ~/.config/pakalon/PAKALON.md" },
      { key: "memory.autoSaveInterval", label: "Save Interval (min)", type: "number", description: "How often (in minutes) to write a periodic snapshot (0 = only on exit)" },
    ],
  },
  {
    id: "hooks",
    label: "Hooks",
    fields: [
      { key: "disableAllHooks", label: "Disable All Hooks", type: "boolean", description: "Globally disable all pre/post hooks (emergency off-switch)" },
      { key: "allowedHttpHookUrls", label: "Allowed HTTP URLs", type: "stringArray", description: "URL prefixes that HTTP hooks are allowed to call (leave empty = allow all)" },
    ],
  },
  {
    id: "git",
    label: "Git",
    fields: [
      { key: "git.attribution", label: "Co-Authored-By Trailer", type: "boolean", description: "Add 'Co-Authored-By: Pakalon <pakalon@pakalon.dev>' to all commits", defaultValue: true },
      { key: "git.autoPush", label: "Auto Push", type: "boolean", description: "Automatically push after each commit made by Pakalon" },
      { key: "git.defaultBranch", label: "Default Branch", type: "string", description: "Branch name used for new repos (default: main)" },
      { key: "statusLine.command", label: "Status Line Script", type: "string", description: "Shell command whose first output line is shown in the status bar (polled every 10s)" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a nested value from a settings object using a dotted key path */
function getNestedValue(settings: PakalonSettings, key: string): unknown {
  const parts = key.split(".");
  let cur: unknown = settings;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Format a value for display */
function displayValue(val: unknown, type: FieldType, defaultValue?: unknown): string {
  if (val === undefined || val === null) {
    if (defaultValue !== undefined) return `(default: ${JSON.stringify(defaultValue)})`;
    return "—";
  }
  if (type === "boolean") return val ? "✔ true" : "✘ false";
  if (type === "stringArray") return Array.isArray(val) ? (val as string[]).join(", ") || "—" : String(val);
  return String(val);
}

// Colors
const TAB_ACTIVE = "cyan";
const TAB_INACTIVE = "gray";
const FIELD_ACTIVE = "cyan";
const HINT_COLOR = "gray";
const VALUE_COLOR = "yellow";
const EDIT_BG = "blue";

// ---------------------------------------------------------------------------
// ConfigScreen component
// ---------------------------------------------------------------------------

interface ConfigScreenProps {
  projectDir?: string;
  scope?: SettingsScope;
  onExit?: () => void;
}

const ConfigScreen: React.FC<ConfigScreenProps> = ({
  projectDir,
  scope = "project",
  onExit,
}) => {
  const { exit: inkExit } = useApp();
  const doExit = useCallback(() => {
    onExit?.();
    inkExit();
  }, [onExit, inkExit]);

  const [activeTab, setActiveTab] = useState(0);
  const [activeRow, setActiveRow] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [editBuffer, setEditBuffer] = useState("");
  const [settings, setSettings] = useState<PakalonSettings>(() => getSettings(projectDir));
  const [saved, setSaved] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const currentTab = TABS[activeTab]!;
  const currentField = currentTab.fields[activeRow];

  // Reload settings when tab changes
  useEffect(() => {
    setSettings(getSettings(projectDir));
    setActiveRow(0);
    setEditMode(false);
  }, [activeTab, projectDir]);

  // Save a field value
  const saveFieldValue = useCallback(
    (field: FieldDef, value: unknown) => {
      const parts = field.key.split(".");
      if (parts.length === 1) {
        setSetting(field.key, value, scope, projectDir);
      } else {
        // Nested: write via top-level key with merged object
        const topKey = parts[0]!;
        const subKey = parts.slice(1).join(".");
        const existing = (settings[topKey] as Record<string, unknown>) ?? {};
        setSetting(topKey, { ...existing, [subKey]: value }, scope, projectDir);
      }
      setSettings(getSettings(projectDir));
      setSaved(true);
      setSavedMsg(`Saved: ${field.label}`);
      setTimeout(() => setSaved(false), 2000);
    },
    [scope, projectDir, settings],
  );

  const handleInput = useCallback(
    (
      input: string,
      key: {
        leftArrow: boolean;
        rightArrow: boolean;
        upArrow: boolean;
        downArrow: boolean;
        return: boolean;
        escape: boolean;
        ctrl: boolean;
        tab: boolean;
      },
    ) => {
      // Edit mode: capture text
      if (editMode) {
        if (key.escape) {
          setEditMode(false);
          setEditBuffer("");
          return;
        }
        if (key.return) {
          if (!currentField) return;
          const { type } = currentField;
          let parsed: unknown = editBuffer;
          if (type === "number") parsed = parseFloat(editBuffer) || 0;
          if (type === "stringArray") parsed = editBuffer.split(",").map((s) => s.trim()).filter(Boolean);
          saveFieldValue(currentField, parsed);
          setEditMode(false);
          setEditBuffer("");
          return;
        }
        if (input === "\x7f" || input === "\b") {
          setEditBuffer((prev) => prev.slice(0, -1));
          return;
        }
        if (!key.ctrl && input && input.length === 1) {
          setEditBuffer((prev) => prev + input);
        }
        return;
      }

      // Tab navigation (Left/Right)
      if (key.leftArrow || (input === "h" && !key.ctrl)) {
        setActiveTab((prev) => (prev - 1 + TABS.length) % TABS.length);
        return;
      }
      if (key.rightArrow || (input === "l" && !key.ctrl) || key.tab) {
        setActiveTab((prev) => (prev + 1) % TABS.length);
        return;
      }

      // Row navigation (Up/Down)
      if (key.upArrow || input === "k") {
        setActiveRow((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setActiveRow((prev) => Math.min(currentTab.fields.length - 1, prev + 1));
        return;
      }

      // Confirm / toggle
      if (key.return || input === " ") {
        if (!currentField) return;
        const { type } = currentField;
        if (type === "boolean") {
          const cur = getNestedValue(settings, currentField.key);
          saveFieldValue(currentField, !cur);
        } else {
          // Enter edit mode for string/number/stringArray
          const cur = getNestedValue(settings, currentField.key);
          setEditBuffer(
            type === "stringArray"
              ? Array.isArray(cur) ? (cur as string[]).join(", ") : ""
              : cur !== undefined && cur !== null ? String(cur) : "",
          );
          setEditMode(true);
        }
        return;
      }

      // Delete key
      if (input === "d" && !key.ctrl) {
        if (!currentField) return;
        saveFieldValue(currentField, undefined);
        return;
      }

      // Quit
      if (input === "q" || (key.ctrl && input === "c") || key.escape) {
        doExit();
      }
    },
    [editMode, editBuffer, currentField, currentTab, settings, saveFieldValue, doExit],
  );

  useInput(handleInput);

  // Render
  return (
    <Box flexDirection="column" padding={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ⚙  Pakalon Settings
        </Text>
        <Text color="gray"> — scope: </Text>
        <Text color="yellow">{scope}</Text>
        {projectDir && (
          <>
            <Text color="gray">  dir: </Text>
            <Text color="gray" dimColor>{projectDir}</Text>
          </>
        )}
      </Box>

      {/* Tab bar */}
      <Box marginBottom={1}>
        {TABS.map((tab, i) => (
          <Box key={tab.id} marginRight={1}>
            <Text
              bold={i === activeTab}
              color={i === activeTab ? TAB_ACTIVE : TAB_INACTIVE}
              underline={i === activeTab}
            >
              {i === activeTab ? `[${tab.label}]` : ` ${tab.label} `}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Fields */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={2} paddingY={1} minHeight={12}>
        {currentTab.fields.map((field, idx) => {
          const isActive = idx === activeRow;
          const val = getNestedValue(settings, field.key);
          const inEdit = isActive && editMode;
          return (
            <Box key={field.key} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={isActive ? FIELD_ACTIVE : undefined} bold={isActive}>
                  {isActive ? "▶ " : "  "}
                </Text>
                <Text bold={isActive} color={isActive ? FIELD_ACTIVE : undefined}>
                  {field.label}
                </Text>
                <Text color="gray">: </Text>
                {inEdit ? (
                  <Box backgroundColor={EDIT_BG} paddingX={1}>
                    <Text>{editBuffer}</Text>
                    <Text color="white">█</Text>
                  </Box>
                ) : (
                  <Text color={val !== undefined ? VALUE_COLOR : "gray"} dimColor={val === undefined}>
                    {displayValue(val, field.type, field.defaultValue)}
                  </Text>
                )}
              </Box>
              {isActive && (
                <Box marginLeft={4}>
                  <Text color="gray" dimColor>
                    {field.description}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Save feedback */}
      {saved && (
        <Box marginTop={1}>
          <Text color="green">✔ {savedMsg}</Text>
        </Box>
      )}

      {/* Hints */}
      <Box marginTop={1}>
        <Text color={HINT_COLOR} dimColor>
          ←/→ tabs  ↑/↓ rows  Enter=edit/toggle  d=delete  q=quit
        </Text>
      </Box>
    </Box>
  );
};

export default ConfigScreen;
