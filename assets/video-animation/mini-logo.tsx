import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

// Color themes - edit these values to customize for each background type
// COLORS_DARK is used when hasDarkBackground={true} (default)
// COLORS_LIGHT is used when hasDarkBackground={false}
const COLORS_DARK: Record<string, string> = {
  c0: '#faa307',
};

const COLORS_LIGHT: Record<string, string> = {
  c0: '#4b3102',
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
      "39,0": "c0",
      "40,0": "c0",
      "29,1": "c0",
      "30,1": "c0",
      "31,1": "c0",
      "39,1": "c0",
      "40,1": "c0",
      "48,1": "c0",
      "49,1": "c0",
      "50,1": "c0",
      "29,2": "c0",
      "30,2": "c0",
      "31,2": "c0",
      "32,2": "c0",
      "39,2": "c0",
      "40,2": "c0",
      "47,2": "c0",
      "48,2": "c0",
      "49,2": "c0",
      "50,2": "c0",
      "30,3": "c0",
      "31,3": "c0",
      "32,3": "c0",
      "33,3": "c0",
      "39,3": "c0",
      "40,3": "c0",
      "46,3": "c0",
      "47,3": "c0",
      "48,3": "c0",
      "49,3": "c0",
      "31,4": "c0",
      "32,4": "c0",
      "33,4": "c0",
      "39,4": "c0",
      "40,4": "c0",
      "46,4": "c0",
      "47,4": "c0",
      "48,4": "c0",
      "22,5": "c0",
      "23,5": "c0",
      "32,5": "c0",
      "33,5": "c0",
      "34,5": "c0",
      "39,5": "c0",
      "40,5": "c0",
      "45,5": "c0",
      "46,5": "c0",
      "47,5": "c0",
      "56,5": "c0",
      "57,5": "c0",
      "58,5": "c0",
      "22,6": "c0",
      "23,6": "c0",
      "24,6": "c0",
      "25,6": "c0",
      "26,6": "c0",
      "33,6": "c0",
      "34,6": "c0",
      "35,6": "c0",
      "39,6": "c0",
      "40,6": "c0",
      "44,6": "c0",
      "45,6": "c0",
      "46,6": "c0",
      "53,6": "c0",
      "54,6": "c0",
      "55,6": "c0",
      "56,6": "c0",
      "57,6": "c0",
      "24,7": "c0",
      "25,7": "c0",
      "26,7": "c0",
      "27,7": "c0",
      "28,7": "c0",
      "33,7": "c0",
      "34,7": "c0",
      "35,7": "c0",
      "36,7": "c0",
      "39,7": "c0",
      "40,7": "c0",
      "43,7": "c0",
      "44,7": "c0",
      "45,7": "c0",
      "46,7": "c0",
      "51,7": "c0",
      "52,7": "c0",
      "53,7": "c0",
      "54,7": "c0",
      "55,7": "c0",
      "26,8": "c0",
      "27,8": "c0",
      "28,8": "c0",
      "29,8": "c0",
      "30,8": "c0",
      "34,8": "c0",
      "35,8": "c0",
      "36,8": "c0",
      "38,8": "c0",
      "39,8": "c0",
      "40,8": "c0",
      "41,8": "c0",
      "42,8": "c0",
      "43,8": "c0",
      "44,8": "c0",
      "45,8": "c0",
      "49,8": "c0",
      "50,8": "c0",
      "51,8": "c0",
      "52,8": "c0",
      "53,8": "c0",
      "28,9": "c0",
      "29,9": "c0",
      "30,9": "c0",
      "31,9": "c0",
      "32,9": "c0",
      "35,9": "c0",
      "36,9": "c0",
      "37,9": "c0",
      "38,9": "c0",
      "39,9": "c0",
      "40,9": "c0",
      "41,9": "c0",
      "42,9": "c0",
      "43,9": "c0",
      "44,9": "c0",
      "47,9": "c0",
      "48,9": "c0",
      "49,9": "c0",
      "50,9": "c0",
      "51,9": "c0",
      "30,10": "c0",
      "31,10": "c0",
      "32,10": "c0",
      "33,10": "c0",
      "34,10": "c0",
      "35,10": "c0",
      "36,10": "c0",
      "37,10": "c0",
      "38,10": "c0",
      "39,10": "c0",
      "40,10": "c0",
      "41,10": "c0",
      "42,10": "c0",
      "43,10": "c0",
      "44,10": "c0",
      "45,10": "c0",
      "46,10": "c0",
      "47,10": "c0",
      "48,10": "c0",
      "49,10": "c0",
      "19,11": "c0",
      "20,11": "c0",
      "21,11": "c0",
      "22,11": "c0",
      "23,11": "c0",
      "24,11": "c0",
      "25,11": "c0",
      "26,11": "c0",
      "33,11": "c0",
      "34,11": "c0",
      "35,11": "c0",
      "36,11": "c0",
      "37,11": "c0",
      "38,11": "c0",
      "39,11": "c0",
      "40,11": "c0",
      "41,11": "c0",
      "42,11": "c0",
      "43,11": "c0",
      "44,11": "c0",
      "45,11": "c0",
      "46,11": "c0",
      "53,11": "c0",
      "54,11": "c0",
      "55,11": "c0",
      "56,11": "c0",
      "57,11": "c0",
      "58,11": "c0",
      "59,11": "c0",
      "60,11": "c0",
      "19,12": "c0",
      "20,12": "c0",
      "21,12": "c0",
      "22,12": "c0",
      "23,12": "c0",
      "24,12": "c0",
      "25,12": "c0",
      "26,12": "c0",
      "27,12": "c0",
      "28,12": "c0",
      "29,12": "c0",
      "30,12": "c0",
      "31,12": "c0",
      "32,12": "c0",
      "33,12": "c0",
      "34,12": "c0",
      "35,12": "c0",
      "36,12": "c0",
      "37,12": "c0",
      "38,12": "c0",
      "39,12": "c0",
      "40,12": "c0",
      "41,12": "c0",
      "42,12": "c0",
      "43,12": "c0",
      "44,12": "c0",
      "45,12": "c0",
      "46,12": "c0",
      "47,12": "c0",
      "48,12": "c0",
      "49,12": "c0",
      "50,12": "c0",
      "51,12": "c0",
      "52,12": "c0",
      "53,12": "c0",
      "54,12": "c0",
      "55,12": "c0",
      "56,12": "c0",
      "57,12": "c0",
      "58,12": "c0",
      "59,12": "c0",
      "60,12": "c0",
      "27,13": "c0",
      "28,13": "c0",
      "29,13": "c0",
      "30,13": "c0",
      "31,13": "c0",
      "32,13": "c0",
      "33,13": "c0",
      "34,13": "c0",
      "35,13": "c0",
      "36,13": "c0",
      "37,13": "c0",
      "38,13": "c0",
      "39,13": "c0",
      "40,13": "c0",
      "41,13": "c0",
      "42,13": "c0",
      "43,13": "c0",
      "44,13": "c0",
      "45,13": "c0",
      "46,13": "c0",
      "47,13": "c0",
      "48,13": "c0",
      "49,13": "c0",
      "50,13": "c0",
      "51,13": "c0",
      "52,13": "c0",
      "20,15": "c0",
      "36,15": "c0",
      "37,15": "c0",
      "38,15": "c0",
      "39,15": "c0",
      "40,15": "c0",
      "41,15": "c0",
      "42,15": "c0",
      "43,15": "c0",
      "59,15": "c0",
      "20,16": "c0",
      "21,16": "c0",
      "22,16": "c0",
      "23,16": "c0",
      "24,16": "c0",
      "25,16": "c0",
      "26,16": "c0",
      "27,16": "c0",
      "28,16": "c0",
      "29,16": "c0",
      "30,16": "c0",
      "31,16": "c0",
      "32,16": "c0",
      "33,16": "c0",
      "34,16": "c0",
      "35,16": "c0",
      "36,16": "c0",
      "37,16": "c0",
      "38,16": "c0",
      "39,16": "c0",
      "40,16": "c0",
      "41,16": "c0",
      "42,16": "c0",
      "43,16": "c0",
      "44,16": "c0",
      "45,16": "c0",
      "46,16": "c0",
      "47,16": "c0",
      "48,16": "c0",
      "49,16": "c0",
      "50,16": "c0",
      "51,16": "c0",
      "52,16": "c0",
      "53,16": "c0",
      "54,16": "c0",
      "55,16": "c0",
      "56,16": "c0",
      "57,16": "c0",
      "58,16": "c0",
      "59,16": "c0",
      "21,17": "c0",
      "22,17": "c0",
      "23,17": "c0",
      "24,17": "c0",
      "25,17": "c0",
      "26,17": "c0",
      "27,17": "c0",
      "28,17": "c0",
      "29,17": "c0",
      "30,17": "c0",
      "31,17": "c0",
      "32,17": "c0",
      "33,17": "c0",
      "34,17": "c0",
      "35,17": "c0",
      "43,17": "c0",
      "44,17": "c0",
      "45,17": "c0",
      "46,17": "c0",
      "47,17": "c0",
      "48,17": "c0",
      "49,17": "c0",
      "50,17": "c0",
      "51,17": "c0",
      "52,17": "c0",
      "53,17": "c0",
      "54,17": "c0",
      "55,17": "c0",
      "56,17": "c0",
      "57,17": "c0",
      "58,17": "c0",
      "33,19": "c0",
      "34,19": "c0",
      "35,19": "c0",
      "36,19": "c0",
      "37,19": "c0",
      "38,19": "c0",
      "39,19": "c0",
      "40,19": "c0",
      "41,19": "c0",
      "42,19": "c0",
      "43,19": "c0",
      "44,19": "c0",
      "45,19": "c0",
      "46,19": "c0",
      "27,20": "c0",
      "28,20": "c0",
      "29,20": "c0",
      "30,20": "c0",
      "31,20": "c0",
      "32,20": "c0",
      "33,20": "c0",
      "34,20": "c0",
      "35,20": "c0",
      "36,20": "c0",
      "37,20": "c0",
      "43,20": "c0",
      "44,20": "c0",
      "45,20": "c0",
      "46,20": "c0",
      "47,20": "c0",
      "48,20": "c0",
      "49,20": "c0",
      "50,20": "c0",
      "51,20": "c0",
      "52,20": "c0",
      "35,22": "c0",
      "36,22": "c0",
      "37,22": "c0",
      "38,22": "c0",
      "39,22": "c0",
      "40,22": "c0",
      "41,22": "c0",
      "42,22": "c0",
      "43,22": "c0",
      "44,22": "c0",
      "35,23": "c0",
      "36,23": "c0",
      "37,23": "c0",
      "38,23": "c0",
      "39,23": "c0",
      "40,23": "c0",
      "41,23": "c0",
      "42,23": "c0",
      "43,23": "c0",
      "44,23": "c0"
    },
    "bgColors": {}
  }
];

const CANVAS_WIDTH = 80;
const CANVAS_HEIGHT = 24;
const DEFAULT_LOOP = true;

export const MiniLogo: React.FC<MiniLogoProps> = ({
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
  const colors = useMemo(() => hasDarkBackground ? COLORS_DARK : COLORS_LIGHT, [hasDarkBackground]);
  const getColor = useCallback((key: string): string => colors[key] || key, [colors]);
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

  return (
    <box flexDirection="column">
      {frame.content.map((row, y) => (
        <text key={y}>
          {row.split("").map((char, x) => {
            const posKey = `${x},${y}`;
            const fg = frame.fgColors[posKey] ? getColor(frame.fgColors[posKey]) : defaultFg;
            const bg = frame.bgColors[posKey] ? getColor(frame.bgColors[posKey]) : undefined;
            return (
              <span key={x} fg={fg} bg={bg}>
                {char}
              </span>
            );
          })}
        </text>
      ))}
    </box>
  );
};

export default MiniLogo;
