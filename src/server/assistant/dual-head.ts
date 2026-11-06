import type { EmotionCue } from '../../shared/contracts/config.js';
import type { TurnBeat, TurnEmotion } from '../../shared/contracts/turn-script.js';
import { runtimeConfig } from '../config/runtime.js';
import {
  buildEmotionFromEmoji,
  defaultDualHeadSpeakEmotion,
  pickSupportedEmotionEmoji,
  splitTrailingEmotionEmoji,
} from './emotion.js';
import { BIT_MAX_SENTENCES, clampOutput, extractJsonBlock, normalizeInput, stripEmojiClusters, stripFormatting, stripSpeakerLabels } from './text.js';

const DUAL_HEAD_ACTORS = new Set(['main', 'small']);
const DUAL_HEAD_ACTIONS = new Set(['speak', 'react']);
const DUAL_HEAD_MAX_BEATS = 7;
const SUPPORTED_EMOJIS = ['🙂', '😄', '😏', '🥺', '😢', '😤', '🤖', '🫶'] as const satisfies EmotionCue[];

export const DUAL_HEAD_RESPONSE_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    beats: {
      type: 'ARRAY',
      minItems: 1,
      maxItems: DUAL_HEAD_MAX_BEATS,
      items: {
        type: 'OBJECT',
        properties: {
          actor: { type: 'STRING', enum: ['main', 'small'] },
          action: { type: 'STRING', enum: ['speak', 'react'] },
          text: { type: 'STRING' },
          emoji: { type: 'STRING', enum: [...SUPPORTED_EMOJIS] },
          delayMs: { type: 'NUMBER' },
        },
        required: ['actor', 'action'],
      },
    },
  },
  required: ['beats'],
});

type NormalizedBeat = TurnBeat;

export interface ParsedDualHeadScript {
  beats: NormalizedBeat[];
  raw: unknown;
}

export function shouldUseDualHeadDirectedMode(): boolean {
  return runtimeConfig.dualHeadEnabled === true && runtimeConfig.dualHeadMode === 'llm_directed';
}

export function normalizeScriptBeat(beat: unknown): NormalizedBeat | null {
  if (!beat || typeof beat !== 'object') {
    return null;
  }

  const record = beat as Record<string, unknown>;
  const actor = DUAL_HEAD_ACTORS.has(String(record.actor ?? '').trim().toLowerCase())
    ? (String(record.actor).trim().toLowerCase() as 'main' | 'small')
    : 'main';
  const action = DUAL_HEAD_ACTIONS.has(String(record.action ?? '').trim().toLowerCase())
    ? String(record.action).trim().toLowerCase()
    : 'speak';
  const rawText = normalizeInput(String(record.text ?? ''));
  const parsed = splitTrailingEmotionEmoji(rawText);
  const strippedText = stripSpeakerLabels(stripFormatting(parsed.text || stripEmojiClusters(rawText)));
  const text = clampOutput(strippedText, BIT_MAX_SENTENCES);
  const emojiFromField = pickSupportedEmotionEmoji(String(record.emoji ?? ''));
  const emotion = toTurnEmotion((emojiFromField ? buildEmotionFromEmoji(emojiFromField) : null) || parsed.emotion || null);

  const parsedDelay = Number.parseInt(String(record.delayMs ?? ''), 10);
  const safeDelayMs = Number.isFinite(parsedDelay)
    ? Math.max(120, Math.min(2500, parsedDelay))
    : undefined;

  if (action === 'react' && !text) {
    if (!emotion && !text) {
      return null;
    }
    return {
      actor,
      action: 'react',
      emotion,
      ...(safeDelayMs !== undefined ? { delayMs: safeDelayMs } : {}),
    };
  }

  if (!text) {
    return null;
  }
  return {
    actor,
    action: 'speak',
    text,
    emotion: emotion ?? toTurnEmotion(defaultDualHeadSpeakEmotion(actor)),
    ...(safeDelayMs !== undefined ? { delayMs: safeDelayMs } : {}),
  };
}

