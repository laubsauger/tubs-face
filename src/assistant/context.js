const {
  HISTORY_CONTEXT_SIZE,
  HISTORY_STORE_LIMIT,
  HISTORY_TTL_MS,
  MEMORY_LIMIT,
  MEMORY_CONTEXT_SIZE,
  MEMORY_TTL_MS,
  EMOJI_GUIDE_LINES,
} = require('./constants');
const { normalizeInput, compactForHistory, sanitizeTtlMs } = require('./text');
const { isDualHeadActive, buildTwoHeadAwarenessInstruction } = require('./dual-head');
const { runtimeConfig } = require('../config');
const { loadSystemPrompt } = require('../persona');

// ── Mutable state ──
const conversationHistory = [];
const memoryFacts = new Map();
let hasWarnedMissingApiKey = false;
let assistantReplyCount = 0;

// ── State accessors ──
function getAssistantReplyCount() { return assistantReplyCount; }
function incrementAssistantReplyCount() { assistantReplyCount += 1; }
function getHasWarnedMissingApiKey() { return hasWarnedMissingApiKey; }
function setHasWarnedMissingApiKey(v) { hasWarnedMissingApiKey = v; }

// ── Memory ──
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

// ── History ──
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

function getHistoryMeta() {
  pruneConversationHistory();
  const recent = conversationHistory.slice(-HISTORY_CONTEXT_SIZE);
  const historyChars = recent.reduce((sum, entry) => sum + String(entry?.text || '').length, 0);
  return {
    historyMessages: recent.length,
    historyChars,
  };
}

function getRecentHistory() {
  pruneConversationHistory();
  return conversationHistory.slice(-HISTORY_CONTEXT_SIZE);
}

function buildContents(nextUserText, imageBase64 = null, options = {}) {
  const { returnMeta = false } = options;
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
  if (!returnMeta) return contents;
  const historyChars = recent.reduce((sum, entry) => sum + String(entry?.text || '').length, 0);
  return {
    contents,
    historyMessages: recent.length,
    historyChars,
    imageAttached: Boolean(imageBase64),
  };
}

function buildProactiveContents() {
  pruneConversationHistory();
  const recent = conversationHistory.slice(-HISTORY_CONTEXT_SIZE);
  const contents = recent.map((entry) => ({
    role: entry.role,
    parts: [{ text: entry.text }],
  }));
  contents.push({ role: 'user', parts: [{ text: '[silence]' }] });
  return contents;
}

function sanitizeContentsForTelemetry(contents) {
  if (!Array.isArray(contents)) return [];
  return contents.map((msg) => ({
    role: msg?.role,
    parts: Array.isArray(msg?.parts)
      ? msg.parts.map((part) => {
        if (part?.inlineData?.data) {
          return {
            inlineData: {
              mimeType: part.inlineData.mimeType || 'image/jpeg',
              omitted: true,
              bytes: String(part.inlineData.data || '').length,
            },
          };
        }
        return { text: String(part?.text || '') };
      })
      : [],
  }));
}

function emitTurnContextMeta({ turnId, broadcast, timingHooks, meta }) {
  if (!meta) return;
  const payload = {
    mode: meta.mode || 'text',
    imageAttached: Boolean(meta.imageAttached),
    historyMessages: Number(meta.historyMessages || 0),
    historyChars: Number(meta.historyChars || 0),
  };
  if (timingHooks?.onContextMeta) {
    timingHooks.onContextMeta(payload);
  }
  if (turnId && typeof broadcast === 'function') {
    broadcast({
      type: 'turn_context',
      turnId,
      ...payload,
    });
  }
}

