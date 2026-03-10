import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';

// Color themes - edit these values to customize for each background type
// THEME_DARK is used when hasDarkBackground={true} (default)
// THEME_LIGHT is used when hasDarkBackground={false}
const THEME_DARK: Record<string, string> = {
  whiteBright: 'whiteBright',
};

const THEME_LIGHT: Record<string, string> = {
  whiteBright: 'blackBright',
};

type FrameData = {
  duration: number;
  content: string[];
  fgColors: Record<string, string>;
  bgColors: Record<string, string>;
};

type PlaybackAPI = {
  play: () => void;
  pause: () => void;
  restart: () => void;
};

type InkBlackProps = {
  hasDarkBackground?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  onReady?: (api: PlaybackAPI) => void;
};

const FRAMES: FrameData[] = [
  {
    "duration": 100,
    "content": [
      "██████╗  █████╗ ██╗  ██╗ █████╗ ██╗      ██████╗ ███╗   ██╗    ",
      "██╔══██╗██╔══██╗██║ ██╔╝██╔══██╗██║     ██╔═══██╗████╗  ██║    ",
      "██████╔╝███████║█████╔╝ ███████║██║     ██║   ██║██╔██╗ ██║    ",
      "██╔═══╝ ██╔══██║██╔═██╗ ██╔══██║██║     ██║   ██║██║╚██╗██║    ",
      "██║     ██║  ██║██║  ██╗██║  ██║███████╗╚██████╔╝██║ ╚████║    ",
      "╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝    "
    ],
    "fgColors": {
      "0,0": "whiteBright",
      "1,0": "whiteBright",
      "2,0": "whiteBright",
      "3,0": "whiteBright",
      "4,0": "whiteBright",
      "5,0": "whiteBright",
      "6,0": "whiteBright",
      "9,0": "whiteBright",
      "10,0": "whiteBright",
      "11,0": "whiteBright",
      "12,0": "whiteBright",
      "13,0": "whiteBright",
      "14,0": "whiteBright",
      "16,0": "whiteBright",
      "17,0": "whiteBright",
      "18,0": "whiteBright",
      "21,0": "whiteBright",
      "22,0": "whiteBright",
      "23,0": "whiteBright",
      "25,0": "whiteBright",
      "26,0": "whiteBright",
      "27,0": "whiteBright",
      "28,0": "whiteBright",
      "29,0": "whiteBright",
      "30,0": "whiteBright",
      "32,0": "whiteBright",
      "33,0": "whiteBright",
      "34,0": "whiteBright",
      "41,0": "whiteBright",
      "42,0": "whiteBright",
      "43,0": "whiteBright",
      "44,0": "whiteBright",
      "45,0": "whiteBright",
      "46,0": "whiteBright",
      "47,0": "whiteBright",
      "49,0": "whiteBright",
      "50,0": "whiteBright",
      "51,0": "whiteBright",
      "52,0": "whiteBright",
      "56,0": "whiteBright",
      "57,0": "whiteBright",
      "58,0": "whiteBright",
      "0,1": "whiteBright",
      "1,1": "whiteBright",
      "2,1": "whiteBright",
      "3,1": "whiteBright",
      "4,1": "whiteBright",
      "5,1": "whiteBright",
      "6,1": "whiteBright",
      "7,1": "whiteBright",
      "8,1": "whiteBright",
      "9,1": "whiteBright",
      "10,1": "whiteBright",
      "11,1": "whiteBright",
      "12,1": "whiteBright",
      "13,1": "whiteBright",
      "14,1": "whiteBright",
      "15,1": "whiteBright",
      "16,1": "whiteBright",
      "17,1": "whiteBright",
      "18,1": "whiteBright",
      "20,1": "whiteBright",
      "21,1": "whiteBright",
      "22,1": "whiteBright",
      "23,1": "whiteBright",
      "24,1": "whiteBright",
      "25,1": "whiteBright",
      "26,1": "whiteBright",
      "27,1": "whiteBright",
      "28,1": "whiteBright",
      "29,1": "whiteBright",
      "30,1": "whiteBright",
      "31,1": "whiteBright",
      "32,1": "whiteBright",
      "33,1": "whiteBright",
      "34,1": "whiteBright",
      "40,1": "whiteBright",
      "41,1": "whiteBright",
      "42,1": "whiteBright",
      "43,1": "whiteBright",
      "44,1": "whiteBright",
      "45,1": "whiteBright",
      "46,1": "whiteBright",
      "47,1": "whiteBright",
      "48,1": "whiteBright",
      "49,1": "whiteBright",
      "50,1": "whiteBright",
      "51,1": "whiteBright",
      "52,1": "whiteBright",
      "53,1": "whiteBright",
      "56,1": "whiteBright",
      "57,1": "whiteBright",
      "58,1": "whiteBright",
      "0,2": "whiteBright",
      "1,2": "whiteBright",
      "2,2": "whiteBright",
      "3,2": "whiteBright",
      "4,2": "whiteBright",
      "5,2": "whiteBright",
      "6,2": "whiteBright",
      "7,2": "whiteBright",
      "8,2": "whiteBright",
      "9,2": "whiteBright",
      "10,2": "whiteBright",
      "11,2": "whiteBright",
      "12,2": "whiteBright",
      "13,2": "whiteBright",
      "14,2": "whiteBright",
      "15,2": "whiteBright",
      "16,2": "whiteBright",
      "17,2": "whiteBright",
      "18,2": "whiteBright",
      "19,2": "whiteBright",
      "20,2": "whiteBright",
      "21,2": "whiteBright",
      "22,2": "whiteBright",
      "24,2": "whiteBright",
      "25,2": "whiteBright",
      "26,2": "whiteBright",
      "27,2": "whiteBright",
      "28,2": "whiteBright",
      "29,2": "whiteBright",
      "30,2": "whiteBright",
      "31,2": "whiteBright",
      "32,2": "whiteBright",
      "33,2": "whiteBright",
      "34,2": "whiteBright",
      "40,2": "whiteBright",
      "41,2": "whiteBright",
      "42,2": "whiteBright",
      "46,2": "whiteBright",
      "47,2": "whiteBright",
      "48,2": "whiteBright",
      "49,2": "whiteBright",
      "50,2": "whiteBright",
      "51,2": "whiteBright",
      "52,2": "whiteBright",
      "53,2": "whiteBright",
      "54,2": "whiteBright",
      "56,2": "whiteBright",
      "57,2": "whiteBright",
      "58,2": "whiteBright",
      "0,3": "whiteBright",
      "1,3": "whiteBright",
      "2,3": "whiteBright",
      "3,3": "whiteBright",
      "4,3": "whiteBright",
      "5,3": "whiteBright",
      "6,3": "whiteBright",
      "8,3": "whiteBright",
      "9,3": "whiteBright",
      "10,3": "whiteBright",
      "11,3": "whiteBright",
      "12,3": "whiteBright",
      "13,3": "whiteBright",
      "14,3": "whiteBright",
      "15,3": "whiteBright",
      "16,3": "whiteBright",
      "17,3": "whiteBright",
      "18,3": "whiteBright",
      "19,3": "whiteBright",
      "20,3": "whiteBright",
      "21,3": "whiteBright",
      "22,3": "whiteBright",
      "24,3": "whiteBright",
      "25,3": "whiteBright",
      "26,3": "whiteBright",
      "27,3": "whiteBright",
      "28,3": "whiteBright",
      "29,3": "whiteBright",
      "30,3": "whiteBright",
      "31,3": "whiteBright",
      "32,3": "whiteBright",
      "33,3": "whiteBright",
      "34,3": "whiteBright",
      "40,3": "whiteBright",
      "41,3": "whiteBright",
      "42,3": "whiteBright",
      "46,3": "whiteBright",
      "47,3": "whiteBright",
      "48,3": "whiteBright",
      "49,3": "whiteBright",
      "50,3": "whiteBright",
      "51,3": "whiteBright",
      "52,3": "whiteBright",
      "53,3": "whiteBright",
      "54,3": "whiteBright",
      "55,3": "whiteBright",
      "56,3": "whiteBright",
      "57,3": "whiteBright",
      "58,3": "whiteBright",
      "0,4": "whiteBright",
      "1,4": "whiteBright",
      "2,4": "whiteBright",
      "8,4": "whiteBright",
      "9,4": "whiteBright",
      "10,4": "whiteBright",
      "13,4": "whiteBright",
      "14,4": "whiteBright",
      "15,4": "whiteBright",
      "16,4": "whiteBright",
      "17,4": "whiteBright",
      "18,4": "whiteBright",
      "21,4": "whiteBright",
      "22,4": "whiteBright",
      "23,4": "whiteBright",
      "24,4": "whiteBright",
      "25,4": "whiteBright",
      "26,4": "whiteBright",
      "29,4": "whiteBright",
      "30,4": "whiteBright",
      "31,4": "whiteBright",
      "32,4": "whiteBright",
      "33,4": "whiteBright",
      "34,4": "whiteBright",
      "35,4": "whiteBright",
      "36,4": "whiteBright",
      "37,4": "whiteBright",
      "38,4": "whiteBright",
      "39,4": "whiteBright",
      "40,4": "whiteBright",
      "41,4": "whiteBright",
      "42,4": "whiteBright",
      "43,4": "whiteBright",
      "44,4": "whiteBright",
      "45,4": "whiteBright",
      "46,4": "whiteBright",
      "47,4": "whiteBright",
      "48,4": "whiteBright",
      "49,4": "whiteBright",
      "50,4": "whiteBright",
      "51,4": "whiteBright",
      "53,4": "whiteBright",
      "54,4": "whiteBright",
      "55,4": "whiteBright",
      "56,4": "whiteBright",
      "57,4": "whiteBright",
      "58,4": "whiteBright",
      "0,5": "whiteBright",
      "1,5": "whiteBright",
      "2,5": "whiteBright",
      "8,5": "whiteBright",
      "9,5": "whiteBright",
      "10,5": "whiteBright",
      "13,5": "whiteBright",
      "14,5": "whiteBright",
      "15,5": "whiteBright",
      "16,5": "whiteBright",
      "17,5": "whiteBright",
      "18,5": "whiteBright",
      "21,5": "whiteBright",
      "22,5": "whiteBright",
      "23,5": "whiteBright",
      "24,5": "whiteBright",
      "25,5": "whiteBright",
      "26,5": "whiteBright",
      "29,5": "whiteBright",
      "30,5": "whiteBright",
      "31,5": "whiteBright",
      "32,5": "whiteBright",
      "33,5": "whiteBright",
      "34,5": "whiteBright",
      "35,5": "whiteBright",
      "36,5": "whiteBright",
      "37,5": "whiteBright",
      "38,5": "whiteBright",
      "39,5": "whiteBright",
      "41,5": "whiteBright",
      "42,5": "whiteBright",
      "43,5": "whiteBright",
      "44,5": "whiteBright",
      "45,5": "whiteBright",
      "46,5": "whiteBright",
      "47,5": "whiteBright",
      "49,5": "whiteBright",
      "50,5": "whiteBright",
      "51,5": "whiteBright",
      "54,5": "whiteBright",
      "55,5": "whiteBright",
      "56,5": "whiteBright",
      "57,5": "whiteBright",
      "58,5": "whiteBright"
    },
    "bgColors": {}
  }
];