/** The model sometimes repeats a head's line as the next beat ("STINKY CANDLES!" twice); it is said once. */
function dropRepeatedLines(beats: NormalizedBeat[]): NormalizedBeat[] {
  const lastLine = new Map<string, string>();
  return beats.filter((beat) => {
    if (beat.action !== 'speak' || !beat.text) return true;
    const line = beat.text.trim().toLowerCase();
    if (lastLine.get(beat.actor) === line) return false;
    lastLine.set(beat.actor, line);
    return true;
  });
}

export function reorderDualHeadBeats(beats: NormalizedBeat[]): NormalizedBeat[] {
  const policy = runtimeConfig.dualHeadTurnPolicy || 'llm_order';
  if (policy === 'llm_order') {
    return beats;
  }
  if (policy === 'main_first') {
    return [...beats].sort((left, right) => (left.actor === right.actor ? 0 : left.actor === 'main' ? -1 : 1));
  }
  if (policy === 'small_first') {
    return [...beats].sort((left, right) => (left.actor === right.actor ? 0 : left.actor === 'small' ? -1 : 1));
  }
  return beats;
}

export function hasRequiredDualHeadCoverage(beats: TurnBeat[]): boolean {
  if (!Array.isArray(beats) || beats.length === 0) {
    return false;
  }
  return beats.some((beat) => beat.action === 'speak' && normalizeInput(beat.text ?? '').length > 0);
}

export function parseDualHeadScript(rawText: string): ParsedDualHeadScript | null {
  const jsonBlock = extractJsonBlock(rawText);
  if (!jsonBlock) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch {
    return null;
  }

  const beatsRaw = Array.isArray((parsed as { beats?: unknown[] }).beats)
    ? (parsed as { beats: unknown[] }).beats
    : [];
  const beats: NormalizedBeat[] = [];
  for (const beat of beatsRaw.slice(0, DUAL_HEAD_MAX_BEATS)) {
    const normalized = normalizeScriptBeat(beat);
    if (normalized) {
      beats.push(normalized);
    }
  }

  if (!hasRequiredDualHeadCoverage(beats)) {
    return null;
  }
  return {
    beats: reorderDualHeadBeats(dropRepeatedLines(beats)),
    raw: parsed,
  };
}

/**
 * The first speak beat of a script still being streamed, once that beat's
 * JSON object is complete (and every beat before it): its TTS can start
 * while the model writes the rest. Null until then. The finished script is
 * parsed as usual; a caller compares its first speak beat with this one.
 */
export function firstSpeakBeatSoFar(partial: string): NormalizedBeat | null {
  const key = partial.indexOf('"beats"');
  const open = key < 0 ? -1 : partial.indexOf('[', key);
  if (open < 0) return null;
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = open + 1; i < partial.length; i += 1) {
    const ch = partial[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth !== 0) continue;
      let beat: NormalizedBeat | null = null;
      try {
        beat = normalizeScriptBeat(JSON.parse(partial.slice(start, i + 1)));
      } catch {
        return null;
      }
      if (beat?.action === 'speak') return beat;
    } else if (ch === ']' && depth === 0) {
      return null;
    }
  }
  return null;
}

