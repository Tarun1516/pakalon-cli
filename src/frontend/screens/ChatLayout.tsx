/**
 * ChatLayout — authenticated main-app shell.
 *
 * Stack from top to bottom:
 *   ┌──────────────────────────────────────────────┐
 *   │  HeaderBar (logo + user + model + ctx + credits) │
 *   ├──────────────────────────────────────────────┤
 *   │  LogoStatic animation (plays once on mount)  │
 *   │            (hidden after 3.5s)               │
 *   ├──────────────────────────────────────────────┤
 *   │  ChatScreen (full chat UI — messages + input) │
 *   ├──────────────────────────────────────────────┤
 *   │  FileChangeSummary (lines added / deleted)   │
 *   └──────────────────────────────────────────────┘
 */
import React, { useState, useEffect } from "react";
import { Box } from "ink";
import HeaderBar from "@/frontend/components/HeaderBar.js";
import FileChangeSummary from "@/frontend/components/FileChangeSummary.js";
import ChatScreen from "@/components/screens/ChatScreen.js";

import LogoStaticImport from "@/frontend/animations/LogoStatic.js";

// Load LogoStatic lazily — it depends on the asset import chain
const LogoStaticComponent: React.ComponentType<{
  hasDarkBackground?: boolean;
  static?: boolean;
}> | null = LogoStaticImport ?? null;

interface ChatLayoutProps {
  initialMessage?: string;
  projectDir?: string;
  showBanner?: boolean;
  modelOverride?: string;
  defaultModel?: string;
  fallbackModel?: string;
  addDirs?: string[];
  allowedTools?: string;
  mcpServers?: string[];
  replayMessages?: string[];
  fileContexts?: string[];
  maxBudgetUsd?: number;
  disableSlashCommands?: boolean;
  systemPrompt?: string;
  /** When true, play the logo animation once on mount (first session) */
  playLogoAnimation?: boolean;
  /** Memory file content (PAKALON.md/CLAUDE.md) to inject into system prompt */
  memoryBlock?: string;
}

const LOGO_ANIM_DURATION_MS = 3500; // Show animated logo for 3.5s then hide

const ChatLayout: React.FC<ChatLayoutProps> = ({
  initialMessage,
  projectDir,
  showBanner = false, // HeaderBar replaces Banner
  modelOverride,
  defaultModel,
  fallbackModel,
  addDirs = [],
  allowedTools,
  mcpServers = [],
  replayMessages = [],
  fileContexts = [],
  maxBudgetUsd,
  disableSlashCommands = false,
  systemPrompt,
  playLogoAnimation = false,
  memoryBlock = "",
}) => {
  const [showLogoAnim, setShowLogoAnim] = useState(playLogoAnimation);

  // Auto-hide logo animation after its duration
  useEffect(() => {
    if (!playLogoAnimation) return;
    const t = setTimeout(() => setShowLogoAnim(false), LOGO_ANIM_DURATION_MS);
    return () => clearTimeout(t);
  }, [playLogoAnimation]);

  return (
    <Box flexDirection="column" width="100%">
      {/* ── Top: persistent header ───────────────────────────────────── */}
      <HeaderBar showLogo />

      {/* ── Logo animation (shown only once per session on first login) ── */}
      {showLogoAnim && LogoStaticComponent && (
        <Box justifyContent="center" marginY={1}>
          <LogoStaticComponent hasDarkBackground />
        </Box>
      )}

      {/* ── Chat area (fills remaining vertical space) ─────────────── */}
      <Box flexGrow={1} flexDirection="column">
        <ChatScreen
          initialMessage={initialMessage}
          projectDir={projectDir}
          showBanner={showBanner}
          modelOverride={modelOverride}
          defaultModel={defaultModel}
          fallbackModel={fallbackModel}
          addDirs={addDirs}
          allowedTools={allowedTools}
          mcpServers={mcpServers}
          replayMessages={replayMessages}
          fileContexts={fileContexts}
          maxBudgetUsd={maxBudgetUsd}
          disableSlashCommands={disableSlashCommands}
          systemPrompt={systemPrompt}
          memoryBlock={memoryBlock}
        />
          initialMessage={initialMessage}
          projectDir={projectDir}
          showBanner={showBanner}
          modelOverride={modelOverride}
          defaultModel={defaultModel}
          fallbackModel={fallbackModel}
          addDirs={addDirs}
          allowedTools={allowedTools}
          mcpServers={mcpServers}
          replayMessages={replayMessages}
          fileContexts={fileContexts}
          maxBudgetUsd={maxBudgetUsd}
          disableSlashCommands={disableSlashCommands}
          systemPrompt={systemPrompt}
        />
      </Box>

      {/* ── Bottom: file change stats ──────────────────────────────── */}
      <FileChangeSummary />
    </Box>
  );
};

export default ChatLayout;