const CANVAS_WIDTH = 63;
const CANVAS_HEIGHT = 6;
const DEFAULT_LOOP = true;

export const InkBlack: React.FC<InkBlackProps> = ({
  hasDarkBackground = true,
  autoPlay = true,
  loop = DEFAULT_LOOP,
  onReady,
}) => {
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const frameElapsedRef = useRef(0);
  const lastTimestampRef = useRef(Date.now());

  // Select color theme based on background
  const theme = useMemo(() => hasDarkBackground ? THEME_DARK : THEME_LIGHT, [hasDarkBackground]);
  const getColor = useCallback((key: string): string => theme[key] || key, [theme]);
  const defaultFg = hasDarkBackground ? "white" : "black";

  const play = useCallback(() => setIsPlaying(true), []);
  const pause = useCallback(() => setIsPlaying(false), []);
  const restart = useCallback(() => {
    setFrameIndex(0);
    frameElapsedRef.current = 0;
    lastTimestampRef.current = Date.now();
    setIsPlaying(true);
  }, []);

  useEffect(() => {
    if (onReady) {
      onReady({ play, pause, restart });
    }
  }, [onReady, play, pause, restart]);

  useEffect(() => {
    if (!isPlaying || FRAMES.length <= 1) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const delta = now - lastTimestampRef.current;
      lastTimestampRef.current = now;
      frameElapsedRef.current += delta;

  const currentFrame = FRAMES[frameIndex];
      if (!currentFrame) return;

      if (frameElapsedRef.current >= currentFrame.duration) {
        frameElapsedRef.current = 0;
        const nextIndex = frameIndex + 1;
        if (nextIndex >= FRAMES.length) {
          if (loop) {
            setFrameIndex(0);
          } else {
            setIsPlaying(false);
          }
        } else {
          setFrameIndex(nextIndex);
        }
      }
    }, 16);

    return () => clearInterval(interval);
  }, [isPlaying, frameIndex, loop]);

  const frame = FRAMES[frameIndex];
  if (!frame) return null;

  return (
    <Box flexDirection="column" flexShrink={0}>
      {frame.content.map((row, y) => (
        <Box key={y} flexShrink={0}>
          {row.split("").map((char, x) => {
            const posKey = `${x},${y}`;
            const fg = frame.fgColors[posKey] ? getColor(frame.fgColors[posKey]) : defaultFg;
            const bg = frame.bgColors[posKey] ? getColor(frame.bgColors[posKey]) : undefined;
            return (
              <Text key={x} color={fg} backgroundColor={bg}>
                {char}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
};

export default InkBlack;
