import {
  PAKALON_GOLD,
  PAKALON_GOLD_BRIGHT,
  STATUS_ERROR,
  STATUS_INFO,
  STATUS_SUCCESS,
} from "@/constants/colors.js";

/**
 * Pakalon CLI Theme Constants
 *
 * Design system based on Figma design:
 * - Primary accent: Golden/Amber (#E8AA41)
 * - Background: Black (#000000)
 * - Text: White on black
 */

// Primary accent color - used for borders, highlights, and key UI elements
export const PAKALON_ACCENT = PAKALON_GOLD;

// Secondary accent for hover/active states (slightly brighter)
export const PAKALON_ACCENT_BRIGHT = PAKALON_GOLD_BRIGHT;

// Orange fallback for compatibility
export const PAKALON_ORANGE = PAKALON_GOLD;

// Status colors
export const STATUS_COLORS = {
  success: STATUS_SUCCESS,
  warning: PAKALON_ACCENT,
  error: STATUS_ERROR,
  info: STATUS_INFO,
} as const;

// Mode colors for permission modes
export const MODE_COLORS = {
  plan: PAKALON_ACCENT,
  "auto-accept": PAKALON_ACCENT,
  orchestration: "#FBBF24",
  normal: "white",
} as const;

// Context bar colors based on usage percentage
export function getContextBarColor(usedPct: number): string {
  if (usedPct >= 80) return STATUS_COLORS.error;
  if (usedPct >= 60) return STATUS_COLORS.warning;
  return PAKALON_ACCENT;
}

// Border style for main containers
export const BORDER_STYLE = {
  color: PAKALON_ACCENT,
  style: "single" as const,
};
