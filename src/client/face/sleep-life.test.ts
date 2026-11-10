import { describe, expect, it } from 'vitest';
import { createFaceMotion } from '../glitch/expression-motion.js';
import {
  SLEEP_BREATH_PERIOD_MS,
  SLEEP_GAZE_MAX,
  SLEEP_GLANCE,
  SLEEP_TWITCH_MAX_MS,
  SLEEP_TWITCH_MIN_MS,
  SLEEP_TWITCH_SETTLE_MS,
  applySleepPose,
  createSleepLife,
  twitchEnvelope,
} from './sleep-life.js';

// Asleep the eyes are closed, so they must stay near centre (the studio's
// sleeping Zs use the room above them), yet a face held perfectly still reads
// as switched off. So it breathes and twitches now and then, briefly. Between
// twitches it holds still: a slow drift of a few screen pixels is drawn on the
// pixel grid as edges stepping a pixel at a time, and read live as a face
// shuffling by a pixel all the time.

/** A seeded random, so the test is the same every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('a sleeping face', () => {
  it('holds its gaze at centre between twitches; only a glance moves it, a little and briefly', () => {
    const life = createSleepLife(seeded(7));
    let moving = 0;
    let samples = 0;
    let glanced = false;
    for (let t = 0; t < 10 * 60_000; t += 16) {
      const pose = life.sample(t);
      samples += 1;
      expect(Math.hypot(pose.gazeX, pose.gazeY)).toBeLessThanOrEqual(SLEEP_GAZE_MAX + 1e-9);
      const last = life.twitches.at(-1);
      const inGlance = last?.kind === 'glance' && t - last.at < SLEEP_TWITCH_SETTLE_MS * 3;
      if (!inGlance) expect(Math.hypot(pose.gazeX, pose.gazeY), `still at ${t} ms`).toBeLessThan(1e-3);
      if (Math.hypot(pose.gazeX, pose.gazeY) > 1e-3) moving += 1;
      if (inGlance && Math.hypot(pose.gazeX, pose.gazeY) > SLEEP_GLANCE * 0.9) glanced = true;
    }
    expect(glanced, 'a glance still shows').toBe(true);
    // Moving under 5 % of the time: very occasional, not a drift.
    expect(moving / samples).toBeLessThan(0.05);
  });

  it('twitches every 6 to 15 s, a lid, the mouth or a glance', () => {
    const life = createSleepLife(seeded(11));
    for (let t = 0; t < 10 * 60_000; t += 50) life.sample(t);
    const times = life.twitches.map((twitch) => twitch.at);
    expect(times.length).toBeGreaterThan(20);
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i]! - times[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(SLEEP_TWITCH_MIN_MS);
      expect(gap).toBeLessThanOrEqual(SLEEP_TWITCH_MAX_MS);
    }
    expect(new Set(life.twitches.map((twitch) => twitch.kind))).toEqual(new Set(['lid', 'mouth', 'glance']));
  });

  it('settles each twitch within 0.3 s', () => {
    expect(twitchEnvelope(60)).toBe(1);
    expect(twitchEnvelope(SLEEP_TWITCH_SETTLE_MS)).toBeLessThan(0.05);
    const life = createSleepLife(seeded(3));
    for (let t = 0; t < 120_000; t += 16) life.sample(t);
    for (const twitch of life.twitches.slice(0, -1)) {
      const settled = life.sample(twitch.at + SLEEP_TWITCH_SETTLE_MS);
      // Only the twitch that is running counts; the earlier ones are long settled.
      if (life.twitches.at(-1)!.at > twitch.at + SLEEP_TWITCH_SETTLE_MS) continue;
      expect(settled.lid).toBeLessThan(0.05);
      expect(settled.mouth).toBeLessThan(0.05);
    }
    // At the peak a twitch shows; 0.3 s later it is gone.
    const twitch = life.twitches.at(-1)!;
    const fresh = createSleepLife(seeded(3));
    for (let t = 0; t <= twitch.at + 60; t += 16) fresh.sample(t);
    const peak = fresh.sample(twitch.at + 60);
    const later = fresh.sample(twitch.at + SLEEP_TWITCH_SETTLE_MS);
    const strength = (pose: typeof peak) => Math.max(pose.lid, pose.mouth);
    if (twitch.kind !== 'glance') {
      expect(strength(peak)).toBeGreaterThan(0.9);
      expect(strength(later)).toBeLessThan(0.05);
    }
  });

  it('breathes on a slow rhythm', () => {
    const life = createSleepLife(seeded(5));
    expect(SLEEP_BREATH_PERIOD_MS).toBeGreaterThanOrEqual(4000);
    expect(SLEEP_BREATH_PERIOD_MS).toBeLessThanOrEqual(5000);
    expect(life.sample(1000).breath).toBeCloseTo(life.sample(1000 + SLEEP_BREATH_PERIOD_MS).breath, 6);
    expect(life.sample(SLEEP_BREATH_PERIOD_MS / 4).breath).toBeCloseTo(1, 6);
  });

  it('twitches only for the frame drawn, leaving the face\'s own motion alone', () => {
    const motion = createFaceMotion();
    const out = createFaceMotion();
    applySleepPose(motion, { gazeX: 0, gazeY: 0, breath: 0, lid: 1, mouth: 1 }, out);
    expect(out.left.sy).toBeGreaterThan(1);
    expect(out.mouth.ox).toBeGreaterThan(0);
    expect(motion).toEqual(createFaceMotion());
  });
});
