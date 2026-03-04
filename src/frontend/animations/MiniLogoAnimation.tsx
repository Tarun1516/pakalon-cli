import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';

// Color themes - edit these values to customize for each background type
// THEME_DARK is used when hasDarkBackground={true} (default)
// THEME_LIGHT is used when hasDarkBackground={false}
const THEME_DARK: Record<string, string> = {
  yellowBright: 'yellowBright',
};

const THEME_LIGHT: Record<string, string> = {
  yellowBright: 'yellow',
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

type MiniLogoProps = {
  hasDarkBackground?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  onReady?: (api: PlaybackAPI) => void;
  /** Called once when a non-looping animation reaches its last frame */
  onDone?: () => void;
};

const FRAMES: FrameData[] = [
  {
    "duration": 83.33333333333333,
    "content": [
      "                                       ▓▓                                       ",
      "                             ▓▓▓       ▓▓       ▓▓▓                             ",
      "                             ▓▓▓▓      ▓▓      ▓▓▓▓                             ",
      "                              ▓▓▓▓     ▓▓     ▓▓▓▓                              ",
      "                               ▓▓▓     ▓▓     ▓▓▓                               ",
      "                      ▓▓        ▓▓▓    ▓▓    ▓▓▓        ▓▓▓                     ",
      "                      ▓▓▓▓▓      ▓▓▓   ▓▓   ▓▓▓      ▓▓▓▓▓                      ",
      "                        ▓▓▓▓▓    ▓▓▓▓  ▓▓  ▓▓▓▓    ▓▓▓▓▓                        ",
      "                          ▓▓▓▓▓   ▓▓▓ ▓▓▓▓▓▓▓▓   ▓▓▓▓▓                          ",
      "                            ▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓                            ",
      "                              ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                              ",
      "                   ▓▓▓▓▓▓▓▓      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓      ▓▓▓▓▓▓▓▓                   ",
      "                   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                   ",
      "                           ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                           ",
      "                                                                                ",
      "                    ▓               ▓▓▓▓▓▓▓▓               ▓                    ",
      "                    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                    ",
      "                     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓       ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                     ",
      "                                                                                ",
      "                                 ▓▓▓▓▓▓▓▓▓▓▓▓▓▓                                 ",
      "                           ▓▓▓▓▓▓▓▓▓▓▓     ▓▓▓▓▓▓▓▓▓▓                           ",
      "                                                                                ",
      "                                   ▓▓▓▓▓▓▓▓▓▓                                   ",
      "                                   ▓▓▓▓▓▓▓▓▓▓                                   "
    ],
    "fgColors": {
      "39,0": "yellowBright",
      "40,0": "yellowBright",
      "29,1": "yellowBright",
      "30,1": "yellowBright",
      "31,1": "yellowBright",
      "39,1": "yellowBright",
      "40,1": "yellowBright",
      "48,1": "yellowBright",
      "49,1": "yellowBright",
      "50,1": "yellowBright",
      "29,2": "yellowBright",
      "30,2": "yellowBright",
      "31,2": "yellowBright",
      "32,2": "yellowBright",
      "39,2": "yellowBright",
      "40,2": "yellowBright",
      "47,2": "yellowBright",
      "48,2": "yellowBright",
      "49,2": "yellowBright",
      "50,2": "yellowBright",
      "30,3": "yellowBright",
      "31,3": "yellowBright",
      "32,3": "yellowBright",
      "33,3": "yellowBright",
      "39,3": "yellowBright",
      "40,3": "yellowBright",
      "46,3": "yellowBright",
      "47,3": "yellowBright",
      "48,3": "yellowBright",
      "49,3": "yellowBright",
      "31,4": "yellowBright",
      "32,4": "yellowBright",
      "33,4": "yellowBright",
      "39,4": "yellowBright",
      "40,4": "yellowBright",
      "46,4": "yellowBright",
      "47,4": "yellowBright",
      "48,4": "yellowBright",
      "22,5": "yellowBright",
      "23,5": "yellowBright",
      "32,5": "yellowBright",
      "33,5": "yellowBright",
      "34,5": "yellowBright",
      "39,5": "yellowBright",
      "40,5": "yellowBright",
      "45,5": "yellowBright",
      "46,5": "yellowBright",
      "47,5": "yellowBright",
      "56,5": "yellowBright",
      "57,5": "yellowBright",
      "58,5": "yellowBright",
      "22,6": "yellowBright",
      "23,6": "yellowBright",
      "24,6": "yellowBright",
      "25,6": "yellowBright",
      "26,6": "yellowBright",
      "33,6": "yellowBright",
      "34,6": "yellowBright",
      "35,6": "yellowBright",
      "39,6": "yellowBright",
      "40,6": "yellowBright",
      "44,6": "yellowBright",
      "45,6": "yellowBright",
      "46,6": "yellowBright",
      "53,6": "yellowBright",
      "54,6": "yellowBright",
      "55,6": "yellowBright",
      "56,6": "yellowBright",
      "57,6": "yellowBright",
      "24,7": "yellowBright",
      "25,7": "yellowBright",
      "26,7": "yellowBright",
      "27,7": "yellowBright",
      "28,7": "yellowBright",
      "33,7": "yellowBright",
      "34,7": "yellowBright",
      "35,7": "yellowBright",
      "36,7": "yellowBright",
      "39,7": "yellowBright",
      "40,7": "yellowBright",
      "43,7": "yellowBright",
      "44,7": "yellowBright",
      "45,7": "yellowBright",
      "46,7": "yellowBright",
      "51,7": "yellowBright",
      "52,7": "yellowBright",
      "53,7": "yellowBright",
      "54,7": "yellowBright",
      "55,7": "yellowBright",
      "26,8": "yellowBright",
      "27,8": "yellowBright",
      "28,8": "yellowBright",
      "29,8": "yellowBright",
      "30,8": "yellowBright",
      "34,8": "yellowBright",
      "35,8": "yellowBright",
      "36,8": "yellowBright",
      "38,8": "yellowBright",
      "39,8": "yellowBright",
      "40,8": "yellowBright",
      "41,8": "yellowBright",
      "42,8": "yellowBright",
      "43,8": "yellowBright",
      "44,8": "yellowBright",
      "45,8": "yellowBright",
      "49,8": "yellowBright",
      "50,8": "yellowBright",
      "51,8": "yellowBright",
      "52,8": "yellowBright",
      "53,8": "yellowBright",
      "28,9": "yellowBright",
      "29,9": "yellowBright",
      "30,9": "yellowBright",
      "31,9": "yellowBright",
      "32,9": "yellowBright",
      "35,9": "yellowBright",
      "36,9": "yellowBright",
      "37,9": "yellowBright",
      "38,9": "yellowBright",
      "39,9": "yellowBright",
      "40,9": "yellowBright",
      "41,9": "yellowBright",
      "42,9": "yellowBright",
      "43,9": "yellowBright",
      "44,9": "yellowBright",
      "47,9": "yellowBright",
      "48,9": "yellowBright",
      "49,9": "yellowBright",
      "50,9": "yellowBright",
      "51,9": "yellowBright",
      "30,10": "yellowBright",
      "31,10": "yellowBright",
      "32,10": "yellowBright",
      "33,10": "yellowBright",
      "34,10": "yellowBright",
      "35,10": "yellowBright",
      "36,10": "yellowBright",
      "37,10": "yellowBright",
      "38,10": "yellowBright",
      "39,10": "yellowBright",
      "40,10": "yellowBright",
      "41,10": "yellowBright",
      "42,10": "yellowBright",
      "43,10": "yellowBright",
      "44,10": "yellowBright",
      "45,10": "yellowBright",
      "46,10": "yellowBright",
      "47,10": "yellowBright",
      "48,10": "yellowBright",
      "49,10": "yellowBright",
      "19,11": "yellowBright",
      "20,11": "yellowBright",
      "21,11": "yellowBright",
      "22,11": "yellowBright",
      "23,11": "yellowBright",
      "24,11": "yellowBright",
      "25,11": "yellowBright",
      "26,11": "yellowBright",
      "33,11": "yellowBright",
      "34,11": "yellowBright",
      "35,11": "yellowBright",
      "36,11": "yellowBright",
      "37,11": "yellowBright",
      "38,11": "yellowBright",
      "39,11": "yellowBright",
      "40,11": "yellowBright",
      "41,11": "yellowBright",
      "42,11": "yellowBright",
      "43,11": "yellowBright",
      "44,11": "yellowBright",
      "45,11": "yellowBright",
      "46,11": "yellowBright",
      "53,11": "yellowBright",
      "54,11": "yellowBright",
      "55,11": "yellowBright",
      "56,11": "yellowBright",
      "57,11": "yellowBright",
      "58,11": "yellowBright",
      "59,11": "yellowBright",
      "60,11": "yellowBright",
      "19,12": "yellowBright",
      "20,12": "yellowBright",
      "21,12": "yellowBright",
      "22,12": "yellowBright",
      "23,12": "yellowBright",
      "24,12": "yellowBright",
      "25,12": "yellowBright",
      "26,12": "yellowBright",
      "27,12": "yellowBright",
      "28,12": "yellowBright",
      "29,12": "yellowBright",
      "30,12": "yellowBright",
      "31,12": "yellowBright",
      "32,12": "yellowBright",
      "33,12": "yellowBright",
      "34,12": "yellowBright",
      "35,12": "yellowBright",
      "36,12": "yellowBright",
      "37,12": "yellowBright",
      "38,12": "yellowBright",
      "39,12": "yellowBright",
      "40,12": "yellowBright",
      "41,12": "yellowBright",
      "42,12": "yellowBright",
      "43,12": "yellowBright",
      "44,12": "yellowBright",
      "45,12": "yellowBright",
      "46,12": "yellowBright",
      "47,12": "yellowBright",
      "48,12": "yellowBright",
      "49,12": "yellowBright",
      "50,12": "yellowBright",
      "51,12": "yellowBright",
      "52,12": "yellowBright",
      "53,12": "yellowBright",
      "54,12": "yellowBright",
      "55,12": "yellowBright",
      "56,12": "yellowBright",
      "57,12": "yellowBright",
      "58,12": "yellowBright",
      "59,12": "yellowBright",
      "60,12": "yellowBright",
      "27,13": "yellowBright",
      "28,13": "yellowBright",
      "29,13": "yellowBright",
      "30,13": "yellowBright",
      "31,13": "yellowBright",
      "32,13": "yellowBright",
      "33,13": "yellowBright",
      "34,13": "yellowBright",
      "35,13": "yellowBright",
      "36,13": "yellowBright",
      "37,13": "yellowBright",
      "38,13": "yellowBright",
      "39,13": "yellowBright",
      "40,13": "yellowBright",
      "41,13": "yellowBright",
      "42,13": "yellowBright",
      "43,13": "yellowBright",
      "44,13": "yellowBright",
      "45,13": "yellowBright",
      "46,13": "yellowBright",
      "47,13": "yellowBright",
      "48,13": "yellowBright",
      "49,13": "yellowBright",
      "50,13": "yellowBright",
      "51,13": "yellowBright",
      "52,13": "yellowBright",
      "20,15": "yellowBright",
      "36,15": "yellowBright",
      "37,15": "yellowBright",
      "38,15": "yellowBright",
      "39,15": "yellowBright",
      "40,15": "yellowBright",
      "41,15": "yellowBright",
      "42,15": "yellowBright",
      "43,15": "yellowBright",
      "59,15": "yellowBright",
      "20,16": "yellowBright",
      "21,16": "yellowBright",
      "22,16": "yellowBright",
      "23,16": "yellowBright",
      "24,16": "yellowBright",
      "25,16": "yellowBright",
      "26,16": "yellowBright",
      "27,16": "yellowBright",
      "28,16": "yellowBright",
      "29,16": "yellowBright",
      "30,16": "yellowBright",
      "31,16": "yellowBright",
      "32,16": "yellowBright",
      "33,16": "yellowBright",
      "34,16": "yellowBright",
      "35,16": "yellowBright",
      "36,16": "yellowBright",
      "37,16": "yellowBright",
      "38,16": "yellowBright",
      "39,16": "yellowBright",
      "40,16": "yellowBright",
      "41,16": "yellowBright",
      "42,16": "yellowBright",
      "43,16": "yellowBright",
      "44,16": "yellowBright",
      "45,16": "yellowBright",
      "46,16": "yellowBright",
      "47,16": "yellowBright",
      "48,16": "yellowBright",
      "49,16": "yellowBright",
      "50,16": "yellowBright",
      "51,16": "yellowBright",
      "52,16": "yellowBright",
      "53,16": "yellowBright",
      "54,16": "yellowBright",
      "55,16": "yellowBright",
      "56,16": "yellowBright",
      "57,16": "yellowBright",
      "58,16": "yellowBright",
      "59,16": "yellowBright",
      "21,17": "yellowBright",
      "22,17": "yellowBright",
      "23,17": "yellowBright",
      "24,17": "yellowBright",
      "25,17": "yellowBright",
      "26,17": "yellowBright",
      "27,17": "yellowBright",
      "28,17": "yellowBright",
      "29,17": "yellowBright",
      "30,17": "yellowBright",
      "31,17": "yellowBright",
      "32,17": "yellowBright",
      "33,17": "yellowBright",
      "34,17": "yellowBright",
      "35,17": "yellowBright",
      "43,17": "yellowBright",
      "44,17": "yellowBright",
      "45,17": "yellowBright",
      "46,17": "yellowBright",
      "47,17": "yellowBright",
      "48,17": "yellowBright",
      "49,17": "yellowBright",
      "50,17": "yellowBright",
      "51,17": "yellowBright",
      "52,17": "yellowBright",
      "53,17": "yellowBright",
      "54,17": "yellowBright",
      "55,17": "yellowBright",
      "56,17": "yellowBright",
      "57,17": "yellowBright",
      "58,17": "yellowBright",
      "33,19": "yellowBright",
      "34,19": "yellowBright",
      "35,19": "yellowBright",
      "36,19": "yellowBright",
      "37,19": "yellowBright",
      "38,19": "yellowBright",
      "39,19": "yellowBright",
      "40,19": "yellowBright",
      "41,19": "yellowBright",
      "42,19": "yellowBright",
      "43,19": "yellowBright",
      "44,19": "yellowBright",
      "45,19": "yellowBright",
      "46,19": "yellowBright",
      "27,20": "yellowBright",
      "28,20": "yellowBright",
      "29,20": "yellowBright",
      "30,20": "yellowBright",
      "31,20": "yellowBright",
      "32,20": "yellowBright",
      "33,20": "yellowBright",
      "34,20": "yellowBright",
      "35,20": "yellowBright",
      "36,20": "yellowBright",
      "37,20": "yellowBright",
      "43,20": "yellowBright",
      "44,20": "yellowBright",
      "45,20": "yellowBright",
      "46,20": "yellowBright",
      "47,20": "yellowBright",
      "48,20": "yellowBright",
      "49,20": "yellowBright",
      "50,20": "yellowBright",
      "51,20": "yellowBright",
      "52,20": "yellowBright",
      "35,22": "yellowBright",
      "36,22": "yellowBright",
      "37,22": "yellowBright",
      "38,22": "yellowBright",
      "39,22": "yellowBright",
      "40,22": "yellowBright",
      "41,22": "yellowBright",
      "42,22": "yellowBright",
      "43,22": "yellowBright",
      "44,22": "yellowBright",
      "35,23": "yellowBright",
      "36,23": "yellowBright",
      "37,23": "yellowBright",
      "38,23": "yellowBright",
      "39,23": "yellowBright",
      "40,23": "yellowBright",
      "41,23": "yellowBright",
      "42,23": "yellowBright",
      "43,23": "yellowBright",
      "44,23": "yellowBright"
    },
    "bgColors": {}
  }
];

const CANVAS_WIDTH = 80;
const CANVAS_HEIGHT = 24;
const DEFAULT_LOOP = true;

/**
 * Playback speed multiplier. 0.5 = half speed (each frame lasts twice as long).
 * Increase to speed up (e.g. 2 = double speed), decrease to slow down.
 */
export const SPEED_MULTIPLIER = 0.5;
/** Base duration per frame in ms (as authored in FRAMES[].duration). */
export const FRAME_DURATION_BASE_MS = 83.33;

// Map chalk color name strings → actual chalk functions
const CHALK_FG: Record<string, chalk.Chalk> = {
  yellowBright: chalk.yellowBright,
  yellow: chalk.yellow,
  whiteBright: chalk.whiteBright,
  blackBright: chalk.blackBright,
  white: chalk.white,
  black: chalk.black,
  cyan: chalk.cyan,
  cyanBright: chalk.cyanBright,
  green: chalk.green,
  greenBright: chalk.greenBright,
  red: chalk.red,
  blue: chalk.blue,
};

/**
 * Pre-compute each frame's rows as ANSI-colored strings.
 * Returns string[frames][rows] — only 24 strings per frame instead of 1920 React elements.
 */
function buildFrameRows(
  frames: FrameData[],
  theme: Record<string, string>,
  defaultChalkFn: chalk.Chalk | null,
): string[][] {
  return frames.map((frame) =>
    frame.content.map((row, y) => {
      let result = '';
      let buffer = '';
      let currentKey = '';

      const flush = (nextKey: string) => {
        if (buffer) {
          const themeMapped = currentKey ? (theme[currentKey] ?? currentKey) : '';
          const chalkFn = themeMapped ? (CHALK_FG[themeMapped] ?? null) : defaultChalkFn;
          result += chalkFn ? chalkFn(buffer) : buffer;
          buffer = '';
        }
        currentKey = nextKey;
      };

      for (let x = 0; x < row.length; x++) {
        const posKey = `${x},${y}`;
        const colorName = frame.fgColors[posKey] ?? '';
        if (colorName !== currentKey) flush(colorName);
        buffer += row[x];
      }
      flush('');
      return result;
    })
  );
}

export const MiniLogoAnimation: React.FC<MiniLogoProps> = ({
  hasDarkBackground = true,
  autoPlay = true,
  loop = DEFAULT_LOOP,
  onReady,
  onDone,
}) => {
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const frameElapsedRef = useRef(0);
  const lastTimestampRef = useRef(Date.now());
  const isPlayingRef = useRef(autoPlay);

  // Select color theme based on background
  const theme = useMemo(() => hasDarkBackground ? THEME_DARK : THEME_LIGHT, [hasDarkBackground]);
  const defaultChalkFn = hasDarkBackground ? null : chalk.black; // null = terminal default (white on dark)

  // Pre-compute all frame rows as ANSI strings (24 strings/frame, not 1920 Text nodes)
  const precomputedRows = useMemo(
    () => buildFrameRows(FRAMES, theme, defaultChalkFn),
    [theme, defaultChalkFn]
  );

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

  // Fire onDone when a non-looping animation reaches its end
  useEffect(() => {
    if (!isPlaying && isPlayingRef.current && !loop) {
      onDone?.();
    }
    isPlayingRef.current = isPlaying;
  }, [isPlaying, loop, onDone]);

  useEffect(() => {
    if (!isPlaying || FRAMES.length <= 1) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const delta = now - lastTimestampRef.current;
      lastTimestampRef.current = now;
      frameElapsedRef.current += delta;

      const currentFrame = FRAMES[frameIndex];
      // Apply SPEED_MULTIPLIER: 0.5 → each frame lasts 2× longer
      if (frameElapsedRef.current >= currentFrame.duration / SPEED_MULTIPLIER) {
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

  // Render: 24 pre-built ANSI strings instead of 1920 individual Text nodes
  return (
    <Box flexDirection="column">
      {precomputedRows[frameIndex].map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
};

export default MiniLogoAnimation;
