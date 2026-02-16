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
    'Language policy: respond in natural spoken English by default. Only switch language if the user explicitly asks for another language.'
  );

  promptSections.push(
    [
      'Face emoji: start every reply with exactly one emoji from this set, then a space, then text.',
      'Example: "\u{1F60F} You really thought you could walk past me?"',
      ...EMOJI_GUIDE_LINES.map((line) => `  ${line}`),
      'One emoji, first character only, no emoji elsewhere.',
    ].join('\n')
  );
  return promptSections.join('\n\n');
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
