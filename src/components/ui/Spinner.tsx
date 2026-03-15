/**
 * Spinner UI component — animated loading indicator.
 */
import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { PAKALON_GOLD } from "@/constants/colors.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DOT_FRAMES = ["●", "○"];
const INTERVAL_MS = 80;
const DOT_INTERVAL_MS = 360;

interface SpinnerProps {
  label?: string;
  variant?: "spinner" | "dot";
  intervalMs?: number;
}

const Spinner: React.FC<SpinnerProps> = ({ label, variant = "spinner", intervalMs }) => {
  const [frame, setFrame] = useState(0);
  const frames = variant === "dot" ? DOT_FRAMES : SPINNER_FRAMES;
  const tickMs = intervalMs ?? (variant === "dot" ? DOT_INTERVAL_MS : INTERVAL_MS);

  useEffect(() => {
    const timer = setInterval(() => {
	  setFrame((f) => (f + 1) % frames.length);
	}, tickMs);
    return () => clearInterval(timer);
  }, [frames.length, tickMs]);

	const currentFrame = frames[frame] ?? frames[0]!;

  return (
    <Text>
      <Text color={PAKALON_GOLD}>{currentFrame} </Text>
      {label && <Text>{label}</Text>}
    </Text>
  );
};

export default Spinner;
