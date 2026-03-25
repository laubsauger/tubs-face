const OUTPUT_CHAR_LIMIT = 280;
const MAX_OUTPUT_SENTENCES = 2;
const INPUT_COST_PER_MTOKENS = Number.parseFloat(process.env.GEMINI_INPUT_COST_PER_MTOKENS || '0');
const OUTPUT_COST_PER_MTOKENS = Number.parseFloat(process.env.GEMINI_OUTPUT_COST_PER_MTOKENS || '0');

export function normalizeInput(text: string): string {
  return String(text).replace(/\s+/g, ' ').trim();
}

export function stripFormatting(text: string): string {
  return String(text)
    .replace(/\*{1,3}(.+?)\*{1,3}/g, '$1')
    .replace(/_{1,3}(.+?)_{1,3}/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripEmojiClusters(text: string): string {
  return normalizeInput(String(text).replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, ' '));
}

const SPEAKER_PREFIX_RE = /^(?:(?:main|small|mini|assistant|bot|tubs|speaker\s*[12])\s*[:\-]\s*)+/i;

export function stripSpeakerLabels(text: string): string {
  return String(text)
    .split(/\n+/)
    .map((line) => line.replace(SPEAKER_PREFIX_RE, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitize text for TTS: remove anything that isn't speakable prose.
 * Strips JSON wrappers, [[markers]], emojis, braces, quotes used as
 * structural JSON delimiters, and other non-speech characters.
 */
export function sanitizeForTts(text: string): string {
  return stripSpeakerLabels(String(text)
    .replace(/\[\[.*?\]\]/g, '')            // [[SHOW_QR]] etc.
    .replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, ' ')
    .replace(/[{}[\]"]/g, '')               // braces, brackets, double quotes
    .replace(/\s+/g, ' ')
    .trim());
}

/**
 * If the model wrapped the reply in a JSON object like {"text":"..."} or
 * {"main":"..."}, extract just the speech text. Otherwise return the input.
 */
export function unwrapJsonSpeechText(raw: string): string {
  const jsonBlock = extractJsonBlock(raw);
  if (!jsonBlock) {
    return raw;
  }

  try {
    const parsed = JSON.parse(jsonBlock) as Record<string, unknown>;
    for (const key of ['text', 'main', 'response', 'message', 'content']) {
      if (typeof parsed[key] === 'string' && parsed[key].trim()) {
        return parsed[key];
      }
    }
  } catch {
    // Not valid JSON; keep the original text.
  }

  return raw;
}

export function extractJsonBlock(text: string): string | null {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return null;
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    return fenced;
  }

  const start = raw.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (!char) {
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }

  return null;
}

export function clampOutput(text: string): string {
  const normalized = normalizeInput(text);
  if (!normalized) {
    return '';
  }

  const sentences = normalized.match(/[^.!?]+[.!?]?/g) ?? [normalized];
  const limited = sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, MAX_OUTPUT_SENTENCES)
    .join(' ')
    .trim();

  if (limited.length <= OUTPUT_CHAR_LIMIT) {
    return limited;
  }

  const shortened = limited.slice(0, OUTPUT_CHAR_LIMIT);
  const sentenceEnd = Math.max(shortened.lastIndexOf('.'), shortened.lastIndexOf('!'), shortened.lastIndexOf('?'));
  if (sentenceEnd > 70) {
    return shortened.slice(0, sentenceEnd + 1).trim();
  }
  return `${shortened.trim()}...`;
}

export function estimateTokens(text: string): number {
  const normalized = normalizeInput(text);
  if (!normalized) {
    return 1;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function estimateCostUsd(tokensIn: number, tokensOut: number): number {
  const inputRate = sanitizeRate(INPUT_COST_PER_MTOKENS);
  const outputRate = sanitizeRate(OUTPUT_COST_PER_MTOKENS);
  const inCost = (tokensIn / 1_000_000) * inputRate;
  const outCost = (tokensOut / 1_000_000) * outputRate;
  return Number((inCost + outCost).toFixed(8));
}

function sanitizeRate(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}
