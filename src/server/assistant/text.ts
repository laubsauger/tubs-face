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
