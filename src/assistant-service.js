const { runtimeConfig } = require('./config');
const { generateDemoResponse } = require('./demo-response');
const { loadSystemPrompt, pickGreetingResponse } = require('./persona');
const { generateGeminiContent } = require('./gemini-client');

const HISTORY_CONTEXT_SIZE = 6;
const HISTORY_STORE_LIMIT = 24;
const MEMORY_LIMIT = 8;
const MEMORY_CONTEXT_SIZE = 4;
const INPUT_CHAR_LIMIT = 800;
const OUTPUT_CHAR_LIMIT = 220;
const MAX_OUTPUT_SENTENCES = 2;
const DONATION_MARKER = '[[SHOW_QR]]';
const DONATION_KEYWORDS = /\b(venmo|donat(?:e|ion|ions|ing)|fundraiser|wheel fund|qr code|chip in|contribute|spare change)\b/i;
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
const TRAILING_PUNCT_RE = /[.!?]+\s*$/;
const TRAILING_EMOJI_CLUSTER_RE = /(?:\s*)(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*$/u;

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

function extractDonationSignal(text) {
  let cleaned = String(text || '');
  let show = false;
  let reason = 'none';

  if (cleaned.includes(DONATION_MARKER)) {
    show = true;
    reason = 'marker';
    cleaned = cleaned.split(DONATION_MARKER).join(' ');
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
  conversationHistory.push({ role, text: compact });
  while (conversationHistory.length > HISTORY_STORE_LIMIT) {
    conversationHistory.shift();
  }
}

function buildContents(nextUserText) {
  const recent = conversationHistory.slice(-HISTORY_CONTEXT_SIZE);
  const contents = recent.map((entry) => ({
    role: entry.role,
    parts: [{ text: entry.text }],
  }));
  contents.push({
    role: 'user',
    parts: [{ text: compactForHistory(nextUserText) }],
  });
  return contents;
}

function buildSystemInstruction() {
  const promptSections = [loadSystemPrompt()];
  const runtimePrompt = normalizeInput(runtimeConfig.prompt);
  if (runtimePrompt && runtimePrompt.toLowerCase() !== 'default personality') {
    promptSections.push(`Additional runtime instruction:\n${runtimePrompt}`);
  }

  const memoryContext = getMemoryContextText();
  if (memoryContext) {
    promptSections.push(`Known user facts:\n${memoryContext}`);
  }

  promptSections.push(
    [
      'Optional emotion emoji protocol (for face animation):',
      '- You may append an emoji only at the very end of the reply as the last character.',
      '- If you use an emoji, it MUST be exactly one from this supported set; otherwise use no emoji.',
      ...EMOJI_GUIDE_LINES.map((line) => `  - ${line}`),
      '- Do not place emoji mid-sentence. Do not add multiple emojis.',
    ].join('\n')
  );
  promptSections.push('Token budget policy: stay concise by default and avoid long preambles.');
  promptSections.push('Style guardrail: sound like natural casual speech, not an AI assistant.');
  return promptSections.join('\n\n');
}

function splitTrailingEmotionEmoji(text) {
  const normalized = normalizeInput(text);
  if (!normalized) {
    return {
      text: '',
      emoji: null,
      emotion: null,
    };
  }

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
    return {
      text: normalized,
      emoji: null,
      emotion: null,
    };
  }

  // Tolerant protocol:
  // - if multiple trailing emojis appear, use the last one
  // - emoji must still be from the supported set
  const emoji = trailingEmojis[trailingEmojis.length - 1];
  const mapped = EMOJI_EMOTION_MAP[emoji];
  if (!mapped) {
    return {
      text: `${core}${punctuation}`.trim(),
      emoji: null,
      emotion: null,
    };
  }

  return {
    text: `${core}${punctuation}`.trim(),
    emoji,
    emotion: {
      emoji,
      label: mapped.label,
      expression: mapped.expression,
      impulse: { ...mapped.impulse },
    },
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
        temperature: 0.45,
      });
      responseText = clampOutput(llmResult.text);
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
    responseText = clampOutput(generateDemoResponse(normalizedInput));
  }

  const parsedEmoji = splitTrailingEmotionEmoji(responseText);
  responseText = parsedEmoji.text;
  const emotion = parsedEmoji.emotion;

  const donationSignal = extractDonationSignal(responseText);
  const nudged = maybeInjectDonationNudge(donationSignal.text, donationSignal.donation.show);
  responseText = clampOutput(nudged.text);
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

module.exports = { generateAssistantReply };
