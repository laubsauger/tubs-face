const {
  DUAL_HEAD_ACTORS,
  DUAL_HEAD_ACTIONS,
  DUAL_HEAD_MAX_BEATS,
  DONATION_MARKER_RE,
} = require('./constants');
const {
  normalizeInput,
  stripFormatting,
  clampOutput,
  stripEmojiClusters,
  extractJsonBlock,
} = require('./text');
const {
  splitTrailingEmotionEmoji,
  pickSupportedEmotionEmoji,
  buildEmotionFromEmoji,
  defaultDualHeadSpeakEmotion,
} = require('./emotion');
const {
  stripDonationMarkers,
  extractDonationSignal,
  buildDonationPayload,
} = require('./donation');
const { runtimeConfig } = require('../config');

function isDualHeadActive() {
  return runtimeConfig.dualHeadEnabled === true && runtimeConfig.dualHeadMode !== 'off';
}

function shouldUseDualHeadDirectedMode() {
  return runtimeConfig.dualHeadEnabled === true && runtimeConfig.dualHeadMode === 'llm_directed';
}

function buildTwoHeadAwarenessInstruction() {
  const mode = runtimeConfig.dualHeadMode || 'off';
  const turnPolicy = runtimeConfig.dualHeadTurnPolicy || 'llm_order';
  return [
    'Two-head mode is active.',
    `Runtime: mode=${mode}, turnPolicy=${turnPolicy}.`,
    'You are main Tubs. Tiny Tubs (your small side head) has his own voice and speaks through his own audio channel.',
    'Tiny Tubs will chime in on his own \u2014 you do not need to speak for him or include his lines.',
    'Prefer letting Tiny Tubs speak for himself rather than narrating what he says or thinks.',
    'Occasional cross-references are fine, but default to giving him his own lines.',
    'Do not mention implementation details (routing, windows, TTS voices, JSON, beats).',
    'YOUR output is plain text only \u2014 one emoji then your sentence. Do NOT output JSON.',
  ].join('\n');
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
  "beats": [
    { "actor": "main|small", "action": "speak|react", "text": "string", "emoji": "one of \u{1F642}\u{1F604}\u{1F60F}\u{1F97A}\u{1F622}\u{1F624}\u{1F916}\u{1FAF6}", "delayMs": 200 }
  ]
}

Rules:
- 1 to 5 beats total.
- small beats range from 1-word stabs ("Facts.") to full punchy sentences (up to 15 words). Mix it up \u2014 don't always go short.
- At least one speak beat is required.
- It is valid for only one actor to speak in a turn. Do not force both to speak every time.
- If unsure, fall back to exactly one beat:
  {"beats":[{"actor":"main","action":"speak","text":"short reply","emoji":"🙂"}]}
- Keep each beat concise: 1 sentence max per beat.
- Vary small's position: sometimes leading (speaks first), sometimes closing (last word), sometimes sandwiched between main beats.
- Use a clearly different speaking style per actor:
  - main = full thought / mission-forward
  - small = unfiltered side commentary, roasts, below-the-belt jabs, chaotic ad-libs. Tiny Tubs has no filter and says what main won't. He's the id. Creative, punchy, sometimes savage.
