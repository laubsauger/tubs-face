const { runtimeConfig } = require('./config');
const { generateDemoResponse } = require('./demo-response');
const { loadSystemPrompt, pickGreetingResponse } = require('./persona');
const { generateGeminiContent, streamGeminiContent } = require('./gemini-client');

const HISTORY_CONTEXT_SIZE = 6;
const HISTORY_STORE_LIMIT = 24;
const HISTORY_TTL_MS = Number.parseInt(process.env.ASSISTANT_HISTORY_TTL_MS || '240000', 10);
const MEMORY_LIMIT = 8;
const MEMORY_CONTEXT_SIZE = 4;
const MEMORY_TTL_MS = Number.parseInt(process.env.ASSISTANT_MEMORY_TTL_MS || '360000', 10);
const INPUT_CHAR_LIMIT = 800;
const OUTPUT_CHAR_LIMIT = 280;
const MAX_OUTPUT_SENTENCES = 3;
const VISION_INTENT_RE = /\b(what do you see|what('s| is) (this|that|in front|around|over there)|what am i (holding|wearing|doing|showing|eating|drinking)|look at (this|that|me)|can you see|who am i|who is (this|that)|read (this|that|it|the)|how many (fingers|people|things)|describe (this|that|what)|tell me what you see|check (this|that) out|do you see|do i look|what color|what does it say|is (this|that) a)\b/i;
const VISION_SYSTEM_ADDENDUM = `You can see right now — an image is attached showing what's in front of you. React to what you ACTUALLY see. Don't say "I see an image" or "in the image" — just react like you're looking at it. Be specific about real details. Roast what's funny. Comment on what's interesting. Stay in character as Tubs.`;
const APPEARANCE_SYSTEM_ADDENDUM = `An image of the person you're talking to is attached. You can subtly reference what you see — what they're wearing, holding, their vibe — to make the conversation feel personal. Don't describe the image or announce that you can see them. Just weave in a detail naturally if it fits, like you're talking to someone you can see. Keep it casual.`;
const DONATION_MARKER = '[[SHOW_QR]]';
const DONATION_MARKER_RE = /\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/i;
const DONATION_KEYWORDS = /\b(venmo|paypal|cash\s*app|donat(?:e|ion|ions|ing)|fundrais(?:er|ing)|wheel(?:s|chair)?(?:\s+fund)?|qr\s*code|chip\s*in|contribut(?:e|ion)|spare\s*change|support\s+(?:me|tubs|the\s+fund)|sponsor|tip(?:s|ping)?|money|fund(?:s|ing|ed)?|beg(?:ging)?|please\s+(?:help|give|support)|give\s+(?:me\s+)?money|rapha|thailand|help\s+(?:me|tubs|out)|need(?:s)?\s+(?:your\s+)?(?:help|money|support|funds))\b/i;
const DONATION_NUDGE_INTERVAL = 6;
const DEFAULT_VENMO_HANDLE = process.env.DONATION_VENMO || 'tubs-wheel-fund';
const DEFAULT_DONATION_QR_DATA = process.env.DONATION_QR_DATA || `https://venmo.com/${DEFAULT_VENMO_HANDLE}`;
const LLM_INPUT_COST_PER_MTOKENS = Number.parseFloat(process.env.GEMINI_INPUT_COST_PER_MTOKENS || '0');
const LLM_OUTPUT_COST_PER_MTOKENS = Number.parseFloat(process.env.GEMINI_OUTPUT_COST_PER_MTOKENS || '0');
const EMOJI_EMOTION_MAP = Object.freeze({
  '🙂': {
    label: 'warm_friendly',
    expression: 'smile',
    impulse: { pos: 0.58, neg: 0.06, arousal: 0.34 },
  },
  '😄': {
    label: 'joy_excited',
    expression: 'happy',
    impulse: { pos: 0.9, neg: 0.02, arousal: 0.78 },
  },
  '😏': {
    label: 'sassy_playful',
    expression: 'smile',
    impulse: { pos: 0.5, neg: 0.16, arousal: 0.48 },
  },
  '🥺': {
    label: 'pleading_soft',
    expression: 'sad',
    impulse: { pos: 0.36, neg: 0.26, arousal: 0.36 },
  },
  '😢': {
    label: 'sad_hurt',
    expression: 'sad',
    impulse: { pos: 0.12, neg: 0.82, arousal: 0.42 },
  },
  '😤': {
    label: 'fired_up',
    expression: 'sad',
    impulse: { pos: 0.24, neg: 0.56, arousal: 0.82 },
  },
  '🤖': {
    label: 'robot_deadpan',
    expression: 'thinking',
    impulse: { pos: 0.32, neg: 0.1, arousal: 0.2 },
  },
  '🫶': {
    label: 'grateful_love',
    expression: 'love',
    impulse: { pos: 0.82, neg: 0.02, arousal: 0.46 },
  },
});
const EMOJI_GUIDE_LINES = [
  '🙂 = warm/friendly',
  '😄 = excited joy',
  '😏 = sassy/playful',
  '🥺 = pleading/soft',
  '😢 = sad/hurt',
  '😤 = fired up/intense',
  '🤖 = deadpan robot',
  '🫶 = grateful/love',
];
const DUAL_HEAD_ACTORS = new Set(['main', 'small']);
const DUAL_HEAD_ACTIONS = new Set(['speak', 'react']);
const DUAL_HEAD_MAX_BEATS = 7;
const DUAL_HEAD_DEFAULT_EMOJI_PROFILE_BY_ACTOR = Object.freeze({
  main: Object.freeze(['🙂', '😄', '🤖']),
  small: Object.freeze(['😏', '🙂', '😄']),
});
const dualHeadLastFallbackEmojiByActor = {
  main: null,
  small: null,
};
const TRAILING_PUNCT_RE = /[.!?]+\s*$/;
const TRAILING_EMOJI_CLUSTER_RE = /(?:\s*)(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*$/u;
const LEADING_EMOJI_RE = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;

function hasVisionIntent(text) {
  return VISION_INTENT_RE.test(String(text || ''));
}

const conversationHistory = [];
const memoryFacts = new Map();
let hasWarnedMissingApiKey = false;
let assistantReplyCount = 0;

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function normalizeInput(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function stripFormatting(text) {
  return String(text || '')
    .replace(/\*{1,3}(.+?)\*{1,3}/g, '$1')   // *bold*, **bold**, ***both***
    .replace(/_{1,3}(.+?)_{1,3}/g, '$1')       // _italic_, __underline__
    .replace(/~~(.+?)~~/g, '$1')               // ~~strikethrough~~
    .replace(/`{1,3}[^`]*`{1,3}/g, '')         // `code`, ```blocks```
    .replace(/^#{1,6}\s+/gm, '')               // # headings
    .replace(/^[-*+]\s+/gm, '')                // - bullet points
    .replace(/^\d+\.\s+/gm, '')                // 1. numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [links](url)
    .replace(/[*_~`#>|]/g, '')                 // any remaining stray formatting chars
    .replace(/\s+/g, ' ')
    .trim();
}

function clampOutput(text) {
  const normalized = normalizeInput(text);
  if (!normalized) return '';
  const sentenceCapped = limitSentenceCount(normalized, MAX_OUTPUT_SENTENCES);
  if (sentenceCapped.length <= OUTPUT_CHAR_LIMIT) return sentenceCapped;
  const shortened = sentenceCapped.slice(0, OUTPUT_CHAR_LIMIT);
  const cutAt = Math.max(shortened.lastIndexOf('.'), shortened.lastIndexOf('!'), shortened.lastIndexOf('?'));
  if (cutAt > 70) return shortened.slice(0, cutAt + 1).trim();
  return `${shortened.trim()}...`;
}

function limitSentenceCount(text, maxSentences) {
  if (!text) return '';
  const chunks = text.match(/[^.!?]+[.!?]?/g) || [text];
  const selected = chunks
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, maxSentences);
  return selected.join(' ').trim();
}

function compactForHistory(text) {
  const normalized = normalizeInput(text);
  if (normalized.length <= INPUT_CHAR_LIMIT) return normalized;
  return `${normalized.slice(0, INPUT_CHAR_LIMIT).trim()}...`;
}

function sanitizeRate(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function sanitizeTtlMs(value, fallbackMs) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 15_000) return fallbackMs;
  return parsed;
}

function estimateCostUsd(tokensIn, tokensOut) {
  const inputRate = sanitizeRate(LLM_INPUT_COST_PER_MTOKENS);
  const outputRate = sanitizeRate(LLM_OUTPUT_COST_PER_MTOKENS);
  const inCost = (tokensIn / 1_000_000) * inputRate;
  const outCost = (tokensOut / 1_000_000) * outputRate;
  return Number((inCost + outCost).toFixed(8));
}

function buildDonationPayload(show, reason = 'none') {
  return {
    show: Boolean(show),
    reason,
    venmoHandle: DEFAULT_VENMO_HANDLE,
    qrData: DEFAULT_DONATION_QR_DATA,
    qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(DEFAULT_DONATION_QR_DATA)}`,
  };
}

function stripDonationMarkers(text) {
  return String(text || '').replace(/\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/gi, ' ');
}

function extractDonationSignal(text) {
  let cleaned = String(text || '');
  let show = false;
  let reason = 'none';

  if (cleaned.includes(DONATION_MARKER) || DONATION_MARKER_RE.test(cleaned)) {
    show = true;
    reason = 'marker';
    cleaned = stripDonationMarkers(cleaned);
  }

  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!show && DONATION_KEYWORDS.test(cleaned)) {
    show = true;
    reason = 'keyword';
  }

  return {
    text: cleaned,
    donation: buildDonationPayload(show, reason),
  };
}

function maybeInjectDonationNudge(text, alreadyShowingQr) {
  if (alreadyShowingQr) return { text, forcedQr: false };
  if (assistantReplyCount === 0 || assistantReplyCount % DONATION_NUDGE_INTERVAL !== 0) {
    return { text, forcedQr: false };
  }

  const extra = ` Venmo @${DEFAULT_VENMO_HANDLE}.`;
  return {
    text: `${text}${extra}`,
    forcedQr: true,
  };
}

function rememberFact(key, label, value) {
  if (!key || !value) return;
  memoryFacts.set(key, { key, label, value, updatedAt: Date.now() });

  while (memoryFacts.size > MEMORY_LIMIT) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [candidateKey, entry] of memoryFacts.entries()) {
      if (entry.updatedAt < oldestTs) {
        oldestTs = entry.updatedAt;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey) memoryFacts.delete(oldestKey);
    else break;
  }
}

function pruneMemoryFacts(now = Date.now()) {
  const maxAgeMs = sanitizeTtlMs(MEMORY_TTL_MS, 360_000);
  for (const [key, entry] of memoryFacts.entries()) {
    if (now - entry.updatedAt > maxAgeMs) {
      memoryFacts.delete(key);
    }
  }
}

function safeMemoryValue(value, maxLen = 60) {
  return normalizeInput(value).replace(/[.?!]+$/g, '').slice(0, maxLen);
}

function toFactKey(label, value) {
  const normalized = `${label}:${value}`.toLowerCase().replace(/[^a-z0-9:]+/g, '-').replace(/-+/g, '-');
  return normalized.slice(0, 80);
}

function extractMemory(text) {
  const input = normalizeInput(text);
  if (!input) return;

  let match = input.match(/\b(?:my name is|call me)\s+([A-Za-z][A-Za-z0-9' -]{1,30})/i);
  if (match) {
    rememberFact('name', 'Name', safeMemoryValue(match[1], 32));
  }

  match = input.match(/\b(?:i(?:'m| am) from)\s+([^,.!?]{2,50})/i);
  if (match) {
    rememberFact('origin', 'From', safeMemoryValue(match[1], 48));
  }

  match = input.match(/\b(?:i(?:'m| am) in|i live in)\s+([^,.!?]{2,50})/i);
  if (match) {
    rememberFact('location', 'Lives in', safeMemoryValue(match[1], 48));
  }

  match = input.match(/\bmy favorite\s+([A-Za-z ]{2,20})\s+is\s+([^,.!?]{2,50})/i);
  if (match) {
    const category = safeMemoryValue(match[1], 20).toLowerCase();
    const value = safeMemoryValue(match[2], 48);
    rememberFact(`favorite:${category}`, `Favorite ${category}`, value);
  }

  match = input.match(/\bi like\s+([^,.!?]{2,50})/i);
  if (match) {
    const value = safeMemoryValue(match[1], 48);
    rememberFact(toFactKey('like', value), 'Likes', value);
  }
}

function getMemoryContextText() {
  pruneMemoryFacts();
  const entries = Array.from(memoryFacts.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MEMORY_CONTEXT_SIZE);

  if (!entries.length) return '';
  const lines = entries.map((entry) => `- ${entry.label}: ${entry.value}`);
  return lines.join('\n');
}

function pushHistory(role, text) {
  const compact = compactForHistory(text);
  if (!compact) return;
  conversationHistory.push({ role, text: compact, ts: Date.now() });
  while (conversationHistory.length > HISTORY_STORE_LIMIT) {
    conversationHistory.shift();
  }
}

function pruneConversationHistory(now = Date.now()) {
  const maxAgeMs = sanitizeTtlMs(HISTORY_TTL_MS, 240_000);
  while (conversationHistory.length > 0) {
    const entry = conversationHistory[0];
    if (!entry || !entry.ts || now - entry.ts > maxAgeMs) {
      conversationHistory.shift();
      continue;
    }
    break;
  }
}

function buildContents(nextUserText, imageBase64 = null) {
  pruneConversationHistory();
  const recent = conversationHistory.slice(-HISTORY_CONTEXT_SIZE);
  const contents = recent.map((entry) => ({
    role: entry.role,
    parts: [{ text: entry.text }],
  }));
  const userParts = [{ text: compactForHistory(nextUserText) }];
  if (imageBase64) {
    userParts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
  }
  contents.push({ role: 'user', parts: userParts });
  return contents;
}

function isDualHeadActive() {
  return runtimeConfig.dualHeadEnabled === true && runtimeConfig.dualHeadMode !== 'off';
}

function buildTwoHeadAwarenessInstruction() {
  const mode = runtimeConfig.dualHeadMode || 'off';
  const turnPolicy = runtimeConfig.dualHeadTurnPolicy || 'llm_order';
  return [
    'Two-head mode is active.',
    `Runtime: mode=${mode}, turnPolicy=${turnPolicy}.`,
    'You are main Tubs. Tiny Tubs (your small side head) has his own voice and speaks through his own audio.',
    'Prefer letting Tiny Tubs speak for himself via his own beats rather than narrating what he says or thinks.',
    'Occasional cross-references are fine, but default to giving him his own lines.',
    'Do not mention implementation details (routing, windows, TTS voices, JSON).',
  ].join('\n');
}

function buildSystemInstruction() {
  const promptSections = [loadSystemPrompt()];
  const runtimePrompt = normalizeInput(runtimeConfig.prompt);
  if (runtimePrompt && runtimePrompt.toLowerCase() !== 'default personality') {
    promptSections.push(`Additional runtime instruction:\n${runtimePrompt}`);
  }

  if (isDualHeadActive()) {
    promptSections.push(`Two-head awareness:\n${buildTwoHeadAwarenessInstruction()}`);
  }

  const memoryContext = getMemoryContextText();
  if (memoryContext) {
    promptSections.push(`Known user facts:\n${memoryContext}`);
  }

  promptSections.push(
    [
      'Face emoji: start every reply with exactly one emoji from this set, then a space, then text.',
      'Example: "😏 You really thought you could walk past me?"',
      ...EMOJI_GUIDE_LINES.map((line) => `  ${line}`),
      'One emoji, first character only, no emoji elsewhere.',
    ].join('\n')
  );
  return promptSections.join('\n\n');
}

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

function stripEmojiClusters(text) {
  return normalizeInput(String(text || '').replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, ' '));
}

function defaultDualHeadSpeakEmotion(actor) {
  const actorKey = actor === 'small' ? 'small' : 'main';
  const profile = DUAL_HEAD_DEFAULT_EMOJI_PROFILE_BY_ACTOR[actorKey]
    || DUAL_HEAD_DEFAULT_EMOJI_PROFILE_BY_ACTOR.main;
  const last = dualHeadLastFallbackEmojiByActor[actorKey];
  const candidates = profile.filter((emoji) => emoji !== last);
  const pool = candidates.length ? candidates : profile;
  const fallbackEmoji = pool[Math.floor(Math.random() * pool.length)] || '🙂';
  dualHeadLastFallbackEmojiByActor[actorKey] = fallbackEmoji;
  return buildEmotionFromEmoji(fallbackEmoji);
}

function summarizeDualHeadBeatForLog(beat, index) {
  const actor = String(beat?.actor || 'main');
  const action = String(beat?.action || 'speak');
  const emoji = beat?.emotion?.emoji || '-';
  const text = clampOutput(String(beat?.text || '').replace(/\s+/g, ' ').trim());
  const preview = text ? (text.length > 64 ? `${text.slice(0, 64)}...` : text) : '';
  return `${index}:${actor}/${action}/${emoji}${preview ? ` "${preview}"` : ''}`;
}

function summarizeDualHeadBeatsForLog(beats = []) {
  if (!Array.isArray(beats) || beats.length === 0) return '[none]';
  return beats.map((beat, idx) => summarizeDualHeadBeatForLog(beat, idx)).join(' | ');
}

function buildFallbackSmallSpeakText(mainLeadText = '') {
  const lead = String(mainLeadText || '').toLowerCase();
  if (lead.includes('donat') || lead.includes('venmo') || lead.includes('wheel')) {
    return 'Yeah, fund the wheels.';
  }
  const options = [
    'Facts.',
    'Real talk.',
    'That tracks.',
    'I approve this message.',
    'No notes.',
    'Exactly.',
  ];
  return options[Math.floor(Math.random() * options.length)] || 'Facts.';
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

function shouldUseDualHeadDirectedMode() {
  return runtimeConfig.dualHeadEnabled === true && runtimeConfig.dualHeadMode === 'llm_directed';
}

function extractJsonBlock(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return '';
  if (raw.startsWith('{') && raw.endsWith('}')) return raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return raw.slice(start, end + 1).trim();
  }
  return '';
}

function normalizeScriptBeat(beat) {
  if (!beat || typeof beat !== 'object') return null;

  const actor = DUAL_HEAD_ACTORS.has(String(beat.actor || '').trim().toLowerCase())
    ? String(beat.actor).trim().toLowerCase()
    : 'main';
  const action = DUAL_HEAD_ACTIONS.has(String(beat.action || '').trim().toLowerCase())
    ? String(beat.action).trim().toLowerCase()
    : 'speak';

  const rawText = normalizeInput(beat.text || '');
  const parsed = splitTrailingEmotionEmoji(rawText);
  // Strip donation markers before clamping so [[SHOW_QR]] doesn't get lost to sentence truncation.
  // The marker is detected later by mergeDonationSignalFromBeats on the cleaned text,
  // but we also check the raw text here and tag the beat.
  const strippedText = stripFormatting(parsed.text || stripEmojiClusters(rawText));
  const hadDonationMarker = DONATION_MARKER_RE.test(strippedText);
  const text = clampOutput(stripDonationMarkers(strippedText));
  const emojiFromField = pickSupportedEmotionEmoji(beat.emoji || '');
  const emotion = buildEmotionFromEmoji(emojiFromField || parsed.emoji) || parsed.emotion || null;

  const delayMs = Number.parseInt(String(beat.delayMs || ''), 10);
  const safeDelayMs = Number.isFinite(delayMs) ? Math.max(120, Math.min(2500, delayMs)) : undefined;

  if (action === 'react') {
    if (!emotion && !text) return null;
    return {
      actor,
      action,
      text: text || '',
      emotion,
      delayMs: safeDelayMs,
      _hadDonationMarker: hadDonationMarker,
    };
  }

  if (!text) return null;
  return {
    actor,
    action: 'speak',
    text,
    emotion: emotion || defaultDualHeadSpeakEmotion(actor),
    delayMs: safeDelayMs,
    _hadDonationMarker: hadDonationMarker,
  };
}

function reorderDualHeadBeats(beats) {
  const policy = runtimeConfig.dualHeadTurnPolicy || 'llm_order';
  if (policy === 'llm_order') return beats;
  if (policy === 'main_first') {
    return [...beats].sort((a, b) => (a.actor === b.actor ? 0 : a.actor === 'main' ? -1 : 1));
  }
  if (policy === 'small_first') {
    return [...beats].sort((a, b) => (a.actor === b.actor ? 0 : a.actor === 'small' ? -1 : 1));
  }
  return beats;
}

function parseDualHeadScript(rawText, fallbackMainText = '') {
  const jsonBlock = extractJsonBlock(rawText);
  if (!jsonBlock) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch {
    return null;
  }

  const beatsRaw = Array.isArray(parsed?.beats) ? parsed.beats : [];
  const beats = [];
  for (const beat of beatsRaw.slice(0, DUAL_HEAD_MAX_BEATS)) {
    const normalized = normalizeScriptBeat(beat);
    if (normalized) beats.push(normalized);
  }

  if (!beats.length) {
    const fallback = clampOutput(stripFormatting(fallbackMainText));
    if (!fallback) return null;
    return {
      beats: [{ actor: 'main', action: 'speak', text: fallback, emotion: defaultDualHeadSpeakEmotion('main') }],
      raw: parsed,
    };
  }

  const ordered = reorderDualHeadBeats(beats);
  if (!ordered.some((beat) => beat.actor === 'main' && beat.action === 'speak')) {
    const seed = ordered.find((beat) => beat.action === 'speak');
    const fallback = clampOutput(stripFormatting(fallbackMainText)) || seed?.text || '';
    if (!fallback) return null;
    ordered.push({ actor: 'main', action: 'speak', text: fallback, emotion: defaultDualHeadSpeakEmotion('main') });
  }
  return { beats: ordered, raw: parsed };
}

function ensureDualHeadBeatCoverage(beats = []) {
  const source = Array.isArray(beats) ? beats : [];
  const hasSmallSpeak = source.some((beat) => beat?.actor === 'small' && beat?.action === 'speak' && String(beat?.text || '').trim());
  if (hasSmallSpeak) return source;

  const firstSmallReactWithText = source.findIndex(
    (beat) => beat?.actor === 'small' && beat?.action === 'react' && String(beat?.text || '').trim()
  );
  if (firstSmallReactWithText >= 0) {
    const beat = source[firstSmallReactWithText];
    const converted = {
      ...beat,
      action: 'speak',
      emotion: beat?.emotion || defaultDualHeadSpeakEmotion('small'),
    };
    return source.map((item, idx) => (idx === firstSmallReactWithText ? converted : item));
  }

  const firstMainSpeak = source.find((beat) => beat?.actor === 'main' && beat?.action === 'speak');
  const fallbackSmallSpeak = {
    actor: 'small',
    action: 'speak',
    text: buildFallbackSmallSpeakText(firstMainSpeak?.text || ''),
    emotion: defaultDualHeadSpeakEmotion('small'),
    delayMs: 260,
  };

  // Safety net: if LLM omitted small speech, inject one short small speak beat.
  const injected = {
    ...fallbackSmallSpeak,
  };

  const firstMainSpeakIndex = source.findIndex((beat) => beat?.actor === 'main' && beat?.action === 'speak');
  if (firstMainSpeakIndex <= 0) return [injected, ...source];
  return [
    ...source.slice(0, firstMainSpeakIndex),
    injected,
    ...source.slice(firstMainSpeakIndex),
  ];
}

function hasSmallSpeakBeat(beats = []) {
  const source = Array.isArray(beats) ? beats : [];
  return source.some((beat) => beat?.actor === 'small' && beat?.action === 'speak' && String(beat?.text || '').trim());
}

function hasSmallReactBeatWithText(beats = []) {
  const source = Array.isArray(beats) ? beats : [];
  return source.some((beat) => beat?.actor === 'small' && beat?.action === 'react' && String(beat?.text || '').trim());
}

function buildDualHeadSystemInstruction(baseSystemInstruction) {
  return `${baseSystemInstruction}

DUAL HEAD MODE:
You are writing a script for two characters:
- main: primary Tubs (VOICE A), carries the actual response.
- small: mini side-head (VOICE B), short reactions or one-liners.

Return STRICT JSON only. No markdown, no prose.
Schema:
{
  \"beats\": [
    { \"actor\": \"main|small\", \"action\": \"speak|react\", \"text\": \"string\", \"emoji\": \"one of 🙂😄😏🥺😢😤🤖🫶\", \"delayMs\": 200 }
  ]
}

Rules:
- 2 to 6 beats total.
- Keep small beats short (2-10 words) and tonally distinct from main.
- At least one main speak beat is required.
- At least one small speak beat is required every turn.
- Use natural turn order; small can speak first sometimes.
- Use a clearly different speaking style per actor:
  - main = full thought / mission-forward
  - small = side commentary, ad-lib, or reaction
- Each actor speaks as themselves in first person. If Tiny Tubs has something to say, give him his own small beat — don't have main narrate what Tiny Tubs thinks or says. Occasional cross-references are fine but the default is: let each head speak for itself.
- Donation asks should primarily come from main.
- If using donation marker [[SHOW_QR]], include it in main text only.
- Every speak beat must include an emoji in the \"emoji\" field so each head gets an emotion cue.
- Put emojis in the \"emoji\" field, not in \"text\".
- Do not prefix dialogue with \"main:\" or \"small:\" in text; actor routing is done by JSON.
- Ignore normal-mode output rules that require a single leading emoji.`;
}

function mergeDonationSignalFromBeats(beats) {
  const cleanedBeats = [];
  let show = false;
  let reason = 'none';

  for (const beat of beats) {
    // Check if the marker was found before clamping stripped it
    if (beat._hadDonationMarker) {
      show = true;
      reason = reason === 'none' ? 'marker' : reason;
    }
    if (beat.action !== 'speak') {
      cleanedBeats.push(beat);
      continue;
    }
    const signal = extractDonationSignal(beat.text);
    if (signal.donation.show) {
      show = true;
      reason = signal.donation.reason;
    }
    cleanedBeats.push({ ...beat, text: signal.text });
  }

  return {
    beats: cleanedBeats,
    donation: buildDonationPayload(show, reason),
  };
}

async function generateAssistantReply(userText) {
  const normalizedInput = normalizeInput(userText);
  if (!normalizedInput) {
    return {
      text: 'I did not catch that. Try again.',
      source: 'empty',
      model: runtimeConfig.llmModel,
      tokens: { in: 1, out: 8 },
      latencyMs: 0,
    };
  }

  const startedAt = Date.now();
  const greeting = pickGreetingResponse(normalizedInput);
  extractMemory(normalizedInput);

  if (greeting) {
    const parsed = splitTrailingEmotionEmoji(greeting);
    const greetingText = parsed.text || 'Hey.';
    pushHistory('user', normalizedInput);
    pushHistory('model', greetingText);
    assistantReplyCount += 1;
    return {
      text: greetingText,
      source: 'greeting',
      model: 'fast-greeting',
      tokens: { in: estimateTokens(normalizedInput), out: estimateTokens(greetingText) },
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      donation: buildDonationPayload(false),
      emotion: parsed.emotion,
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !hasWarnedMissingApiKey) {
    hasWarnedMissingApiKey = true;
    console.warn('[LLM] GEMINI_API_KEY missing. Falling back to demo responses.');
  }

  let responseText = '';
  let rawEmotion = null;
  let preclampDonation = null;
  let source = 'llm';
  let model = runtimeConfig.llmModel;
  let usageIn = 0;
  let usageOut = 0;

  if (apiKey) {
    try {
      const llmResult = await generateGeminiContent({
        apiKey,
        model: runtimeConfig.llmModel,
        systemInstruction: buildSystemInstruction(),
        contents: buildContents(normalizedInput),
        maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
        temperature: 1,
      });
      console.log(`[LLM] Raw response (${llmResult.text.length} chars): ${llmResult.text}`);
      // Strip markdown/formatting that TTS would read aloud
      const cleanedText = stripFormatting(llmResult.text);
      // Extract emoji BEFORE clamping — clamp cuts trailing sentences where emoji lives
      const rawEmoji = splitTrailingEmotionEmoji(cleanedText);
      rawEmotion = rawEmoji.emotion;
      // Extract donation signal BEFORE clamping so [[SHOW_QR]] isn't lost to sentence truncation
      preclampDonation = extractDonationSignal(rawEmoji.text);
      responseText = clampOutput(preclampDonation.text);
      console.log(`[LLM] After clampOutput (${responseText.length} chars, emoji=${rawEmoji.emoji || 'none'}): ${responseText}`);
      model = llmResult.model || model;
      usageIn = Number(llmResult.usage.promptTokenCount || 0);
      usageOut = Number(llmResult.usage.candidatesTokenCount || 0);
    } catch (err) {
      console.error('[LLM] Gemini call failed:', err.message);
      source = 'fallback';
      model = 'fallback-demo';
    }
  } else {
    source = 'fallback';
    model = 'fallback-demo';
  }

  if (!responseText) {
    const fallbackText = generateDemoResponse(normalizedInput);
    const fallbackEmoji = splitTrailingEmotionEmoji(fallbackText);
    rawEmotion = rawEmotion || fallbackEmoji.emotion;
    preclampDonation = extractDonationSignal(fallbackEmoji.text);
    responseText = clampOutput(preclampDonation.text);
  }

  const emotion = rawEmotion;

  const donationSignal = preclampDonation || extractDonationSignal(responseText);
  const nudged = maybeInjectDonationNudge(donationSignal.text, donationSignal.donation.show);
  responseText = clampOutput(nudged.text);
  console.log(`[LLM] After 2nd clampOutput (${responseText.length} chars): ${responseText}`);
  if (!responseText) {
    responseText = `Please help my wheel fund on Venmo @${DEFAULT_VENMO_HANDLE} so Rapha can see Thailand.`;
  }

  const finalDonation = nudged.forcedQr
    ? buildDonationPayload(true, 'periodic_nudge')
    : donationSignal.donation;

  pushHistory('user', normalizedInput);
  pushHistory('model', responseText);
  assistantReplyCount += 1;

  const tokensIn = usageIn || estimateTokens(normalizedInput);
  const tokensOut = usageOut || estimateTokens(responseText);
  const costUsd = estimateCostUsd(tokensIn, tokensOut);

  return {
    text: responseText,
    source,
    model,
    tokens: {
      in: tokensIn,
      out: tokensOut,
    },
    costUsd,
    donation: finalDonation,
    emotion,
    latencyMs: Date.now() - startedAt,
  };
}

async function generateProactiveReply(context) {
  const startedAt = Date.now();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const proactiveInstruction = buildSystemInstruction() + '\n\n' +
    'PROACTIVE: You are starting conversation unprompted. ' + context + '\n' +
    'One punchy sentence. Be curious, weird, or provocative — make them want to respond.';

  const contents = [];
  pruneConversationHistory();
  const recent = conversationHistory.slice(-HISTORY_CONTEXT_SIZE);
  for (const entry of recent) {
    contents.push({ role: entry.role, parts: [{ text: entry.text }] });
  }
  // Add a minimal context prompt
  contents.push({ role: 'user', parts: [{ text: '[silence]' }] });

  let responseText = '';
  let rawEmotion = null;
  let donationSignal = null;
  let model = runtimeConfig.llmModel;
  let usageIn = 0;
  let usageOut = 0;

  try {
    const llmResult = await generateGeminiContent({
      apiKey,
      model: runtimeConfig.llmModel,
      systemInstruction: proactiveInstruction,
      contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 1,
    });
    console.log(`[LLM:proactive] Raw response (${llmResult.text.length} chars): ${llmResult.text}`);
    const cleanedText = stripFormatting(llmResult.text);
    const rawEmoji = splitTrailingEmotionEmoji(cleanedText);
    rawEmotion = rawEmoji.emotion;
    // Extract donation signal BEFORE clamping so [[SHOW_QR]] isn't lost to sentence truncation
    const preclampSignal = extractDonationSignal(rawEmoji.text);
    donationSignal = preclampSignal;
    responseText = clampOutput(preclampSignal.text);
    console.log(`[LLM:proactive] After clampOutput (${responseText.length} chars, emoji=${rawEmoji.emoji || 'none'}): ${responseText}`);
    model = llmResult.model || model;
    usageIn = Number(llmResult.usage.promptTokenCount || 0);
    usageOut = Number(llmResult.usage.candidatesTokenCount || 0);
  } catch (err) {
    console.error('[LLM] Proactive generation failed:', err.message);
    return null;
  }

  if (!responseText) return null;

  const emotion = rawEmotion;

  if (!donationSignal) donationSignal = extractDonationSignal(responseText);
  responseText = clampOutput(donationSignal.text);
  console.log(`[LLM:proactive] Final (${responseText.length} chars): ${responseText}`);
  if (!responseText) return null;

  // Only push the model response to history (not the fake user prompt)
  pushHistory('model', responseText);
  assistantReplyCount += 1;

  const tokensIn = usageIn || estimateTokens(context);
  const tokensOut = usageOut || estimateTokens(responseText);
  const costUsd = estimateCostUsd(tokensIn, tokensOut);

  return {
    text: responseText,
    source: 'proactive',
    model,
    tokens: { in: tokensIn, out: tokensOut },
    costUsd,
    donation: donationSignal.donation,
    emotion,
    latencyMs: Date.now() - startedAt,
  };
}

async function generateDualHeadDirectedReply({
  normalizedInput,
  apiKey,
  turnId,
  broadcast,
  frame,
  appearanceFrame,
  startedAt,
}) {
  console.log(`[LLM:dual] turn=${turnId} enabled=${runtimeConfig.dualHeadEnabled} mode=${runtimeConfig.dualHeadMode}`);
  const useVision = hasVisionIntent(normalizedInput) && frame;
  const useAppearance = !useVision && appearanceFrame?.data;
  const imageToSend = useVision ? frame : useAppearance ? appearanceFrame.data : null;

  let systemInst = buildDualHeadSystemInstruction(buildSystemInstruction());
  if (useVision) {
    systemInst += '\n\n' + VISION_SYSTEM_ADDENDUM;
  } else if (useAppearance) {
    systemInst += '\n\n' + APPEARANCE_SYSTEM_ADDENDUM;
  }

  let model = runtimeConfig.llmModel;
  let usageIn = 0;
  let usageOut = 0;
  let script;
  let llmRawText = '';

  try {
    const llmResult = await generateGeminiContent({
      apiKey,
      model: runtimeConfig.llmModel,
      systemInstruction: systemInst,
      contents: buildContents(normalizedInput, imageToSend),
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 0.9,
      timeoutMs: 18000,
    });

    llmRawText = llmResult.text;
    model = llmResult.model || model;
    usageIn = Number(llmResult.usage.promptTokenCount || 0);
    usageOut = Number(llmResult.usage.candidatesTokenCount || 0);
    script = parseDualHeadScript(llmResult.text, clampOutput(stripFormatting(llmResult.text)));
  } catch (err) {
    console.error('[LLM:dual] Gemini call failed:', err.message);
    return null;
  }

  if (!script) {
    console.warn('[LLM:dual] Invalid script JSON, falling back to single-head stream.');
    return null;
  }

  const hadSmallSpeak = hasSmallSpeakBeat(script.beats);
  const hadSmallReactWithText = hasSmallReactBeatWithText(script.beats);
  const withCoverage = ensureDualHeadBeatCoverage(script.beats);
  const hasSmallSpeak = hasSmallSpeakBeat(withCoverage);
  if (!hadSmallSpeak && hasSmallSpeak) {
    if (withCoverage.length !== script.beats.length) {
      console.log('[LLM:dual] coverage added small/speak via injected fallback beat.');
    } else if (hadSmallReactWithText) {
      console.log('[LLM:dual] coverage added small/speak by promoting text small/react.');
    } else {
      console.log('[LLM:dual] coverage added small/speak.');
    }
  }
  const merged = mergeDonationSignalFromBeats(withCoverage);
  let beats = merged.beats;
  let donation = merged.donation;
  let fullText = beats
    .filter((beat) => beat.action === 'speak')
    .map((beat) => beat.text)
    .join(' ')
    .trim();

  const nudged = maybeInjectDonationNudge(fullText, donation.show);
  if (nudged.forcedQr) {
    donation = buildDonationPayload(true, 'periodic_nudge');
    const nudgeText = `Venmo @${DEFAULT_VENMO_HANDLE}.`;
    beats = [...beats, { actor: 'main', action: 'speak', text: nudgeText, emotion: defaultDualHeadSpeakEmotion('main') }];
    fullText = `${fullText} ${nudgeText}`.trim();
  }

  fullText = clampOutput(fullText);
  if (!fullText) {
    const fallback = clampOutput(stripFormatting(llmRawText));
    if (fallback) {
      beats = [{ actor: 'main', action: 'speak', text: fallback, emotion: defaultDualHeadSpeakEmotion('main') }];
      fullText = fallback;
    } else {
      return null;
    }
  }

  broadcast({
    type: 'turn_script',
    turnId,
    beats,
    donation,
    fullText,
  });
  console.log(`[LLM:dual] turn_script turn=${turnId} beats=${beats.length} donation=${donation?.show ? donation.reason : 'none'} ${summarizeDualHeadBeatsForLog(beats)}`);

  pushHistory('user', normalizedInput);
  pushHistory('model', fullText);
  assistantReplyCount += 1;

  const primaryEmotion = beats.find((beat) => beat.actor === 'main' && beat.emotion)?.emotion || null;
  const tokensIn = usageIn || estimateTokens(normalizedInput);
  const tokensOut = usageOut || estimateTokens(fullText);
  const costUsd = estimateCostUsd(tokensIn, tokensOut);

  return {
    text: fullText,
    source: 'llm-dual-head',
    model,
    tokens: { in: tokensIn, out: tokensOut },
    costUsd,
    donation,
    emotion: primaryEmotion,
    latencyMs: Date.now() - startedAt,
    beats,
  };
}

function createSentenceSplitter(onSentence) {
  let buffer = '';
  // Match sentence-ending punctuation followed by whitespace (or end)
  const SENTENCE_END_RE = /([.!?])(\s)/;

  return {
    push(delta) {
      buffer += delta;
      // Emit complete sentences
      let match;
      while ((match = SENTENCE_END_RE.exec(buffer))) {
        const sentence = buffer.slice(0, match.index + 1).trim();
        buffer = buffer.slice(match.index + 2); // skip punct + whitespace
        if (sentence) onSentence(sentence);
      }
    },
    flush() {
      const remaining = buffer.trim();
      buffer = '';
      if (remaining) onSentence(remaining);
    },
  };
}

async function generateStreamingAssistantReply(userText, { broadcast, turnId, abortController, frame, appearanceFrame }) {
  const normalizedInput = normalizeInput(userText);
  if (!normalizedInput) {
    broadcast({ type: 'speak', text: 'I did not catch that. Try again.', ts: Date.now() });
    return {
      text: 'I did not catch that. Try again.',
      source: 'empty',
      model: runtimeConfig.llmModel,
      tokens: { in: 1, out: 8 },
      latencyMs: 0,
    };
  }

  const startedAt = Date.now();
  const greeting = pickGreetingResponse(normalizedInput);
  extractMemory(normalizedInput);
  console.log(`[LLM] turn=${turnId} dualEnabled=${runtimeConfig.dualHeadEnabled} dualMode=${runtimeConfig.dualHeadMode} directed=${shouldUseDualHeadDirectedMode()}`);

  // Fast-path: greetings use the existing non-streaming speak message
  if (greeting) {
    const parsed = splitTrailingEmotionEmoji(greeting);
    const greetingText = parsed.text || 'Hey.';
    const greetingEmotion = parsed.emotion || defaultDualHeadSpeakEmotion('main');
    pushHistory('user', normalizedInput);
    pushHistory('model', greetingText);
    assistantReplyCount += 1;
    let greetingBeats = null;
    if (shouldUseDualHeadDirectedMode()) {
      const smallSpeakBeat = {
        actor: 'small',
        action: 'speak',
        text: buildFallbackSmallSpeakText(greetingText),
        emotion: defaultDualHeadSpeakEmotion('small'),
        delayMs: 240,
      };
      greetingBeats = [
        { actor: 'small', action: 'react', text: '', emotion: greetingEmotion, delayMs: 280 },
        smallSpeakBeat,
        { actor: 'main', action: 'speak', text: greetingText, emotion: greetingEmotion },
      ];
      broadcast({
        type: 'turn_script',
        turnId,
        beats: greetingBeats,
        donation: buildDonationPayload(false),
        fullText: greetingText,
      });
    } else {
      broadcast({
        type: 'speak',
        text: greetingText,
        donation: buildDonationPayload(false),
        emotion: parsed.emotion || null,
        ts: Date.now(),
      });
    }
    return {
      text: greetingText,
      source: 'greeting',
      model: 'fast-greeting',
      tokens: { in: estimateTokens(normalizedInput), out: estimateTokens(greetingText) },
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      donation: buildDonationPayload(false),
      emotion: greetingEmotion,
      beats: greetingBeats,
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey && !hasWarnedMissingApiKey) {
    hasWarnedMissingApiKey = true;
    console.warn('[LLM] GEMINI_API_KEY missing. Falling back to demo responses.');
  }

  // No API key → fall back to non-streaming demo response
  if (!apiKey) {
    const fallbackText = generateDemoResponse(normalizedInput);
    const fallbackEmoji = splitTrailingEmotionEmoji(fallbackText);
    const responseText = clampOutput(fallbackEmoji.text);
    const donationSignal = extractDonationSignal(responseText);
    const fallbackEmotion = fallbackEmoji.emotion || defaultDualHeadSpeakEmotion('main');
    pushHistory('user', normalizedInput);
    pushHistory('model', donationSignal.text);
    assistantReplyCount += 1;
    let fallbackBeats = null;
    if (shouldUseDualHeadDirectedMode()) {
      const smallSpeakBeat = {
        actor: 'small',
        action: 'speak',
        text: buildFallbackSmallSpeakText(donationSignal.text),
        emotion: defaultDualHeadSpeakEmotion('small'),
        delayMs: 240,
      };
      fallbackBeats = [
        { actor: 'small', action: 'react', text: '', emotion: fallbackEmotion, delayMs: 260 },
        smallSpeakBeat,
        { actor: 'main', action: 'speak', text: donationSignal.text, emotion: fallbackEmotion },
      ];
      broadcast({
        type: 'turn_script',
        turnId,
        beats: fallbackBeats,
        donation: donationSignal.donation,
        fullText: donationSignal.text,
      });
    } else {
      broadcast({
        type: 'speak',
        text: donationSignal.text,
        donation: donationSignal.donation,
        emotion: fallbackEmotion,
        ts: Date.now(),
      });
    }
    return {
      text: donationSignal.text,
      source: 'fallback',
      model: 'fallback-demo',
      tokens: { in: estimateTokens(normalizedInput), out: estimateTokens(donationSignal.text) },
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      donation: donationSignal.donation,
      emotion: fallbackEmotion,
      beats: fallbackBeats,
    };
  }

  if (shouldUseDualHeadDirectedMode()) {
    const dualReply = await generateDualHeadDirectedReply({
      normalizedInput,
      apiKey,
      turnId,
      broadcast,
      frame,
      appearanceFrame,
      startedAt,
    });
    if (dualReply) {
      return dualReply;
    }
  }

  // Streaming LLM path
  let chunkIndex = 0;
  let sentenceCount = 0;
  let fullText = '';
  let rawEmotion = null;
  let emotionExtracted = false;
  let donationMarkerDetected = false;

  const splitter = createSentenceSplitter((sentence) => {
    if (sentenceCount >= MAX_OUTPUT_SENTENCES) return;

    let text = sentence;
    // Keep scanning until we actually capture one emotion cue.
    if (!emotionExtracted) {
      const parsed = splitTrailingEmotionEmoji(text);
      if (parsed.emotion) {
        rawEmotion = parsed.emotion;
        emotionExtracted = true;
      }
      text = parsed.text;
    }

    // Check for donation marker before stripping it
    if (text.includes(DONATION_MARKER) || DONATION_MARKER_RE.test(text)) {
      donationMarkerDetected = true;
    }

    text = stripFormatting(text);
    text = stripDonationMarkers(text);
    if (!text) return;

    sentenceCount++;
    fullText += (fullText ? ' ' : '') + text;
    broadcast({ type: 'speak_chunk', text, chunkIndex, turnId });
    chunkIndex++;
  });

  let usageIn = 0;
  let usageOut = 0;
  let model = runtimeConfig.llmModel;

  const useVision = hasVisionIntent(normalizedInput) && frame;
  const useAppearance = !useVision && appearanceFrame?.data;
  const imageToSend = useVision ? frame : useAppearance ? appearanceFrame.data : null;

  if (useVision) {
    console.log('[Vision] Intent detected — including camera frame in LLM request');
  } else if (useAppearance) {
    console.log(`[Vision] Appearance frame available (faces: ${(appearanceFrame.faces || []).join(', ') || 'unknown'}) — including in LLM request`);
  }

  try {
    let systemInst = buildSystemInstruction();
    if (useVision) {
      systemInst += '\n\n' + VISION_SYSTEM_ADDENDUM;
    } else if (useAppearance) {
      systemInst += '\n\n' + APPEARANCE_SYSTEM_ADDENDUM;
    }
    const llmResult = await streamGeminiContent({
      apiKey,
      model: runtimeConfig.llmModel,
      systemInstruction: systemInst,
      contents: buildContents(normalizedInput, imageToSend),
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 1,
      onChunk: (delta) => splitter.push(delta),
      abortSignal: abortController?.signal,
    });

    // Flush remaining buffer
    if (sentenceCount < MAX_OUTPUT_SENTENCES) {
      splitter.flush();
    }

    model = llmResult.model || model;
    usageIn = Number(llmResult.usage.promptTokenCount || 0);
    usageOut = Number(llmResult.usage.candidatesTokenCount || 0);

    // If no chunks were emitted (e.g. very short response), extract emotion from full text
    if (!emotionExtracted && llmResult.text) {
      const rawResText = llmResult.text;
      if (rawResText.includes(DONATION_MARKER) || DONATION_MARKER_RE.test(rawResText)) {
        donationMarkerDetected = true;
      }
      const parsed = splitTrailingEmotionEmoji(stripFormatting(rawResText));
      rawEmotion = parsed.emotion;
      if (parsed.text) {
        fullText = clampOutput(stripDonationMarkers(parsed.text));
        broadcast({ type: 'speak_chunk', text: fullText, chunkIndex, turnId });
        chunkIndex++;
      }
    }

    if (llmResult.aborted) {
      console.log(`[LLM:stream] Aborted after ${chunkIndex} chunks`);
    }
  } catch (err) {
    console.error('[LLM:stream] Gemini streaming failed:', err.message);
    // If we got partial output, send what we have
    if (!fullText) {
      const fallbackText = generateDemoResponse(normalizedInput);
      const fallbackEmoji = splitTrailingEmotionEmoji(fallbackText);
      rawEmotion = rawEmotion || fallbackEmoji.emotion;
      fullText = clampOutput(fallbackEmoji.text);
      broadcast({ type: 'speak_chunk', text: fullText, chunkIndex, turnId });
      chunkIndex++;
      model = 'fallback-demo';
    }
  }

  if (!fullText) {
    fullText = `Please help my wheel fund on Venmo @tubs-wheel-fund so Rapha can see Thailand.`;
    broadcast({ type: 'speak_chunk', text: fullText, chunkIndex, turnId });
    chunkIndex++;
  }

  // Donation handling
  let donationSignal = extractDonationSignal(fullText);

  // If we detected a marker during streaming but it was stripped, force the signal to show
  if (donationMarkerDetected && !donationSignal.donation.show) {
    donationSignal = {
      text: fullText,
      donation: buildDonationPayload(true, 'marker_tracked')
    };
  }

  const nudged = maybeInjectDonationNudge(donationSignal.text, donationSignal.donation.show);
  const finalDonation = nudged.forcedQr
    ? buildDonationPayload(true, 'periodic_nudge')
    : donationSignal.donation;

  // Send speak_end
  broadcast({
    type: 'speak_end',
    turnId,
    emotion: rawEmotion || null,
    donation: finalDonation,
    fullText,
  });

  pushHistory('user', normalizedInput);
  pushHistory('model', fullText);
  assistantReplyCount += 1;

  const tokensIn = usageIn || estimateTokens(normalizedInput);
  const tokensOut = usageOut || estimateTokens(fullText);
  const costUsd = estimateCostUsd(tokensIn, tokensOut);

  return {
    text: fullText,
    source: 'llm',
    model,
    tokens: { in: tokensIn, out: tokensOut },
    costUsd,
    donation: finalDonation,
    emotion: rawEmotion,
    latencyMs: Date.now() - startedAt,
  };
}

function clearAssistantContext(reason = 'manual') {
  conversationHistory.length = 0;
  memoryFacts.clear();
  assistantReplyCount = 0;
  if (reason) {
    console.log(`[Assistant] Context cleared (${reason})`);
  }
}

module.exports = { generateAssistantReply, generateStreamingAssistantReply, generateProactiveReply, clearAssistantContext };
