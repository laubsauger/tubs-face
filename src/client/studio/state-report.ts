// studio_state: what one head is doing, for the director. Sent when it
// changes and once a second regardless (a page that stops sending is gone).

import type { StudioMood } from '../../shared/contracts/studio.js';
import type { AppState } from '../state/app-state.js';

export interface StudioStateSnapshot {
  speaking: boolean;
  expr: string;
  mood: StudioMood;
}

export const STUDIO_STATE_HEARTBEAT_MS = 1000;
/** The mood eases every frame; smaller moves wait for the heartbeat. */
export const MOOD_REPORT_STEP = 0.05;

export function studioStateOf(state: Pick<AppState, 'audioPlaying' | 'sleeping' | 'currentExpression' | 'moodPos' | 'moodNeg' | 'moodArousal'>): StudioStateSnapshot {
  const round = (value: number) => Math.round(Math.max(-1, Math.min(1, value)) * 1000) / 1000;
  return {
    speaking: state.audioPlaying,
    expr: state.sleeping ? 'sleep' : state.currentExpression,
    mood: { pos: round(state.moodPos), neg: round(state.moodNeg), arousal: round(state.moodArousal) },
  };
}

/**
 * Worth sending now rather than on the next heartbeat: speech starting or
 * stopping and a new face show at once; the mood only once it moved visibly.
 */
export function studioStateChanged(previous: StudioStateSnapshot | null, next: StudioStateSnapshot): boolean {
  if (!previous) return true;
  if (previous.speaking !== next.speaking || previous.expr !== next.expr) return true;
  return Math.abs(previous.mood.pos - next.mood.pos) >= MOOD_REPORT_STEP
    || Math.abs(previous.mood.neg - next.mood.neg) >= MOOD_REPORT_STEP
    || Math.abs(previous.mood.arousal - next.mood.arousal) >= MOOD_REPORT_STEP;
}
