import type { ExpressionProfileMap, PropId } from '../../shared/contracts/config.js';
import { DEFAULT_EXPRESSION_PROFILES } from '../../shared/contracts/config.js';

export interface GlitchConfig {
  svg: {
    viewBox: { w: number; h: number };
    shapes: Array<{ x: number; y: number; w: number; h: number; rx: number; ry: number }>;
  };
  pixel: { size: number; gap: number; edgeSoftness: number; borderRadius: number };
  color: { base: `#${string}`; hueVariation: number; brightnessVariation: number; opacityMin: number };
  glow: { pixelGlow: number; outerBloom: number; bloomIntensity: number; color: `#${string}`; falloffCurve: number };
  brightnessPulse: { enabled: boolean; dim: number; bright: number; speed: number };
  scanBeam: { enabled: boolean; speed: number; lineWidth: number; brightness: number; glowStrength: number; jitter: number; color: `#${string}` };
  chromatic: { enabled: boolean; offsetX: number; offsetY: number; intensity: number; animate: boolean; animateSpeed: number };
  glitchSlice: {
    enabled: boolean;
    sliceCount: number;
    maxOffset: number;
    speed: number;
    intensity: number;
    colorShift: number;
    gapChance: number;
    interval: number;
    burstDuration: number;
  };
  glitch: {
    scanlines: boolean;
    scanlineIntensity: number;
    scanlineSpacing: number;
    scanlineThickness: number;
    scanlineMove: boolean;
    scanlineSpeed: number;
    pixelJitter: number;
    flicker: boolean;
    flickerSpeed: number;
    flickerDepth: number;
  };
  /** What the head wears (props.ts). */
  prop: PropId;
}

export const DEFAULT_CONFIG: GlitchConfig = {
  svg: {
    viewBox: { w: 52.82, h: 27.45 },
    shapes: [
      { x: 0, y: 0, w: 14.59, h: 22.47, rx: 5.94, ry: 5.94 },
      { x: 40.85, y: 0, w: 14.59, h: 22.47, rx: 5.94, ry: 5.94 },
      { x: 20.53, y: 23.86, w: 14.38, h: 6.44, rx: 1.95, ry: 1.95 },
    ],
  },
  pixel: { size: 21, gap: 7, edgeSoftness: 0, borderRadius: 0 },
  color: { base: '#a855f7', hueVariation: 8, brightnessVariation: 8, opacityMin: 0.5 },
  glow: { pixelGlow: 14, outerBloom: 0, bloomIntensity: 1, color: '#5900ff', falloffCurve: 2.8 },
  brightnessPulse: { enabled: true, dim: 0.88, bright: 1, speed: 3 },
  scanBeam: { enabled: true, speed: 10, lineWidth: 7, brightness: 0.65, glowStrength: 26, jitter: 1, color: '#a600ff' },
  chromatic: { enabled: true, offsetX: 0, offsetY: 4.5, intensity: 0.65, animate: true, animateSpeed: 7 },
  glitchSlice: {
    enabled: true, sliceCount: 24, maxOffset: 5, speed: 28,
    intensity: 0.53, colorShift: 0.03, gapChance: 0.07,
    interval: 18000, burstDuration: 1800,
  },
  glitch: {
    scanlines: true, scanlineIntensity: 0.41, scanlineSpacing: 5,
    scanlineThickness: 3, scanlineMove: true, scanlineSpeed: 3,
    pixelJitter: 0, flicker: true, flickerSpeed: 11, flickerDepth: 0.02,
  },
  prop: 'none',
};

export let EXPRESSION_PROFILES: ExpressionProfileMap = structuredClone(DEFAULT_EXPRESSION_PROFILES);

export function setExpressionProfiles(profiles: ExpressionProfileMap): void {
  EXPRESSION_PROFILES = profiles;
}

export const BLINK_CLOSE_MS = 80;
export const BLINK_HOLD_MS = 60;
export const BLINK_OPEN_MS = 80;

/**
 * Expression changes morph the pixels from the old shape to the new one.
 * Each pixel starts within the stagger and travels for duration - stagger.
 */
export const MORPH = {
  durationMs: 280,
  staggerMs: 70,
} as const;
/** Falling asleep is slow and heavy; waking is quicker, but not a snap. */
export const MORPH_SLEEP = {
  durationMs: 720,
  staggerMs: 160,
} as const;
export const MORPH_WAKE = {
  durationMs: 420,
  staggerMs: 90,
} as const;

/**
 * Living expressions: small motion on top of each expression's shape, applied
 * per eye and mouth in the shader. Scales are fractions (0.02 = 2%), offsets
 * fractions of the face height. Subtle on purpose: a character, not a cartoon.
 */
export const MOTION = {
  /** Idle and listening breathe: the face brightens and dims a little, slowly (its shapes hold still). */
  breathLight: 0.05,
  breathPeriodMs: 4200,
  /** Surprised pops in: swells past its size, then settles. */
  popAmount: 0.1,
  popPeriodMs: 360,
  popDecayMs: 160,
  /** Happy and smile give a little hop when they appear. */
  bounceHeight: 0.018,
  bouncePeriodMs: 230,
  bounceDecayMs: 230,
  /** Angry trembles by about a pixel. */
  trembleAmount: 0.0016,
  /** Sad sinks and the lids droop, slowly. */
  sadSink: 0.022,
  sadDroop: 0.08,
  sadSettleMs: 1600,
  /** Thinking: one eye squints a little, the other opens. */
  thinkSquint: 0.14,
  thinkWiden: 0.03,
  /** Smug: one upper lid a little lower. */
  smugLid: 0.22,
  /** Looking sideways turns the head: the near eye grows, the far eye narrows, and the face travels a bit further. */
  headTurnNearGrow: 0.05,
  headTurnFarNarrow: 0.14,
  headTurnShift: 0.03,
  /** How fast a held pose (sink, lid, squint) settles after a change. */
  poseSettleMs: 220,
  /** How fast loops (breath, tremble, drift) fade in and out. */
  loopFadeMs: 400,
} as const;

export const SPEAK_CYCLE_MS = 320;
// Talking, the mouth goes from nearly shut to wide open; with 0.75..1.05 it
// read as a static mouth.
export const SPEAK_MIN_SCALE = 0.2;
export const SPEAK_MAX_SCALE = 1.5;

export const GAZE_EYE_RANGE_X = 0.14;
export const GAZE_EYE_RANGE_Y = 0.09;
export const GAZE_MOUTH_RANGE_X = 0.06;
export const GAZE_MOUTH_RANGE_Y = 0.04;

export const GLOW_ALPHA = 0.65;
/**
 * The face canvas fills the whole screen, so the eyes and mouth are fitted
 * into this centred share of it. Leaves room for the subtitle above and the
 * listening indicator below at any aspect ratio.
 */
export const FACE_SAFE_AREA_X = 0.86;
export const FACE_SAFE_AREA_Y = 0.74;
export const FEATURE_BOX_GLOBAL_SCALE_X = 0.84;
export const FEATURE_BOX_GLOBAL_SCALE_Y = 0.88;
export const FEATURE_MOUTH_SCALE_X = 0.88;
export const FEATURE_MOUTH_SCALE_Y = 0.88;

// 12 shared vec4s, the eyes' and mouth's transforms, and a worn prop's three.
export const GPU_UNIFORM_FLOATS = 72;
