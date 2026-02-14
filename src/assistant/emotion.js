const {
  EMOJI_EMOTION_MAP,
  DUAL_HEAD_DEFAULT_EMOJI_PROFILE_BY_ACTOR,
  TRAILING_PUNCT_RE,
  TRAILING_EMOJI_CLUSTER_RE,
  LEADING_EMOJI_RE,
} = require('./constants');
const { normalizeInput, stripEmojiClusters } = require('./text');

const dualHeadLastFallbackEmojiByActor = {
  main: null,
  small: null,
};

function buildEmotionFromEmoji(emoji) {
  const mapped = EMOJI_EMOTION_MAP[emoji];
  if (!mapped) return null;
  return {
    emoji,
    label: mapped.label,
    expression: mapped.expression,
    impulse: { ...mapped.impulse },
  };
}

function pickSupportedEmotionEmoji(text) {
  const matches = String(text || '').match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) || [];
  for (const candidate of matches) {
    if (EMOJI_EMOTION_MAP[candidate]) return candidate;
  }
  return null;
}

function defaultDualHeadSpeakEmotion(actor) {
  const actorKey = actor === 'small' ? 'small' : 'main';
  const profile = DUAL_HEAD_DEFAULT_EMOJI_PROFILE_BY_ACTOR[actorKey]
    || DUAL_HEAD_DEFAULT_EMOJI_PROFILE_BY_ACTOR.main;
  const last = dualHeadLastFallbackEmojiByActor[actorKey];
  const candidates = profile.filter((emoji) => emoji !== last);
  const pool = candidates.length ? candidates : profile;
  const fallbackEmoji = pool[Math.floor(Math.random() * pool.length)] || '\u{1F642}';
  dualHeadLastFallbackEmojiByActor[actorKey] = fallbackEmoji;
  return buildEmotionFromEmoji(fallbackEmoji);
}

function splitTrailingEmotionEmoji(text) {
  const normalized = normalizeInput(text);
  if (!normalized) {
    return { text: '', emoji: null, emotion: null };
  }

  function makeResult(cleanText, emoji) {
    if (!emoji) return { text: cleanText, emoji: null, emotion: null };
    const mappedEmotion = buildEmotionFromEmoji(emoji);
    if (!mappedEmotion) return { text: cleanText, emoji: null, emotion: null };
    return {
      text: cleanText,
      emoji,
      emotion: mappedEmotion,
    };
  }

  // Preferred protocol: leading emoji cue.
  const leadMatch = normalized.match(LEADING_EMOJI_RE);
  if (leadMatch) {
    const rest = normalizeInput(normalized.slice(leadMatch[0].length));
    return makeResult(rest, leadMatch[1]);
  }

  // Legacy fallback: trailing emoji cue.
  const punctMatch = normalized.match(TRAILING_PUNCT_RE);
  const punctuation = punctMatch ? punctMatch[0].trim() : '';
  let core = punctMatch ? normalized.slice(0, punctMatch.index).trimEnd() : normalized;
  const trailingEmojis = [];

  while (true) {
    const clusterMatch = core.match(TRAILING_EMOJI_CLUSTER_RE);
    if (!clusterMatch) break;
    trailingEmojis.unshift(clusterMatch[1]);
    core = core.slice(0, clusterMatch.index).trimEnd();
  }

  if (!trailingEmojis.length) {
    // Multi-head-safe fallback: detect a supported emoji anywhere in the text.
    const inlineEmoji = pickSupportedEmotionEmoji(normalized);
    if (!inlineEmoji) {
      return { text: stripEmojiClusters(normalized), emoji: null, emotion: null };
    }
    return makeResult(stripEmojiClusters(normalized), inlineEmoji);
  }

  const emoji = trailingEmojis[trailingEmojis.length - 1];
  return makeResult(`${core}${punctuation}`.trim(), emoji);
}

module.exports = {
  buildEmotionFromEmoji,
  pickSupportedEmotionEmoji,
  defaultDualHeadSpeakEmotion,
  splitTrailingEmotionEmoji,
};
