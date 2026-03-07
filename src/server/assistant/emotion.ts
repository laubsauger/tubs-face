import type { EmotionCue, ExpressionName } from '../../shared/contracts/config.js';
import type { EmotionImpulse } from '../../shared/contracts/turn-script.js';
import type { SpeechEmotionPayload } from '../../shared/contracts/ws.js';
import { normalizeInput, stripEmojiClusters } from './text.js';

const TRAILING_PUNCT_RE = /[.!?]+\s*$/;
const TRAILING_EMOJI_CLUSTER_RE = /(?:\s*)(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*$/u;
const LEADING_EMOJI_RE = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;

type EmotionMapEntry = {
  expression: ExpressionName;
  impulse: EmotionImpulse;
};

const EMOJI_EMOTION_MAP: Record<EmotionCue, EmotionMapEntry> = {
  '🙂': {
    expression: 'smile',
    impulse: { pos: 0.58, neg: 0.06, arousal: 0.34 },
  },
  '😄': {
    expression: 'happy',
    impulse: { pos: 0.9, neg: 0.02, arousal: 0.78 },
  },
  '😏': {
    expression: 'smile',
    impulse: { pos: 0.5, neg: 0.16, arousal: 0.48 },
  },
  '🥺': {
    expression: 'sad',
    impulse: { pos: 0.36, neg: 0.26, arousal: 0.36 },
  },
  '😢': {
    expression: 'sad',
    impulse: { pos: 0.12, neg: 0.82, arousal: 0.42 },
  },
  '😤': {
    expression: 'sad',
    impulse: { pos: 0.24, neg: 0.56, arousal: 0.82 },
  },
  '🤖': {
    expression: 'thinking',
    impulse: { pos: 0.32, neg: 0.1, arousal: 0.2 },
  },
  '🫶': {
    expression: 'love',
    impulse: { pos: 0.82, neg: 0.02, arousal: 0.46 },
  },
};

export interface SplitEmotionResult {
  text: string;
  emoji: EmotionCue | null;
  emotion: SpeechEmotionPayload | null;
}

export function splitTrailingEmotionEmoji(text: string): SplitEmotionResult {
  const normalized = normalizeInput(text);
  if (!normalized) {
    return { text: '', emoji: null, emotion: null };
  }

  const leadingEmoji = normalized.match(LEADING_EMOJI_RE)?.[1] ?? null;
  if (leadingEmoji) {
    const cue = asSupportedEmotionCue(leadingEmoji);
    const rest = normalizeInput(normalized.slice(leadingEmoji.length));
    return cue ? buildResult(rest, cue) : { text: rest, emoji: null, emotion: null };
  }

  const punctMatch = normalized.match(TRAILING_PUNCT_RE);
  const punctuation = punctMatch ? punctMatch[0].trim() : '';
  let core = punctMatch ? normalized.slice(0, punctMatch.index).trimEnd() : normalized;
  const trailingEmojis: string[] = [];

  while (true) {
    const clusterMatch = core.match(TRAILING_EMOJI_CLUSTER_RE);
    if (!clusterMatch?.[1]) {
      break;
    }
    trailingEmojis.unshift(clusterMatch[1]);
    core = core.slice(0, clusterMatch.index).trimEnd();
  }

  if (!trailingEmojis.length) {
    const inlineCue = pickSupportedEmotionEmoji(normalized);
    if (!inlineCue) {
      return { text: stripEmojiClusters(normalized), emoji: null, emotion: null };
    }
    return buildResult(stripEmojiClusters(normalized), inlineCue);
  }

  const lastEmoji = trailingEmojis[trailingEmojis.length - 1];
  if (!lastEmoji) {
    return { text: `${core}${punctuation}`.trim(), emoji: null, emotion: null };
  }
  const cue = asSupportedEmotionCue(lastEmoji);
  if (!cue) {
    return { text: `${core}${punctuation}`.trim(), emoji: null, emotion: null };
  }
  return buildResult(`${core}${punctuation}`.trim(), cue);
}

function buildResult(text: string, emoji: EmotionCue): SplitEmotionResult {
  return {
    text,
    emoji,
    emotion: buildEmotionFromEmoji(emoji),
  };
}

export function buildEmotionFromEmoji(emoji: EmotionCue): SpeechEmotionPayload {
  const mapped = EMOJI_EMOTION_MAP[emoji];
  return {
    emoji,
    expression: mapped.expression,
    impulse: mapped.impulse,
  };
}

export function pickSupportedEmotionEmoji(text: string): EmotionCue | null {
  const matches = String(text).match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) ?? [];
  for (const candidate of matches) {
    const cue = asSupportedEmotionCue(candidate);
    if (cue) {
      return cue;
    }
  }
  return null;
}

function asSupportedEmotionCue(value: string): EmotionCue | null {
  return value in EMOJI_EMOTION_MAP ? (value as EmotionCue) : null;
}

export function defaultDualHeadSpeakEmotion(actor: 'main' | 'small'): SpeechEmotionPayload {
  return buildEmotionFromEmoji(actor === 'small' ? '😏' : '🙂');
}
