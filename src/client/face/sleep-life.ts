// A sleeping face that still lives. Asleep the eyes are closed, so they stay
// near centre (the studio's sleeping Zs use the room above them), but a face
// held perfectly still reads as switched off. So it breathes (a slow
// brightness swell) and now and then it twitches: a lid flicker, a tiny mouth
// shift or a quick micro-glance, settled again within a third of a second.
// Between twitches its shapes hold still. A slow, continuous drift of a few
// screen pixels is drawn on the pixel grid as edges stepping one pixel at a
// time, a different quad each frame: it read as a face shuffling by a pixel,
// all the time (live, 2026-11-10). So the motion is in the brightness, and in
// the twitches, which are over before they read as steps.

import type { FaceMotion } from '../glitch/expression-motion.js';

/** Breathing: one swell every ~4.6 s, brightness up and down by this share. */
export const SLEEP_BREATH_PERIOD_MS = 4600;
export const SLEEP_BREATH_BRIGHTNESS = 0.06;
/** The micro-glance, as a share of the waking gaze range: the furthest a sleeping face's eyes go. */
export const SLEEP_GLANCE = 0.04;
export const SLEEP_GAZE_MAX = SLEEP_GLANCE;
/** A twitch every 6 to 15 s, settled within 0.3 s. */
export const SLEEP_TWITCH_MIN_MS = 6000;
export const SLEEP_TWITCH_MAX_MS = 15_000;
export const SLEEP_TWITCH_SETTLE_MS = 300;
/** Lid flicker: the closed lids grow this much taller for an instant. */
export const SLEEP_LID_FLICKER = 0.5;
/** Mouth shift: this many face heights, sideways and down. */
export const SLEEP_MOUTH_SHIFT = 0.008;

export type SleepTwitchKind = 'lid' | 'mouth' | 'glance';

export interface SleepPose {
  /** Store gaze units (the waking range is -1..1): 0, except in a glance. */
  gazeX: number;
  gazeY: number;
  /** -1..1 over a breath. */
  breath: number;
  /** 0..1: how far into a lid flicker, mouth shift. */
  lid: number;
  mouth: number;
}

export interface SleepLife {
  /** The pose at `nowMs` (performance.now()). Twitches are scheduled as time passes. */
  sample(nowMs: number): SleepPose;
  /** The twitches so far, for tests and the log. */
  readonly twitches: ReadonlyArray<{ kind: SleepTwitchKind; at: number }>;
}

/** A twitch's strength over time: up in 60 ms, back down by SLEEP_TWITCH_SETTLE_MS. */
export function twitchEnvelope(sinceMs: number): number {
  if (sinceMs < 0) return 0;
  if (sinceMs < 60) return sinceMs / 60;
  return Math.exp(-(sinceMs - 60) / 60);
}

export function createSleepLife(random: () => number = Math.random): SleepLife {
  const twitches: Array<{ kind: SleepTwitchKind; at: number; dx: number; dy: number }> = [];
  let nextTwitchAt: number | null = null;
  const interval = () => SLEEP_TWITCH_MIN_MS + random() * (SLEEP_TWITCH_MAX_MS - SLEEP_TWITCH_MIN_MS);

  return {
    twitches,
    sample(nowMs) {
      nextTwitchAt ??= nowMs + interval();
      while (nowMs >= nextTwitchAt) {
        const roll = random();
        const kind: SleepTwitchKind = roll < 1 / 3 ? 'lid' : roll < 2 / 3 ? 'mouth' : 'glance';
        const angle = random() * Math.PI * 2;
        twitches.push({ kind, at: nextTwitchAt, dx: Math.cos(angle), dy: Math.sin(angle) });
        if (twitches.length > 32) twitches.shift();
        nextTwitchAt += interval();
      }
      const pose: SleepPose = {
        gazeX: 0,
        gazeY: 0,
        breath: Math.sin((nowMs / SLEEP_BREATH_PERIOD_MS) * Math.PI * 2),
        lid: 0,
        mouth: 0,
      };
      const last = twitches[twitches.length - 1];
      if (last) {
        const strength = twitchEnvelope(nowMs - last.at);
        if (last.kind === 'lid') pose.lid = strength;
        if (last.kind === 'mouth') pose.mouth = strength;
        if (last.kind === 'glance') {
          pose.gazeX += SLEEP_GLANCE * last.dx * strength;
          pose.gazeY += SLEEP_GLANCE * last.dy * strength;
        }
      }
      return pose;
    },
  };
}

/** One per page, shared by the gaze (face/behavior-runtime.ts) and the renderer (glitch/runtime.ts). */
export const sleepLife = createSleepLife();

/** `motion` with this pose's lid flicker and mouth shift, written into `out` (motion itself is left alone). */
export function applySleepPose(motion: FaceMotion, pose: SleepPose, out: FaceMotion): FaceMotion {
  for (const key of ['left', 'right', 'mouth'] as const) Object.assign(out[key], motion[key]);
  out.light = motion.light;
  const lid = 1 + SLEEP_LID_FLICKER * pose.lid;
  out.left.sy *= lid;
  out.right.sy *= lid;
  out.mouth.ox += SLEEP_MOUTH_SHIFT * pose.mouth;
  out.mouth.oy += SLEEP_MOUTH_SHIFT * 0.5 * pose.mouth;
  return out;
}
