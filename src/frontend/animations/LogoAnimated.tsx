/**
 * LogoAnimated — wrapper around the Video-animation ASCII animation.
 * Used on first launch splash screen.
 */
import MiniLogoAnimation from "@/frontend/animations/MiniLogoAnimation.js";
import React from "react";

export interface LogoAnimatedProps {
  /** Loop the animation (default false — plays once then holds last frame) */
  loop?: boolean;
  /** Whether terminal has dark background (default true) */
  hasDarkBackground?: boolean;
  /** Called when the animation finishes its first pass */
  onFinished?: () => void;
}

const LogoAnimated: React.FC<LogoAnimatedProps> = ({
  loop = false,
  hasDarkBackground = true,
  onFinished,
}) => {
  const handleReady = React.useCallback(
    (api: { play: () => void; pause: () => void; restart: () => void }) => {
      api.play();
    },
    []
  );

  // onDone fires via MiniLogoAnimation's own onDone callback when the last frame completes.
  // This is timing-accurate regardless of SPEED_MULTIPLIER.
  const handleDone = React.useCallback(() => {
    onFinished?.();
  }, [onFinished]);

  return (
    <MiniLogoAnimation
      hasDarkBackground={hasDarkBackground}
      autoPlay
      loop={loop}
      onReady={handleReady}
      onDone={handleDone}
    />
  );
};

export default LogoAnimated;
