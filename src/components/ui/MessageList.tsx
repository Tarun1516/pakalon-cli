/**
 * MessageList — renders the conversation history in Ink.
 * T-CLI-11: Inline image rendering via term-img for image paths detected in messages.
 */
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
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
}

const MessageItem: React.FC<{ msg: ChatMessage }> = ({ msg }) => {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";
  const isTool = msg.role === "tool";

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
      <Box gap={1}>
        <Text
          bold
          color={isUser ? TEXT_PRIMARY : PAKALON_ASSISTANT_COLOR}
        >
          {isUser ? "you" : "pakalon"}
        </Text>
        <Text dimColor>
          {msg.createdAt.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Text>
        {msg.isStreaming && <Text color={PAKALON_ASSISTANT_COLOR}>●</Text>}
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

const MessageList: React.FC<MessageListProps> = ({ messages, maxVisible = 20 }) => {
  const visible = messages.slice(-maxVisible);
  const shellWidth = getShellWidth(process.stdout.columns ?? 80);

  if (visible.length === 0) {
    return (
      <Box width="100%" justifyContent="center" flexGrow={1}>
        <Box flexGrow={1} width={shellWidth} />
      </Box>
    );
  }

  return (
    <Box width="100%" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1} width={shellWidth}>
        {messages.length > maxVisible && (
          <Text dimColor>
            ↑ {messages.length - maxVisible} earlier messages hidden
          </Text>
        )}
        {visible.map((msg) => (
          <MessageItem key={msg.id} msg={msg} />
        ))}
      </Box>
    </Box>
  );
};

export default MessageList;
