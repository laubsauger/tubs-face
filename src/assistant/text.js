const {
  INPUT_CHAR_LIMIT,
  OUTPUT_CHAR_LIMIT,
  MAX_OUTPUT_SENTENCES,
  LLM_INPUT_COST_PER_MTOKENS,
  LLM_OUTPUT_COST_PER_MTOKENS,
} = require('./constants');

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

/**
 * If the LLM accidentally returned JSON when it should have returned plain text,
 * try to extract the actual speech text from it.
 */
function rescueTextFromJson(text) {
  const trimmed = String(text || '').trim();
  // Quick check: does this look like it might contain JSON beats?
  if (!trimmed.includes('"text"') && !trimmed.includes('"beats"')) return trimmed;

  // Try proper JSON parsing first
  try {
    const jsonBlock = extractJsonBlock(trimmed);
    if (jsonBlock) {
      const parsed = JSON.parse(jsonBlock);
      const beats = Array.isArray(parsed?.beats) ? parsed.beats : [];
      const texts = beats
        .filter((b) => b?.text && (b?.action === 'speak' || !b?.action))
        .map((b) => String(b.text).trim())
        .filter(Boolean);
      if (texts.length > 0) return texts.join(' ');
    }
  } catch {
    // JSON.parse failed — fall through to regex rescue
  }

  // Regex fallback: extract "text": "..." values even from malformed JSON
  const textMatches = [...trimmed.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
  if (textMatches.length > 0) {
    const rescued = textMatches
      .map((m) => m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim())
      .filter((t) => t.length > 2);
    if (rescued.length > 0) return rescued.join(' ');
  }

  return trimmed;
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

function clampOutput(text) {
  const normalized = normalizeInput(rescueTextFromJson(text));
  if (!normalized) return '';
  const sentenceCapped = limitSentenceCount(normalized, MAX_OUTPUT_SENTENCES);
  if (sentenceCapped.length <= OUTPUT_CHAR_LIMIT) return sentenceCapped;
  const shortened = sentenceCapped.slice(0, OUTPUT_CHAR_LIMIT);
  const cutAt = Math.max(shortened.lastIndexOf('.'), shortened.lastIndexOf('!'), shortened.lastIndexOf('?'));
  if (cutAt > 70) return shortened.slice(0, cutAt + 1).trim();
  return `${shortened.trim()}...`;
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

function stripEmojiClusters(text) {
  return normalizeInput(String(text || '').replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, ' '));
}

module.exports = {
  estimateTokens,
  normalizeInput,
  stripFormatting,
  extractJsonBlock,
  rescueTextFromJson,
  limitSentenceCount,
  clampOutput,
  compactForHistory,
  sanitizeRate,
  sanitizeTtlMs,
  estimateCostUsd,
  stripEmojiClusters,
};
