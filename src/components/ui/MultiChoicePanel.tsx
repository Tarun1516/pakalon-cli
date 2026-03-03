/**
 * MultiChoicePanel — Human-in-the-Loop (HIL) interactive choice panel.
 *
 * Used by AgentScreen and ChatScreen when the Python pipeline emits a
 * `choice_request` SSE event (e.g. Phase 1 planning confirmation,
 * Phase 5 environment promotion gate, Phase 6 documentation skip).
 *
 * Navigation:
 *   ↑/↓ or k/j   — move cursor
 *   Enter / Space — confirm selection
 *   Escape        — cancel (calls onCancel if provided)
 *
 * Props:
 *   question        — the question text to display
 *   choices         — array of { id, label, description? }
 *   onSelect        — called with the selected choice id
 *   onCancel?       — called when the user presses Escape
 *   followUpPrompt? — optional free-text prompt shown after selection
 *   onFollowUp?     — called with the typed follow-up text
 *   title?          — panel header title (default: "Choose an option")
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Choice {
  id: string;
  label: string;
  description?: string;
}

export interface MultiChoicePanelProps {
  question: string;
  choices: Choice[];
  onSelect: (choiceId: string) => void;
  onCancel?: () => void;
  title?: string;
  /** When true, shows a free-text input after a choice is made */
  followUpPrompt?: string;
  onFollowUp?: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CURSOR = "▶";
const CURSOR_EMPTY = " ";
const BORDER_COLOR = "cyan";
const SELECTED_COLOR = "cyan";
const QUESTION_COLOR = "white";
const DESC_COLOR = "gray";
const TITLE_COLOR = "cyan";
const HINT_COLOR = "gray";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MultiChoicePanel: React.FC<MultiChoicePanelProps> = ({
  question,
  choices,
  onSelect,
  onCancel,
  title = "Choose an option",
  followUpPrompt,
  onFollowUp,
}) => {
  const [cursor, setCursor] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [followUpText, setFollowUpText] = useState("");
  const [inFollowUp, setInFollowUp] = useState(false);

  const safeChoices = choices.length > 0 ? choices : [{ id: "ok", label: "OK" }];

  const handleInput = useCallback(
    (input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean; escape: boolean; ctrl: boolean }) => {
      if (confirmed && !inFollowUp) return;

      if (inFollowUp) {
        if (key.return) {
          onFollowUp?.(followUpText);
          return;
        }
        if (key.escape) {
          setInFollowUp(false);
          setFollowUpText("");
          return;
        }
        if (input === "\x7f" || input === "\b") {
          setFollowUpText((prev) => prev.slice(0, -1));
          return;
        }
        if (!key.ctrl && input && input.length === 1) {
          setFollowUpText((prev) => prev + input);
        }
        return;
      }

      // Navigation
      if (key.upArrow || input === "k") {
        setCursor((prev) => (prev - 1 + safeChoices.length) % safeChoices.length);
      } else if (key.downArrow || input === "j") {
        setCursor((prev) => (prev + 1) % safeChoices.length);
      }

      // Confirm
      if (key.return || input === " ") {
        const selected = safeChoices[cursor];
        if (!selected) return;
        setConfirmed(true);
        if (followUpPrompt && onFollowUp) {
          setInFollowUp(true);
        } else {
          onSelect(selected.id);
        }
      }

      // Cancel
      if (key.escape) {
        onCancel?.();
      }

      // Number shortcuts: 1-9
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= safeChoices.length) {
        const sel = safeChoices[num - 1];
        if (sel) {
          setCursor(num - 1);
          setConfirmed(true);
          if (followUpPrompt && onFollowUp) {
            setInFollowUp(true);
          } else {
            onSelect(sel.id);
          }
        }
      }
    },
    [cursor, confirmed, inFollowUp, followUpText, safeChoices, followUpPrompt, onSelect, onCancel, onFollowUp],
  );

  useInput(handleInput);

  // After confirmation (no follow-up), show a brief "selected" indicator.
  if (confirmed && !inFollowUp && !followUpPrompt) {
    const sel = safeChoices[cursor];
    return (
      <Box flexDirection="column" marginY={1}>
        <Box borderStyle="single" borderColor="green" paddingX={2} paddingY={0}>
          <Text color="green">✔ </Text>
          <Text color="white">{sel?.label ?? "OK"}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Title bar */}
      <Box borderStyle="single" borderColor={BORDER_COLOR} paddingX={2} paddingY={0}>
        <Text bold color={TITLE_COLOR}>
          {title}
        </Text>
      </Box>

      {/* Question */}
      <Box paddingX={2} marginTop={1} marginBottom={1}>
        <Text color={QUESTION_COLOR} wrap="wrap">
          {question}
        </Text>
      </Box>

      {/* Choices */}
      <Box flexDirection="column" paddingX={2}>
        {safeChoices.map((choice, idx) => {
          const isActive = idx === cursor;
          return (
            <Box key={choice.id} flexDirection="column" marginBottom={choice.description ? 1 : 0}>
              <Box>
                <Text color={isActive ? SELECTED_COLOR : undefined}>
                  {isActive ? CURSOR : CURSOR_EMPTY}{" "}
                </Text>
                <Text color={isActive ? SELECTED_COLOR : undefined} bold={isActive}>
                  {idx + 1}. {choice.label}
                </Text>
              </Box>
              {choice.description && (
                <Box marginLeft={3}>
                  <Text color={DESC_COLOR} dimColor>
                    {choice.description}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Follow-up input (if in that state) */}
      {inFollowUp && followUpPrompt && (
        <Box flexDirection="column" paddingX={2} marginTop={1}>
          <Text color={QUESTION_COLOR}>{followUpPrompt}</Text>
          <Box marginTop={1}>
            <Text color={SELECTED_COLOR}>❯ </Text>
            <Text>{followUpText}</Text>
            <Text color={SELECTED_COLOR}>█</Text>
          </Box>
        </Box>
      )}

      {/* Keyboard hints */}
      <Box paddingX={2} marginTop={1}>
        <Text color={HINT_COLOR} dimColor>
          ↑/↓ navigate  Enter/Num select{onCancel ? "  Esc cancel" : ""}
        </Text>
      </Box>
    </Box>
  );
};

export default MultiChoicePanel;
