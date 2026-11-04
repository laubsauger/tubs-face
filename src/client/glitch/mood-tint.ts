/**
 * How the face's colour and glitch follow Tubs's mood, so the room can read
 * it from across the studio: irritated drifts toward red and glitches more,
 * sulking goes cooler and washed out, delighted goes warmer and brighter.
 * Neutral and smug leave the operator's base colour alone. Offsets are capped
 * so the face stays recognisably itself.
 */

export interface MoodTint {
  /** Degrees added to the base hue. */
  hueShift: number;
  /** Multiplier for saturation. */
  saturation: number;
  /** Points added to lightness (0-100 scale). */
  lightness: number;
  /** Multiplier for the time between glitch bursts (smaller: more bursts). */
  burstInterval: number;
  /** Multiplier for the chromatic colour split. */
  chroma: number;
}

export const NEUTRAL_TINT: MoodTint = { hueShift: 0, saturation: 1, lightness: 0, burstInterval: 1, chroma: 1 };

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function moodTint(mood: { pos: number; neg: number; arousal: number }): MoodTint {
  // Mood rests around pos 0.24 / neg 0.06 / arousal 0.2; only real feeling moves the face.
  const upset = clamp01((mood.neg - 0.12) * 3);
  const anger = upset * clamp01((mood.arousal - 0.2) * 2.5);
  const sadness = upset * (1 - anger);
  const joy = clamp01((mood.pos - 0.36) * 3) * clamp01((mood.arousal - 0.2) * 2.5) * (1 - upset);
  return {
    hueShift: 70 * anger - 35 * sadness + 25 * joy,
    saturation: 1 + 0.15 * anger - 0.45 * sadness,
    lightness: 6 * joy - 6 * sadness,
    burstInterval: 1 - 0.6 * anger,
    chroma: 1 + 1.5 * anger,
  };
}
