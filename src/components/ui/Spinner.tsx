/**
 * Spinner UI component — animated loading indicator.
 */
import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { PAKALON_GOLD } from "@/constants/colors.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

interface SpinnerProps {
  label?: string;
}

const Spinner: React.FC<SpinnerProps> = ({ label }) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const currentFrame = FRAMES[frame] ?? FRAMES[0]!;

  return (
    <Text>
      <Text color={PAKALON_GOLD}>{currentFrame} </Text>
      {label && <Text>{label}</Text>}
    </Text>
  );
};

export default Spinner;
