import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';

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
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                 ██████╗  █████╗ ██╗  ██╗ █████╗ ██╗      ██████╗ ███╗   ██╗                                 ",
      "                                 ██╔══██╗██╔══██╗██║ ██╔╝██╔══██╗██║     ██╔═══██╗████╗  ██║                                 ",
      "                                 ██████╔╝███████║█████╔╝ ███████║██║     ██║   ██║██╔██╗ ██║                                 ",
      "                                 ██╔═══╝ ██╔══██║██╔═██╗ ██╔══██║██║     ██║   ██║██║╚██╗██║                                 ",
      "                                 ██║     ██║  ██║██║  ██╗██║  ██║███████╗╚██████╔╝██║ ╚████║                                 ",
      "                                 ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝                                 ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             ",
      "                                                                                                                             "
    ],
    "fgColors": {
      "33,10": "whiteBright",
      "34,10": "whiteBright",
      "35,10": "whiteBright",
      "36,10": "whiteBright",
      "37,10": "whiteBright",
      "38,10": "whiteBright",
      "39,10": "whiteBright",
      "42,10": "whiteBright",
      "43,10": "whiteBright",
      "44,10": "whiteBright",
      "45,10": "whiteBright",
      "46,10": "whiteBright",
      "47,10": "whiteBright",
      "49,10": "whiteBright",
      "50,10": "whiteBright",
      "51,10": "whiteBright",
      "54,10": "whiteBright",
      "55,10": "whiteBright",
      "56,10": "whiteBright",
      "58,10": "whiteBright",
      "59,10": "whiteBright",
      "60,10": "whiteBright",
      "61,10": "whiteBright",
      "62,10": "whiteBright",
      "63,10": "whiteBright",
      "65,10": "whiteBright",
      "66,10": "whiteBright",
      "67,10": "whiteBright",
      "74,10": "whiteBright",
      "75,10": "whiteBright",
      "76,10": "whiteBright",
      "77,10": "whiteBright",
      "78,10": "whiteBright",
      "79,10": "whiteBright",
      "80,10": "whiteBright",
      "82,10": "whiteBright",
      "83,10": "whiteBright",
      "84,10": "whiteBright",
      "85,10": "whiteBright",
      "89,10": "whiteBright",
      "90,10": "whiteBright",
      "91,10": "whiteBright",
      "33,11": "whiteBright",
      "34,11": "whiteBright",
      "35,11": "whiteBright",
      "36,11": "whiteBright",
      "37,11": "whiteBright",
      "38,11": "whiteBright",
      "39,11": "whiteBright",
      "40,11": "whiteBright",
      "41,11": "whiteBright",
      "42,11": "whiteBright",
      "43,11": "whiteBright",
      "44,11": "whiteBright",
      "45,11": "whiteBright",
      "46,11": "whiteBright",
      "47,11": "whiteBright",
      "48,11": "whiteBright",
      "49,11": "whiteBright",
      "50,11": "whiteBright",
      "51,11": "whiteBright",
      "53,11": "whiteBright",
      "54,11": "whiteBright",
      "55,11": "whiteBright",
      "56,11": "whiteBright",
      "57,11": "whiteBright",
      "58,11": "whiteBright",
      "59,11": "whiteBright",
      "60,11": "whiteBright",
      "61,11": "whiteBright",
      "62,11": "whiteBright",
      "63,11": "whiteBright",
      "64,11": "whiteBright",
      "65,11": "whiteBright",
      "66,11": "whiteBright",
      "67,11": "whiteBright",
      "73,11": "whiteBright",
      "74,11": "whiteBright",
      "75,11": "whiteBright",
      "76,11": "whiteBright",
      "77,11": "whiteBright",
      "78,11": "whiteBright",
      "79,11": "whiteBright",
      "80,11": "whiteBright",
      "81,11": "whiteBright",
      "82,11": "whiteBright",
      "83,11": "whiteBright",
      "84,11": "whiteBright",
      "85,11": "whiteBright",
      "86,11": "whiteBright",
      "89,11": "whiteBright",
      "90,11": "whiteBright",
      "91,11": "whiteBright",
      "33,12": "whiteBright",
      "34,12": "whiteBright",
      "35,12": "whiteBright",
      "36,12": "whiteBright",
      "37,12": "whiteBright",
      "38,12": "whiteBright",
      "39,12": "whiteBright",
      "40,12": "whiteBright",
      "41,12": "whiteBright",
      "42,12": "whiteBright",
      "43,12": "whiteBright",
      "44,12": "whiteBright",
      "45,12": "whiteBright",
      "46,12": "whiteBright",
      "47,12": "whiteBright",
      "48,12": "whiteBright",
      "49,12": "whiteBright",
      "50,12": "whiteBright",
      "51,12": "whiteBright",
      "52,12": "whiteBright",
      "53,12": "whiteBright",
      "54,12": "whiteBright",
      "55,12": "whiteBright",
      "57,12": "whiteBright",
      "58,12": "whiteBright",
      "59,12": "whiteBright",
      "60,12": "whiteBright",
      "61,12": "whiteBright",
      "62,12": "whiteBright",
      "63,12": "whiteBright",
      "64,12": "whiteBright",
      "65,12": "whiteBright",
      "66,12": "whiteBright",
      "67,12": "whiteBright",
      "73,12": "whiteBright",
      "74,12": "whiteBright",
      "75,12": "whiteBright",
      "79,12": "whiteBright",
      "80,12": "whiteBright",
      "81,12": "whiteBright",
      "82,12": "whiteBright",
      "83,12": "whiteBright",
      "84,12": "whiteBright",
      "85,12": "whiteBright",
      "86,12": "whiteBright",
      "87,12": "whiteBright",
      "89,12": "whiteBright",
      "90,12": "whiteBright",
      "91,12": "whiteBright",
      "33,13": "whiteBright",
      "34,13": "whiteBright",
      "35,13": "whiteBright",
      "36,13": "whiteBright",
      "37,13": "whiteBright",
      "38,13": "whiteBright",
      "39,13": "whiteBright",
      "41,13": "whiteBright",
      "42,13": "whiteBright",
      "43,13": "whiteBright",
      "44,13": "whiteBright",
      "45,13": "whiteBright",
      "46,13": "whiteBright",
      "47,13": "whiteBright",
      "48,13": "whiteBright",
      "49,13": "whiteBright",
      "50,13": "whiteBright",
      "51,13": "whiteBright",
      "52,13": "whiteBright",
      "53,13": "whiteBright",
      "54,13": "whiteBright",
      "55,13": "whiteBright",
      "57,13": "whiteBright",
      "58,13": "whiteBright",
      "59,13": "whiteBright",
      "60,13": "whiteBright",
      "61,13": "whiteBright",
      "62,13": "whiteBright",
      "63,13": "whiteBright",
      "64,13": "whiteBright",
      "65,13": "whiteBright",
      "66,13": "whiteBright",
      "67,13": "whiteBright",
      "73,13": "whiteBright",
      "74,13": "whiteBright",
      "75,13": "whiteBright",
      "79,13": "whiteBright",
      "80,13": "whiteBright",
      "81,13": "whiteBright",
      "82,13": "whiteBright",
      "83,13": "whiteBright",
      "84,13": "whiteBright",
      "85,13": "whiteBright",
      "86,13": "whiteBright",
      "87,13": "whiteBright",
      "88,13": "whiteBright",
      "89,13": "whiteBright",
      "90,13": "whiteBright",
      "91,13": "whiteBright",
      "33,14": "whiteBright",
      "34,14": "whiteBright",
      "35,14": "whiteBright",
      "41,14": "whiteBright",
      "42,14": "whiteBright",
      "43,14": "whiteBright",
      "46,14": "whiteBright",
      "47,14": "whiteBright",
      "48,14": "whiteBright",
      "49,14": "whiteBright",
      "50,14": "whiteBright",
      "51,14": "whiteBright",
      "54,14": "whiteBright",
      "55,14": "whiteBright",
      "56,14": "whiteBright",
      "57,14": "whiteBright",
      "58,14": "whiteBright",
      "59,14": "whiteBright",
      "62,14": "whiteBright",
      "63,14": "whiteBright",
      "64,14": "whiteBright",
      "65,14": "whiteBright",
      "66,14": "whiteBright",
      "67,14": "whiteBright",
      "68,14": "whiteBright",
      "69,14": "whiteBright",
      "70,14": "whiteBright",
      "71,14": "whiteBright",
      "72,14": "whiteBright",
      "73,14": "whiteBright",
      "74,14": "whiteBright",
      "75,14": "whiteBright",
      "76,14": "whiteBright",
      "77,14": "whiteBright",
      "78,14": "whiteBright",
      "79,14": "whiteBright",
      "80,14": "whiteBright",
      "81,14": "whiteBright",
      "82,14": "whiteBright",
      "83,14": "whiteBright",
      "84,14": "whiteBright",
      "86,14": "whiteBright",
      "87,14": "whiteBright",
      "88,14": "whiteBright",
      "89,14": "whiteBright",
      "90,14": "whiteBright",
      "91,14": "whiteBright",
      "33,15": "whiteBright",
      "34,15": "whiteBright",
      "35,15": "whiteBright",
      "41,15": "whiteBright",
      "42,15": "whiteBright",
      "43,15": "whiteBright",
      "46,15": "whiteBright",
      "47,15": "whiteBright",
      "48,15": "whiteBright",
      "49,15": "whiteBright",
      "50,15": "whiteBright",
      "51,15": "whiteBright",
      "54,15": "whiteBright",
      "55,15": "whiteBright",
      "56,15": "whiteBright",
      "57,15": "whiteBright",
      "58,15": "whiteBright",
      "59,15": "whiteBright",
      "62,15": "whiteBright",
      "63,15": "whiteBright",
      "64,15": "whiteBright",
      "65,15": "whiteBright",
      "66,15": "whiteBright",
      "67,15": "whiteBright",
      "68,15": "whiteBright",
      "69,15": "whiteBright",
      "70,15": "whiteBright",
      "71,15": "whiteBright",
      "72,15": "whiteBright",
      "74,15": "whiteBright",
      "75,15": "whiteBright",
      "76,15": "whiteBright",
      "77,15": "whiteBright",
      "78,15": "whiteBright",
      "79,15": "whiteBright",
      "80,15": "whiteBright",
      "82,15": "whiteBright",
      "83,15": "whiteBright",
      "84,15": "whiteBright",
      "87,15": "whiteBright",
      "88,15": "whiteBright",
      "89,15": "whiteBright",
      "90,15": "whiteBright",
      "91,15": "whiteBright"
    },
    "bgColors": {}
  }
];