// ── System prompt ──
// ── System prompt ──
function buildSystemInstruction(mode = 'text') {
  const template = loadSystemPrompt();

  // --- New Template Logic ---
  let prompt = template;
  const isDualScript = mode === 'dual-script' && isDualHeadActive();
  const isDualActive = isDualHeadActive();

  prompt = prompt.replace('{{MODE_SUFFIX}}', isDualActive ? '(Dual-Head Mode)' : '');

  const charDynamics = isDualActive
    ? `- Main (Voice A): The "Face." Philosophical but broke. Mission-forward. Charming yet slightly desperate.\n- Small (Voice B): The "Id" (Tiny Tubs). Unfiltered, savage, and chaotic. He’s the one who’s been "watching telly" and hates everyone. Short, punchy jabs.`
    : `You are Tubs. Smart, sarcastic, and broke. Unhinged standup comic energy.`;
  prompt = prompt.replace('{{CHARACTER_DYNAMICS}}', charDynamics);

  prompt = prompt.replace('{{VISION_PROTOCOL_SECTION}}',
    `# VISION PROTOCOL\nReact to what you see (clothing, vibe, objects) like a real person. Don't describe the image; roast the fit or guess their "Ultimate Question" based on their look.`);

  const brevity = isDualActive
    ? `Main gets 1-2 sentences. Small gets 1-word stabs to punchy one-liners.`
    : `Keep it to 1-2 sentences. Brevity IS the personality.`;
  prompt = prompt.replace('{{BREVITY_RULE}}', brevity);

  const runtimePrompt = normalizeInput(runtimeConfig.prompt);
  if (runtimePrompt && runtimePrompt.toLowerCase() !== 'default personality') {
    prompt = prompt.replace('{{RUNTIME_INSTRUCTION}}', `# ADDITIONAL INSTRUCTION\n${runtimePrompt}`);
  } else {
    prompt = prompt.replace('{{RUNTIME_INSTRUCTION}}', '');
  }

  const memory = getMemoryContextText();
  if (memory) {
    prompt = prompt.replace('{{MEMORY_CONTEXT}}', `# MEMORY\n${memory}`);
  } else {
    prompt = prompt.replace('{{MEMORY_CONTEXT}}', '');
  }

  const outputHeader = isDualScript ? '(STRICT JSON ONLY)' : '(Text Only)';

  // Dual Script Rules
  const dualOutputInst = `Return STRICT JSON only. No markdown, no prose.
Schema:
{
  "beats": [
    { "actor": "main|small", "action": "speak|react", "text": "string", "emoji": "one of \u{1F642}\u{1F604}\u{1F60F}\u{1F97A}\u{1F622}\u{1F624}\u{1F916}\u{1FAF6}", "delayMs": 200 }
  ]
}

Rules:
- 1 to 5 beats total.
- Small beats range from 1-word stabs ("Facts.") to punchy sentences.
- At least one speak beat is required.
- "emoji" field is required for every speak beat; do NOT put emojis in the "text" field.
- Do not prefix dialogue with "main:" or "small:" in text.
- Ignore normal-mode output rules.`;

  // Single Text Rules
  const singleOutputInst = `Face emoji: start every reply with exactly one emoji from this set, then a space, then text.
Example: "\u{1F60F} You really thought you could walk past me?"
${EMOJI_GUIDE_LINES.map(l => '  ' + l).join('\n')}
One emoji, first character only, no emoji elsewhere.`;

  prompt = prompt.replace('{{OUTPUT_FORMAT_HEADER}}', outputHeader);
  prompt = prompt.replace('{{OUTPUT_FORMAT_INSTRUCTIONS}}', isDualScript ? dualOutputInst : singleOutputInst);

  return prompt;
}

// ── Reset ──
function clearAssistantContext(reason = 'manual') {
  conversationHistory.length = 0;
  memoryFacts.clear();
  assistantReplyCount = 0;
  if (reason) {
    console.log(`[Assistant] Context cleared (${reason})`);
  }
}

module.exports = {
  getAssistantReplyCount,
  incrementAssistantReplyCount,
  getHasWarnedMissingApiKey,
  setHasWarnedMissingApiKey,
  extractMemory,
  getMemoryContextText,
  pushHistory,
  pruneConversationHistory,
  getHistoryMeta,
  getRecentHistory,
  buildContents,
  buildProactiveContents,
  sanitizeContentsForTelemetry,
  emitTurnContextMeta,
  buildSystemInstruction,
  clearAssistantContext,
};
