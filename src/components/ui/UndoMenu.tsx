/**
 * UndoMenu — interactive Ink component for reverting AI actions.
 *
 * Offers 4 options per requirement:
 *   1. Undo conversation  — removes the last user+assistant message pair
 *   2. Undo code          — reverts the last file write(s) by the AI
 *   3. Undo code & conversation — both of the above
 *   4. Do nothing         — dismiss without any change
 */
import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { undoManager } from "@/ai/undo-manager.js";

interface UndoMenuProps {
  /** Called after a successful undo with a human-readable summary message. */
  onDone: (message: string) => void;
  /** Called when the user picks "Do nothing" or cancels. */
  onCancel: () => void;
  /** Callback to remove the last user+assistant exchange from the chat history. */
  onUndoConversation?: () => number; // returns count of messages removed
}

const UndoMenu: React.FC<UndoMenuProps> = ({ onDone, onCancel, onUndoConversation }: UndoMenuProps) => {
  const codeHistory = undoManager.getHistory(5);
  const [done, setDone] = useState(false);

  if (done) return null;

  // ── Build summary lines for context ─────────────────────────────────
  const codePreview = codeHistory.length > 0
    ? codeHistory
        .slice(0, 3)
        .map((s) => `  ${s.operation === "write" ? "✏️" : "🗑"} ${s.path.replace(/\\/g, "/")}`)
        .join("\n")
    : "  (no recent file changes)";

  const items = [
    {
      label: "1.  Undo conversation  — remove last AI reply from chat (no file changes)",
      value: "conversation",
    },
    {
      label: `2.  Undo code          — revert last file write(s) (${codeHistory.length} file op${codeHistory.length !== 1 ? "s" : ""})`,
      value: "code",
    },
    {
      label: "3.  Undo code & conversation — revert files AND remove last AI reply",
      value: "both",
    },
    {
      label: "4.  Do nothing         — dismiss, no changes",
      value: "nothing",
    },
  ];

  // ── Shared helpers ───────────────────────────────────────────────────
  const revertCode = (): string => {
    if (!codeHistory.length) return "No recent file operations to undo.";
    let count = 0;
    for (const s of codeHistory) {
      if (undoManager.undoById(s.id)) count++;
    }
    return count > 0
      ? `Reverted ${count} file operation(s):\n${codeHistory.slice(0, count).map((s) => `  ${s.path}`).join("\n")}`
      : "No file operations could be reverted.";
  };

  const revertConversation = (): string => {
    if (!onUndoConversation) return "Conversation undo is not available in this session.";
    const removed = onUndoConversation();
    return removed > 0
      ? `Removed last ${removed} message(s) from conversation history.`
      : "No conversation messages to undo.";
  };

  const handleSelect = (item: { value: string }) => {
    setDone(true);
    switch (item.value) {
      case "conversation": {
        const msg = revertConversation();
        onDone(msg);
        break;
      }
      case "code": {
        const msg = revertCode();
        onDone(msg);
        break;
      }
      case "both": {
        const codePart = revertCode();
        const convPart = revertConversation();
        onDone(`${codePart}\n${convPart}`);
        break;
      }
      case "nothing":
      default:
        onCancel();
        break;
    }
  };

  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      flexDirection="column"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="yellow">↩  Undo — what would you like to revert?</Text>
      <Text> </Text>
      {codeHistory.length > 0 && (
        <>
          <Text dimColor>Recent file changes:</Text>
          <Text dimColor>{codePreview}</Text>
          <Text> </Text>
        </>
      )}
      <SelectInput items={items} onSelect={handleSelect} />
    </Box>
  );
};

export default UndoMenu;
