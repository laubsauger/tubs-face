const HISTORY_CONTEXT_SIZE = 6;
const HISTORY_STORE_LIMIT = 24;
const HISTORY_TTL_MS = Number.parseInt(process.env.ASSISTANT_HISTORY_TTL_MS || '240000', 10);
const MEMORY_LIMIT = 8;
const MEMORY_CONTEXT_SIZE = 4;
const MEMORY_TTL_MS = Number.parseInt(process.env.ASSISTANT_MEMORY_TTL_MS || '360000', 10);
const INPUT_CHAR_LIMIT = 800;
const OUTPUT_CHAR_LIMIT = 280;
const MAX_OUTPUT_SENTENCES = 2;
const VISION_INTENT_RE = /\b(what do you see|what('s| is) (this|that|in front|around|over there)|what am i (holding|wearing|doing|showing|eating|drinking)|look at (this|that|me)|can you see|who am i|who is (this|that)|read (this|that|it|the)|how many (fingers|people|things)|describe (this|that|what)|tell me what you see|check (this|that) out|do you see|do i look|what color|what does it say|is (this|that) a)\b/i;
const VISION_SYSTEM_ADDENDUM = `You can see right now — an image is attached showing what's in front of you. React to what you ACTUALLY see. Don't say "I see an image" or "in the image" — just react like you're looking at it. Be specific about real details. Roast what's funny. Comment on what's interesting. Stay in character as Tubs.`;
const APPEARANCE_SYSTEM_ADDENDUM = `An image of the person you're talking to is attached. You can subtly reference what you see — what they're wearing, holding, their vibe — to make the conversation feel personal. Don't describe the image or announce that you can see them. Just weave in a detail naturally if it fits, like you're talking to someone you can see. Keep it casual.`;
const DONATION_MARKER = '[[SHOW_QR]]';
const DONATION_MARKER_RE = /\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/i;
const DONATION_KEYWORDS = /\b(venmo|paypal|cash\s*app|donat(?:e|ion|ions|ing)|fundrais(?:er|ing)|wheel(?:s|chair)?(?:\s+fund)?|qr\s*code|chip\s*in|contribut(?:e|ion)|spare\s*change|support\s+(?:me|tubs|the\s+fund)|sponsor|tip(?:s|ping)?|money|fund(?:s|ing|ed)?|beg(?:ging)?|please\s+(?:help|give|support)|give\s+(?:me\s+)?money|rapha|thailand|help\s+(?:me|tubs|out)|need(?:s)?\s+(?:your\s+)?(?:help|money|support|funds))\b/i;
const DONATION_NUDGE_INTERVAL = 6;
const DEFAULT_VENMO_HANDLE = process.env.DONATION_VENMO || 'TubsBot';
const DEFAULT_DONATION_QR_DATA = process.env.DONATION_QR_DATA || `https://venmo.com/${DEFAULT_VENMO_HANDLE}`;
const LLM_INPUT_COST_PER_MTOKENS = Number.parseFloat(process.env.GEMINI_INPUT_COST_PER_MTOKENS || '0');
const LLM_OUTPUT_COST_PER_MTOKENS = Number.parseFloat(process.env.GEMINI_OUTPUT_COST_PER_MTOKENS || '0');
const EMOJI_EMOTION_MAP = Object.freeze({
  '\u{1F642}': {
    label: 'warm_friendly',
    expression: 'smile',
    impulse: { pos: 0.58, neg: 0.06, arousal: 0.34 },
  },
  '\u{1F604}': {
    label: 'joy_excited',
    expression: 'happy',
    impulse: { pos: 0.9, neg: 0.02, arousal: 0.78 },
  },
  '\u{1F60F}': {
    label: 'sassy_playful',
    expression: 'smile',
    impulse: { pos: 0.5, neg: 0.16, arousal: 0.48 },
  },
  '\u{1F97A}': {
    label: 'pleading_soft',
    expression: 'sad',
    impulse: { pos: 0.36, neg: 0.26, arousal: 0.36 },
  },
  '\u{1F622}': {
    label: 'sad_hurt',
    expression: 'sad',
    impulse: { pos: 0.12, neg: 0.82, arousal: 0.42 },
  },
  '\u{1F624}': {
    label: 'fired_up',
    expression: 'sad',
    impulse: { pos: 0.24, neg: 0.56, arousal: 0.82 },
  },
  '\u{1F916}': {
    label: 'robot_deadpan',
    expression: 'thinking',
    impulse: { pos: 0.32, neg: 0.1, arousal: 0.2 },
  },
  '\u{1FAF6}': {
    label: 'grateful_love',
    expression: 'love',
    impulse: { pos: 0.82, neg: 0.02, arousal: 0.46 },
  },
});
const EMOJI_GUIDE_LINES = [
  '\u{1F642} = warm/friendly',
  '\u{1F604} = excited joy',
  '\u{1F60F} = sassy/playful',
  '\u{1F97A} = pleading/soft',
  '\u{1F622} = sad/hurt',
  '\u{1F624} = fired up/intense',
  '\u{1F916} = deadpan robot',
  '\u{1FAF6} = grateful/love',
];
const DUAL_HEAD_ACTORS = new Set(['main', 'small']);
const DUAL_HEAD_ACTIONS = new Set(['speak', 'react']);
const DUAL_HEAD_MAX_BEATS = 7;
const DUAL_HEAD_DEFAULT_EMOJI_PROFILE_BY_ACTOR = Object.freeze({
  main: Object.freeze(['\u{1F642}', '\u{1F604}', '\u{1F916}']),
  small: Object.freeze(['\u{1F60F}', '\u{1F642}', '\u{1F604}']),
});
const DUAL_HEAD_RESPONSE_SCHEMA = Object.freeze({
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
          emoji: { type: 'STRING', enum: ['\u{1F642}', '\u{1F604}', '\u{1F60F}', '\u{1F97A}', '\u{1F622}', '\u{1F624}', '\u{1F916}', '\u{1FAF6}'] },
          delayMs: { type: 'NUMBER' },
        },
        required: ['actor', 'action', 'text', 'emoji'],
      },
    },
  },
  required: ['beats'],
});
const TRAILING_PUNCT_RE = /[.!?]+\s*$/;
const TRAILING_EMOJI_CLUSTER_RE = /(?:\s*)(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*$/u;
const LEADING_EMOJI_RE = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;

function hasVisionIntent(text) {
  return VISION_INTENT_RE.test(String(text || ''));
}

module.exports = {
  HISTORY_CONTEXT_SIZE,
  HISTORY_STORE_LIMIT,
  HISTORY_TTL_MS,
  MEMORY_LIMIT,
  MEMORY_CONTEXT_SIZE,
  MEMORY_TTL_MS,
  INPUT_CHAR_LIMIT,
  OUTPUT_CHAR_LIMIT,
  MAX_OUTPUT_SENTENCES,
  VISION_INTENT_RE,
  VISION_SYSTEM_ADDENDUM,
  APPEARANCE_SYSTEM_ADDENDUM,
  DONATION_MARKER,
  DONATION_MARKER_RE,
  DONATION_KEYWORDS,
  DONATION_NUDGE_INTERVAL,
  DEFAULT_VENMO_HANDLE,
  DEFAULT_DONATION_QR_DATA,
  LLM_INPUT_COST_PER_MTOKENS,
  LLM_OUTPUT_COST_PER_MTOKENS,
  EMOJI_EMOTION_MAP,
  EMOJI_GUIDE_LINES,
  DUAL_HEAD_ACTORS,
  DUAL_HEAD_ACTIONS,
  DUAL_HEAD_MAX_BEATS,
  DUAL_HEAD_DEFAULT_EMOJI_PROFILE_BY_ACTOR,
  DUAL_HEAD_RESPONSE_SCHEMA,
  TRAILING_PUNCT_RE,
  TRAILING_EMOJI_CLUSTER_RE,
  LEADING_EMOJI_RE,
  hasVisionIntent,
};
