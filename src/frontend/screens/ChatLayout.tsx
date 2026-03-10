/**
 * ChatLayout — authenticated main-app shell.
 *
 * Stack from top to bottom:
 *   ┌──────────────────────────────────────────────┐
 *   │  HeaderBar (single logo + identity card)         │
 *   ├──────────────────────────────────────────────┤
 *   │  ContextBar (context window progress)        │
 *   ├──────────────────────────────────────────────┤
 *   │  ChatScreen (full chat UI — messages + input) │
 *   └──────────────────────────────────────────────┘
 */
import React from "react";
import { Box } from "ink";
import HeaderBar from "@/frontend/components/HeaderBar.js";
import ContextBar from "@/components/ui/ContextBar.js";
import ChatScreen from "@/components/screens/ChatScreen.js";

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
  return (
    <Box flexDirection="column" width="100%">
      <HeaderBar showLogo />
      <ContextBar projectDir={projectDir} />

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
      </Box>
    </Box>
  );
};

export default ChatLayout;
