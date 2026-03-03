/**
 * LogoStatic — wrapper around the text-animation ASCII logo.
 * Plays the animated build-up once, then holds the final frame.
 * Used in the chat header for all sessions after first login.
 */
// @ts-ignore — asset file outside src/, resolved by Bun at runtime
import InkBlackAsset from "@assets/text-animation/ink-black.js";
import React from "react";

export interface LogoStaticProps {
  /** Whether terminal has dark background (default true) */
  hasDarkBackground?: boolean;
  /** When true, skip animation and show logo immediately (static-only mode) */
  static?: boolean;
}

const LogoStatic: React.FC<LogoStaticProps> = ({
  hasDarkBackground = true,
  static: isStatic = false,
}) => {
  return (
    <InkBlackAsset
      hasDarkBackground={hasDarkBackground}
      autoPlay={!isStatic}
      loop={false}
    />
  );
};

export default LogoStatic;
