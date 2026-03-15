/**
 * MessageList — renders the conversation history in Ink.
 * T-CLI-11: Inline image rendering via term-img for image paths detected in messages.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, Static } from "ink";
import type { ChatMessage } from "@/store/slices/session.slice.js";
import { PAKALON_GOLD, TEXT_PRIMARY } from "@/constants/colors.js";
import { getShellWidth } from "@/utils/shell-layout.js";

const PAKALON_ASSISTANT_COLOR = PAKALON_GOLD;

// T-CLI-11: Extract image file paths from message text
const IMAGE_PATH_RE = /(?:^|\s)((?:\.{0,2}\/|[A-Za-z]:[/\\]|\/)[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp|bmp|svg))(?:\s|$)/gi;

function extractImagePaths(text: string): string[] {
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  IMAGE_PATH_RE.lastIndex = 0;
  while ((match = IMAGE_PATH_RE.exec(text)) !== null) {
    if (match[1]) paths.push(match[1].trim());
  }
  return paths;
}

// T-CLI-11: Lazy-load term-img and render image inline in terminal
const InlineImage: React.FC<{ filePath: string }> = ({ filePath }) => {
  const [pixels, setPixels] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // term-img is ESM — dynamic import at usage time
        const termImg = await import("term-img");
        const render = termImg.default ?? termImg;
        const output = render(filePath, { width: 40, fallback: () => `[image: ${filePath}]` });
        if (!cancelled) setPixels(typeof output === "string" ? output : `[image: ${filePath}]`);
      } catch (err: unknown) {
        if (!cancelled) setError(`[image unavailable: ${filePath}]`);
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  if (error) return <Text dimColor>{error}</Text>;
  if (pixels === null) return <Text dimColor>loading image…</Text>;
  // term-img outputs raw escape sequences — print directly
  return (
    <Box flexDirection="column">
      {/* eslint-disable-next-line react/no-danger-with-children */}
      <Text>{pixels}</Text>
      <Text dimColor color="gray">image {filePath}</Text>
    </Box>
  );
};

interface MessageListProps {
  messages: ChatMessage[];
  maxVisible?: number;
  assistantBusy?: boolean;
}

const AssistantBadge: React.FC<{ animate?: boolean }> = ({ animate = false }) => {
  return (
    <Box marginRight={1} minWidth={3}>
      <Text color={PAKALON_ASSISTANT_COLOR} bold={animate}>{animate ? "●" : "○"}</Text>
    </Box>
  );
};

const MessageItemBase: React.FC<{
  msg: ChatMessage;
  animateAssistant?: boolean;
}> = ({ msg, animateAssistant = false }) => {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";
  const isTool = msg.role === "tool";
  const isAssistant = !isUser && !isSystem && !isTool;

  if (isSystem) {
    return (
      <Box marginY={0}>
        <Text dimColor color="gray">
          [system] {msg.content}
        </Text>
      </Box>
    );
  }

  if (isTool) {
    return (
      <Box marginY={0}>
        <Text color="magenta">[tool] {msg.content}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={0}>
      <Box gap={1} alignItems="flex-start">
        {isUser ? (
          <Text
            bold
            color={TEXT_PRIMARY}
          >
            you
          </Text>
        ) : (
          <AssistantBadge animate={animateAssistant} />
        )}
        <Text dimColor>
          {msg.createdAt.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        <Text wrap="wrap">{msg.content}</Text>
        {/* T-CLI-11: Render any image file paths embedded in the message inline */}
        {!msg.isStreaming && extractImagePaths(msg.content).map((imgPath) => (
          <InlineImage key={imgPath} filePath={imgPath} />
        ))}
      </Box>
    </Box>
  );
};

const MessageItem = React.memo(MessageItemBase);

const BusyRow: React.FC = () => (
  <Box flexDirection="column" marginY={0}>
    <Box gap={1} alignItems="flex-start">
      <AssistantBadge animate />
      <Text dimColor>
        {new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </Text>
    </Box>
    <Box paddingLeft={2}>
      <Text color={PAKALON_ASSISTANT_COLOR}>Agent running…</Text>
    </Box>
  </Box>
);

const MessageList: React.FC<MessageListProps> = ({ messages, maxVisible = 20, assistantBusy = false }) => {
  const shellWidth = getShellWidth(process.stdout.columns ?? 80);
  const activeAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message) continue;
      if (message.role !== "user" && message.role !== "system" && message.role !== "tool") {
        return message.id;
      }
    }
    return null;
  }, [messages]);

  const lastUserIndex = useMemo(() => {
    return messages.map((m) => m.role).lastIndexOf("user");
  }, [messages]);

  const staticMessages = useMemo(() => {
     if (lastUserIndex <= 0) return [];
     return messages.slice(0, lastUserIndex);
  }, [messages, lastUserIndex]);

  const activeMessages = useMemo(() => {
    if (lastUserIndex < 0) return messages;
    return messages.slice(lastUserIndex);
  }, [messages, lastUserIndex]);

  const hasStreamingAssistant = useMemo(
    () => activeMessages.some((message) => message.role !== "user" && message.role !== "system" && message.role !== "tool" && message.isStreaming),
    [activeMessages]
  );

  return (
    <Box width="100%" justifyContent="center" flexGrow={1} flexDirection="column">
      <Box display="none">
        {/* We keep this to satisfy TypeScript and Ink static imports, but import Static at file top instead */}
      </Box>
      <Static items={staticMessages}>
        {(msg: ChatMessage) => (
          <Box key={msg.id} width={shellWidth} flexDirection="column" paddingBottom={1}>
            <MessageItem msg={msg} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column" flexGrow={1} width={shellWidth}>
        {activeMessages.map((msg) => (
          <MessageItem
            key={msg.id}
            msg={msg}
            animateAssistant={msg.id === activeAssistantMessageId && assistantBusy}
          />
        ))}
        {assistantBusy && !hasStreamingAssistant && <BusyRow />}
      </Box>
    </Box>
  );
};

export default MessageList;
