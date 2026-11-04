// Turns what the operator typed in Manual Beats into a beat script.

import type { ManualTurnScriptRequest } from '../../shared/contracts/http.js';
import type { TurnAction, TurnBeat } from '../../shared/contracts/turn-script.js';
import type { EmotionCue, ExpressionName } from '../../shared/contracts/config.js';
import type { AppStore } from '../state/app-state.js';

const SUPPORTED_EMOJI_CUES = new Set<EmotionCue>(['🙂', '😄', '😏', '🥺', '😢', '😤', '🤖', '🫶']);

export function parseSingleBeat(state: ReturnType<AppStore['getState']>): TurnBeat {
  const beat: TurnBeat = {
    actor: state.manualActor,
    action: state.manualAction,
  };

  const text = cleanText(state.manualText);
  if (beat.action === 'speak' && !text) {
    throw new Error('Text is required for speak beats');
  }
  if (text) {
    beat.text = text;
  }

  const delayMs = parseDelayMs(state.manualDelay);
  if (delayMs != null) {
    beat.delayMs = delayMs;
  }

  const expression = cleanText(state.manualExpression).toLowerCase();
  const emoji = cleanText(state.manualEmoji);
  if (emoji && !SUPPORTED_EMOJI_CUES.has(emoji as EmotionCue)) {
    throw new Error('Unsupported emoji cue');
  }

  if (expression || emoji) {
    beat.emotion = {
      ...(expression ? { expression: expression as ExpressionName } : {}),
      ...(emoji ? { emoji: emoji as EmotionCue } : {}),
    };
  }

  return beat;
}

export function parseScriptPayload(raw: string): ManualTurnScriptRequest {
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error('Script JSON is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Script JSON is invalid');
  }

  if (Array.isArray(parsed)) {
    return { beats: parsed as NonNullable<ManualTurnScriptRequest['beats']> };
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as { beats?: ManualTurnScriptRequest['beats']; turn_script?: { beats?: ManualTurnScriptRequest['beats'] } };
    if (Array.isArray(record.beats)) {
      return { beats: record.beats };
    }
    if (Array.isArray(record.turn_script?.beats)) {
      return { beats: record.turn_script.beats };
    }
  }

  throw new Error('Script JSON must be an array or include beats[]');
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDelayMs(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Delay must be a number between 120 and 8000');
  }

  return Math.max(120, Math.min(8000, Math.round(parsed)));
}

export function normalizeManualAction(value: string): TurnAction {
  return value === 'react' || value === 'wait' ? value : 'speak';
}