- Each actor speaks as themselves in first person. If Tiny Tubs has something to say, give him his own small beat \u2014 don't have main narrate what Tiny Tubs thinks or says. Occasional cross-references are fine but the default is: let each head speak for itself.
- Donation asks should primarily come from main.
- If using donation marker [[SHOW_QR]], include it in main text only.
- Every speak beat should include an emoji in the "emoji" field so each head gets an emotion cue.
- Put emojis in the "emoji" field, not in "text".
- Output one JSON object only and end immediately after the closing brace.
- Output MUST be valid JSON parseable by JSON.parse (double quotes, no trailing commas).
- First character must be "{" and last character must be "}".
- No markdown fences, no commentary, no labels before/after JSON.
- No keys other than actor, action, text, emoji, delayMs.
- Do not prefix dialogue with "main:" or "small:" in text; actor routing is done by JSON.
- Ignore normal-mode output rules that require a single leading emoji.`;
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

function hasRequiredDualHeadCoverage(beats) {
  if (!Array.isArray(beats) || !beats.length) return false;
  return beats.some((beat) => beat.action === 'speak' && normalizeInput(beat.text || '').length > 0);
}

function parseDualHeadScript(rawText) {
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

  if (!hasRequiredDualHeadCoverage(beats)) return null;
  const ordered = reorderDualHeadBeats(beats);
  return { beats: ordered, raw: parsed };
}

/**
 * Try to rescue individual beats (with actor info) from malformed JSON using regex.
 * Returns a script object { beats, raw } or null if nothing useful found.
 */
function rescueBeatsFromRawText(rawText) {
  const text = String(rawText || '');
  const decodeJsonString = (value) => String(value || '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .trim();

  const beats = [];
  const actorRe = /"actor"\s*:\s*"(main|small)"/gi;
  const actorMatches = [...text.matchAll(actorRe)];
  for (let i = 0; i < actorMatches.length; i++) {
    const actor = String(actorMatches[i][1] || 'main').toLowerCase() === 'small' ? 'small' : 'main';
    const start = actorMatches[i].index || 0;
    const nextStart = i + 1 < actorMatches.length ? (actorMatches[i + 1].index || text.length) : text.length;
    const chunk = text.slice(start, Math.min(text.length, nextStart + 180));

    const textMatch = chunk.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const actionMatch = chunk.match(/"action"\s*:\s*"(speak|react)"/i);
    const emojiMatch = chunk.match(/"emoji"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const delayMatch = chunk.match(/"delayMs"\s*:\s*(\d{2,5})/i);

    const rawBeatText = decodeJsonString(textMatch?.[1] || '');
    if (!rawBeatText || rawBeatText.length < 2) continue;
    const cleanText = clampOutput(stripFormatting(stripDonationMarkers(rawBeatText)));
    if (!cleanText) continue;

    const action = String(actionMatch?.[1] || 'speak').toLowerCase() === 'react' ? 'react' : 'speak';
    const emoji = decodeJsonString(emojiMatch?.[1] || '');
    const emotion = buildEmotionFromEmoji(pickSupportedEmotionEmoji(emoji)) || defaultDualHeadSpeakEmotion(actor);
    const parsedDelay = Number.parseInt(String(delayMatch?.[1] || ''), 10);
    const safeDelayMs = Number.isFinite(parsedDelay) ? Math.max(120, Math.min(2500, parsedDelay)) : undefined;

    beats.push({
      actor,
      action,
      text: cleanText,
      emotion,
      delayMs: safeDelayMs,
    });
  }

  if (beats.length === 0) {
    const linePattern = /(?:^|\n)\s*(main|small)\s*[:\-]\s*(.+?)(?=\n|$)/gi;
    let lineMatch;
    while ((lineMatch = linePattern.exec(text)) !== null) {
      const actor = String(lineMatch[1] || 'main').toLowerCase() === 'small' ? 'small' : 'main';
      const cleanText = clampOutput(stripFormatting(decodeJsonString(lineMatch[2] || '')));
      if (!cleanText) continue;
      beats.push({
        actor,
        action: 'speak',
        text: cleanText,
        emotion: defaultDualHeadSpeakEmotion(actor),
      });
    }
  }

  if (beats.length === 0) return null;
  console.log(`[LLM:rescue] Recovered ${beats.length} beats via regex from malformed JSON`);
  return { beats, raw: null };
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

function mergeDonationSignalFromBeats(beats) {
  const cleanedBeats = [];
  let show = false;
  let reason = 'none';

  for (const beat of beats) {
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

module.exports = {
  isDualHeadActive,
  shouldUseDualHeadDirectedMode,
  buildTwoHeadAwarenessInstruction,
  buildDualHeadSystemInstruction,
  normalizeScriptBeat,
  reorderDualHeadBeats,
  hasRequiredDualHeadCoverage,
  parseDualHeadScript,
  rescueBeatsFromRawText,
  summarizeDualHeadBeatForLog,
  summarizeDualHeadBeatsForLog,
  mergeDonationSignalFromBeats,
};
