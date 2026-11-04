import type { AppStore } from '../state/app-state.js';

const BASELINE = Object.freeze({
  pos: 0.24,
  neg: 0.06,
  arousal: 0.2,
});

const PULSE_DURATION_MS = 920;
const EXPRESSION_PULSE_DURATIONS_MS: Record<string, number> = Object.freeze({
  smile: 980,
  smug: 1600,
  happy: 1300,
  sad: 3200,
  angry: 1800,
  thinking: 1100,
  love: 1600,
});
// How long a feeling lingers. It used to fade in about a quarter second, so
// the face forgot an insult before the reply was over. Now a run of insults
// adds up to a grumpy Tubs that calms down over a minute or so.
export const MOOD_HALF_LIFE_MS = 30_000;
const SLEEP_MOOD_HALF_LIFE_MS = 8000;
// Idle flickers of the current mood, spaced so they read as moods, not tics.
const AUTO_PULSE_MIN_GAP_MS = 3500;
const AUTO_PULSE_MAX_GAP_MS = 7000;

type PulseExpression = 'smile' | 'smug' | 'happy' | 'sad' | 'angry' | 'thinking' | 'love';

/**
 * The idle face for a mood, or null to stay neutral. Thresholds sit just
 * below where one reply's emoji leaves the mood (one 😤: neg 0.24, arousal
 * 0.43; one 😏: pos 0.31, neg 0.09), so a single reply shows and fades within
 * 10-30 s, and several in a row last longer.
 */
export function moodExpression(mood: { pos: number; neg: number; arousal: number }): PulseExpression | null {
  if (mood.neg >= 0.2 && mood.neg > mood.pos * 0.8) {
    return mood.arousal >= 0.38 ? 'angry' : 'sad';
  }
  if (mood.pos >= 0.42 && mood.arousal >= 0.38) return 'happy';
  if (mood.pos >= 0.28) return mood.neg >= 0.08 ? 'smug' : 'smile';
  return null;
}

export interface EmotionRuntime {
  init(): void;
  dispose(): void;
  pushImpulse(impulse: { pos?: number; neg?: number; arousal?: number }, source?: 'system' | 'spoken'): void;
}

export function createEmotionRuntime(store: AppStore): EmotionRuntime {
  const currentMood: { pos: number; neg: number; arousal: number } = { ...BASELINE };
  const targetMood: { pos: number; neg: number; arousal: number } = { ...BASELINE };
  let holdUntil = 0;
  let rafId = 0;
  let lastTickMs = 0;
  let pulseTimer: number | null = null;
  let nextAutoPulseAt = 0;

  return {
    init(): void {
      if (rafId) {
        return;
      }
      applyMoodState();
      rafId = requestAnimationFrame(tick);
    },
    dispose(): void {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (pulseTimer != null) {
        clearTimeout(pulseTimer);
      }
    },
    pushImpulse(impulse, source = 'system'): void {
      const gain = source === 'spoken' ? 0.8 : 1;
      targetMood.pos = clamp01(targetMood.pos * 0.54 + clamp01(impulse.pos ?? 0) * 0.46 * gain);
      targetMood.neg = clamp01(targetMood.neg * 0.54 + clamp01(impulse.neg ?? 0) * 0.46 * gain);
      targetMood.arousal = clamp01(targetMood.arousal * 0.5 + clamp01(impulse.arousal ?? 0) * 0.5 * gain);
      holdUntil = Date.now() + 1700;
    },
  };

  function tick(nowMs: number): void {
    if (!lastTickMs) {
      lastTickMs = nowMs;
    }
    const deltaMs = Math.max(8, nowMs - lastTickMs);
    lastTickMs = nowMs;

    const now = Date.now();
    if (now > holdUntil) {
      const halfLife = store.getState().sleeping ? SLEEP_MOOD_HALF_LIFE_MS : MOOD_HALF_LIFE_MS;
      const drift = 1 - Math.pow(0.5, deltaMs / halfLife);
      targetMood.pos = lerp(targetMood.pos, BASELINE.pos, drift);
      targetMood.neg = lerp(targetMood.neg, BASELINE.neg, drift);
      targetMood.arousal = lerp(targetMood.arousal, store.getState().sleeping ? 0.08 : BASELINE.arousal, drift);
    }

    const step = Math.min(0.28, 0.06 + deltaMs / 400);
    currentMood.pos = lerp(currentMood.pos, targetMood.pos, step);
    currentMood.neg = lerp(currentMood.neg, targetMood.neg, step);
    currentMood.arousal = lerp(currentMood.arousal, targetMood.arousal, step);

    applyMoodState();
    maybeAutoPulse(now);
    rafId = requestAnimationFrame(tick);
  }

  function applyMoodState(): void {
    store.setState((current) => ({
      ...current,
      moodPos: currentMood.pos,
      moodNeg: currentMood.neg,
      moodArousal: currentMood.arousal,
    }));
  }

  function maybeAutoPulse(now: number): void {
    const state = store.getState();
    if (now < nextAutoPulseAt || state.sleeping || state.audioPlaying || state.currentExpression !== 'idle') {
      return;
    }
    nextAutoPulseAt = now + AUTO_PULSE_MIN_GAP_MS + Math.random() * (AUTO_PULSE_MAX_GAP_MS - AUTO_PULSE_MIN_GAP_MS);
    const expression = moodExpression(currentMood);
    if (expression) {
      pulseExpression(expression);
    }
  }

  function pulseExpression(expression: PulseExpression): void {
    const state = store.getState();
    if (state.sleeping || state.audioPlaying) {
      return;
    }
    if (pulseTimer != null) {
      clearTimeout(pulseTimer);
    }
    store.setState((current) => ({
      ...current,
      currentExpression: expression,
    }));
    pulseTimer = window.setTimeout(() => {
      pulseTimer = null;
      const nextState = store.getState();
      if (nextState.currentExpression === expression && !nextState.audioPlaying && !nextState.sleeping) {
        store.setState((current) => ({
          ...current,
          currentExpression: 'idle',
        }));
      }
    }, EXPRESSION_PULSE_DURATIONS_MS[expression] ?? PULSE_DURATION_MS);
  }
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
