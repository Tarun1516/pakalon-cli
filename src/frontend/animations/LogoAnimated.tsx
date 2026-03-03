/**
 * LogoAnimated — wrapper around the Video-animation ASCII animation.
 * Used on first launch splash screen.
 */
// @ts-ignore — asset file outside src/, resolved by Bun at runtime
import LoadingAnimationAsset from "@assets/Video-animation/loading-animation.js";
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
  const [done, setDone] = React.useState(false);

  const handleReady = React.useCallback(
    (api: { play: () => void; pause: () => void; restart: () => void }) => {
      api.play();
    },
    []
  );

  // Fire onFinished after a fixed duration matching the animation (≈2 s at 12 fps × ~24 frames)
  React.useEffect(() => {
    if (done || loop) return;
    const totalDuration = 83.33 * 24 + 200; // frames × ms/frame + buffer
    const t = setTimeout(() => {
      setDone(true);
      onFinished?.();
    }, totalDuration);
    return () => clearTimeout(t);
  }, [done, loop, onFinished]);

  return (
    <LoadingAnimationAsset
      hasDarkBackground={hasDarkBackground}
      autoPlay
      loop={loop}
      onReady={handleReady}
    />
  );
};

export default LogoAnimated;