const CANVAS_WIDTH = 125;
const CANVAS_HEIGHT = 27;
const DEFAULT_LOOP = true;

// Map chalk color name strings → actual chalk functions
const CHALK_FG: Record<string, chalk.Chalk> = {
  yellowBright: chalk.yellowBright,
  yellow: chalk.yellow,
  whiteBright: chalk.whiteBright,
  blackBright: chalk.blackBright,
  white: chalk.white,
  black: chalk.black,
};

/** Pre-compute frame rows as ANSI strings (27 strings/frame instead of 3375 Text nodes). */
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

export const TextLogoAnimation: React.FC<InkBlackProps> = ({
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
  const defaultChalkFn = hasDarkBackground ? null : chalk.black;

  // Pre-compute all frame rows as ANSI strings (27 strings/frame, not 3375 Text nodes)
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

  useEffect(() => {
    if (!isPlaying || FRAMES.length <= 1) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const delta = now - lastTimestampRef.current;
      lastTimestampRef.current = now;
      frameElapsedRef.current += delta;

      const currentFrame = FRAMES[frameIndex];
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

  // Render: 27 pre-built ANSI strings instead of 3375 individual Text nodes
  return (
    <Box flexDirection="column">
      {precomputedRows[frameIndex].map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
};

export default TextLogoAnimation;