export function rescueBeatsFromRawText(rawText: string): ParsedDualHeadScript | null {
  const text = String(rawText ?? '');
  const decodeJsonString = (value: string): string => String(value)
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .trim();

  const beats: NormalizedBeat[] = [];
  const actorMatches = [...text.matchAll(/"actor"\s*:\s*"(main|small)"/gi)];
  for (let index = 0; index < actorMatches.length; index += 1) {
    const actor = String(actorMatches[index]?.[1] ?? 'main').toLowerCase() === 'small' ? 'small' : 'main';
    const start = actorMatches[index]?.index ?? 0;
    const nextStart = index + 1 < actorMatches.length ? (actorMatches[index + 1]?.index ?? text.length) : text.length;
    const chunk = text.slice(start, Math.min(text.length, nextStart + 180));
    const textMatch = chunk.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const actionMatch = chunk.match(/"action"\s*:\s*"(speak|react)"/i);
    const emojiMatch = chunk.match(/"emoji"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const delayMatch = chunk.match(/"delayMs"\s*:\s*(\d{2,5})/i);

    const rawBeatText = decodeJsonString(textMatch?.[1] ?? '');
    if (!rawBeatText || rawBeatText.length < 2) {
      continue;
    }
    const cleanText = clampOutput(stripSpeakerLabels(stripFormatting(rawBeatText)), BIT_MAX_SENTENCES);
    if (!cleanText) {
      continue;
    }

    const requestedAction = String(actionMatch?.[1] ?? 'speak').toLowerCase() === 'react' ? 'react' : 'speak';
    const action = requestedAction === 'react' && !cleanText ? 'react' : 'speak';
    const emoji = decodeJsonString(emojiMatch?.[1] ?? '');
    const parsedDelay = Number.parseInt(String(delayMatch?.[1] ?? ''), 10);
    const safeDelayMs = Number.isFinite(parsedDelay)
      ? Math.max(120, Math.min(2500, parsedDelay))
      : undefined;

    beats.push({
      actor,
      action,
      ...(action === 'speak' ? { text: cleanText } : {}),
      emotion: toTurnEmotion(buildEmotionFromEmoji(pickSupportedEmotionEmoji(emoji) ?? (actor === 'small' ? '😏' : '🙂'))),
      ...(safeDelayMs !== undefined ? { delayMs: safeDelayMs } : {}),
    });
  }

  if (beats.length === 0) {
    const linePattern = /(?:^|\n)\s*(main|small)\s*[:\-]\s*(.+?)(?=\n|$)/gi;
    let lineMatch: RegExpExecArray | null = null;
    while ((lineMatch = linePattern.exec(text)) !== null) {
      const actor = String(lineMatch[1] ?? 'main').toLowerCase() === 'small' ? 'small' : 'main';
      const cleanText = clampOutput(stripSpeakerLabels(stripFormatting(decodeJsonString(lineMatch[2] ?? ''))), BIT_MAX_SENTENCES);
      if (!cleanText) {
        continue;
      }
      beats.push({
        actor,
        action: 'speak',
        text: cleanText,
        emotion: toTurnEmotion(defaultDualHeadSpeakEmotion(actor)),
      });
    }
  }

  if (beats.length === 0) {
    return null;
  }

  console.log(`[LLM:dual] Recovered ${beats.length} beats via regex from malformed JSON`);
  return {
    beats: reorderDualHeadBeats(dropRepeatedLines(beats.slice(0, DUAL_HEAD_MAX_BEATS))),
    raw: null,
  };
}

export function summarizeDualHeadBeatsForLog(beats: TurnBeat[], options: { userInput?: string } = {}): string {
  const normalizedUserInput = normalizeInput(options.userInput ?? '').replace(/\s+/g, ' ').trim();
  const truncatedUserInput = normalizedUserInput.length > 240
    ? `${normalizedUserInput.slice(0, 240)}...`
    : normalizedUserInput;
  const userLine = truncatedUserInput ? `\n  <- USER  : ${truncatedUserInput}` : '';

  if (!Array.isArray(beats) || beats.length === 0) {
    return `${userLine}\n  -> [none]`;
  }

  return `${userLine}\n${beats
    .map((beat) => {
      const actor = String(beat.actor || 'main').toUpperCase().padEnd(5, ' ');
      const actionStr = beat.action === 'speak' ? '' : ` [${beat.action}]`;
      const emoji = beat.emotion?.emoji || '-';
      const text = String(beat.text || '').replace(/\s+/g, ' ').trim();
      return `  -> [${actor}]${actionStr} ${emoji} : ${text}`;
    })
    .join('\n')}`;
}

function toTurnEmotion(emotion: { emoji?: string | null; expression?: string | null; impulse?: TurnEmotion['impulse'] | null } | null): TurnEmotion | null {
  if (!emotion) {
    return null;
  }
  const next: Record<string, unknown> = {};
  const expression = emotion.expression;
  const emoji = emotion.emoji;
  const impulse = emotion.impulse;
  if (expression !== undefined) {
    next.expression = expression;
  }
  if (emoji !== undefined) {
    next.emoji = emoji;
  }
  if (impulse !== undefined) {
    next.impulse = impulse;
  }
  return next as TurnEmotion;
}
