import type { AppStore } from '../state/app-state.js';

const BASELINE = Object.freeze({
  pos: 0.24,
  neg: 0.06,
  arousal: 0.2,
});

const PULSE_DURATION_MS = 920;
const EXPRESSION_PULSE_DURATIONS_MS: Record<string, number> = Object.freeze({
  smile: 980,
  happy: 1300,
  sad: 3200,
  thinking: 1100,
  love: 1600,
});

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
  let lastAutoPulseAt = 0;

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
      const drift = store.getState().sleeping ? 0.11 : 0.045;
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
    if (now - lastAutoPulseAt < 1350 || state.sleeping || state.audioPlaying || state.currentExpression !== 'idle') {
      return;
    }

    if (currentMood.neg >= 0.66 && currentMood.arousal >= 0.24) {
      lastAutoPulseAt = now;
      pulseExpression('sad');
      return;
    }

    if (currentMood.pos >= 0.8) {
      lastAutoPulseAt = now;
      pulseExpression('happy');
      return;
    }

    if (currentMood.pos >= 0.58 && Math.random() < 0.55) {
      lastAutoPulseAt = now;
      pulseExpression('smile');
    }
  }

  function pulseExpression(expression: 'smile' | 'happy' | 'sad' | 'thinking' | 'love'): void {
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
