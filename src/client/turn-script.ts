import type { TurnBeat, TurnEmotion } from '../shared/contracts/turn-script.js';

const DEFAULT_WORD_MS = 440;
const MIN_SPEECH_MS = 800;
const REACTION_FALLBACK_MS = 420;

export interface LocalTurnTimelineItem {
  action: 'speak' | 'react' | 'wait' | 'wait_remote';
  actor?: 'main' | 'small';
  text?: string;
  emotion?: TurnEmotion | null;
  delayMs?: number;
}

export function estimateSpeechDurationMs(text: string): number {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  if (words <= 0) {
    return MIN_SPEECH_MS;
  }
  return Math.max(MIN_SPEECH_MS, words * DEFAULT_WORD_MS);
}

export function estimateBeatDurationMs(beat: TurnBeat): number {
  const explicit = toFiniteNumber(beat.delayMs);
  if (explicit != null) {
    return Math.max(120, Math.min(8000, explicit));
  }
  if (beat.action === 'speak') {
    return estimateSpeechDurationMs(beat.text ?? '');
  }
  return REACTION_FALLBACK_MS;
}

export function buildLocalTurnTimeline(
  beats: TurnBeat[],
  localActor: 'main' | 'small',
  options: { includeRemoteWait?: boolean } = {},
): LocalTurnTimelineItem[] {
  const actorKey = localActor === 'small' ? 'small' : 'main';
  const includeRemoteWait = options.includeRemoteWait !== false;
  const source = Array.isArray(beats) ? beats : [];
  const timeline: LocalTurnTimelineItem[] = [];

  for (const beat of source) {
    if (!beat) {
      continue;
    }
    const actor = beat.actor === 'small' ? 'small' : 'main';
    const explicitDelay = toFiniteNumber(beat.delayMs);
    const delayMs = explicitDelay != null
      ? Math.max(120, Math.min(8000, explicitDelay))
      : estimateBeatDurationMs(beat);

    if (actor !== actorKey) {
      if (beat.action === 'speak' && includeRemoteWait) {
        timeline.push({
          action: 'wait_remote',
          actor,
        });
        continue;
      }
      if (beat.action === 'wait' && explicitDelay != null) {
        timeline.push({
          action: 'wait',
          delayMs,
        });
      }
      continue;
    }

    if (beat.action === 'wait') {
      timeline.push({
        action: 'wait',
        delayMs,
      });
      continue;
    }

    if (beat.action === 'react') {
      timeline.push({
        action: 'react',
        text: beat.text ?? '',
        emotion: beat.emotion ?? null,
        delayMs,
      });
      continue;
    }

    timeline.push({
      action: 'speak',
      text: beat.text ?? '',
      emotion: beat.emotion ?? null,
    });
  }

  return timeline;
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
