// Room for two full sentences; 180 cut the second one off mid-thought.
const OUTPUT_CHAR_LIMIT = 240;
export const MAX_OUTPUT_SENTENCES = 2;
/** A bit (a short standup riff) needs room to build before the punchline lands. */
export const BIT_MAX_SENTENCES = 6;
const BIT_CHAR_LIMIT = 420;
const INPUT_COST_PER_MTOKENS = Number.parseFloat(process.env.GEMINI_INPUT_COST_PER_MTOKENS || '0');
const OUTPUT_COST_PER_MTOKENS = Number.parseFloat(process.env.GEMINI_OUTPUT_COST_PER_MTOKENS || '0');

export function normalizeInput(text: string): string {
  return String(text).replace(/\s+/g, ' ').trim();
}

export function stripFormatting(text: string): string {
  return String(text)
    // Hidden [[NOTE: ...]] / [[QUOTE: ...]] tags, and any stray [[MARKER]].
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    // The same tags with one bracket ("[NOTE: testing shit]") reached the subtitles.
    .replace(/\[\s*(?:NOTE|QUOTE|NAME)\b[^\]]*\]\]?/gi, ' ')
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

// Ming garbles words in capitals ("WITNESS PROTECTION NOW!" came out as noise)
// and reads digits badly ("204" as "24"). Common acronyms stay as they are.
const KEEP_CAPS = new Set(['AI', 'TV', 'OK', 'DJ', 'PC', 'VR', 'AR', 'UFO', 'USB', 'CEO', 'NFT', 'GPU', 'CPU', 'LED', 'ATM', 'DNA', 'FBI', 'CIA', 'NASA', 'BBQ', 'USA', 'UK', 'EU']);
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under100(n: number): string {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
}

function numberWords(n: number): string {
  if (n < 100) return under100(n);
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${under100(n % 100)}` : ''}`;
  return `${ONES[Math.floor(n / 1000)]} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
}

/** 2024 as "twenty twenty-four", 1905 as "nineteen oh-five", 2005 as "two thousand five". */
function yearWords(n: number): string {
  if (n >= 2000 && n < 2010) return numberWords(n);
  const low = n % 100;
  return `${under100(Math.floor(n / 100))} ${low === 0 ? 'hundred' : low < 10 ? `oh-${ONES[low]}` : under100(low)}`;
}

function speakableNumbers(text: string): string {
  // Whole numbers only: not times (10:30), decimals (87.4), 1,000 or 007.
  return text.replace(/(?<![\d.,:])\b(?:[1-9]\d{0,3}|0)\b(?![.,:]\d)/g, (digits) => {
    const n = Number(digits);
    return digits.length === 4 && n >= 1100 && n < 2100 ? yearWords(n) : numberWords(n);
  });
}

function withoutShouting(text: string): string {
  return text.replace(/\b[A-Z][A-Z']*[A-Z]\b/g, (word: string, offset: number) => {
    if (KEEP_CAPS.has(word)) return word;
    const lower = word.toLowerCase().replace(/^i(?=$|')/, 'I');
    return /(^|[.!?])\s*$/.test(text.slice(0, offset)) ? lower[0]!.toUpperCase() + lower.slice(1) : lower;
  });
}

/**
 * Sanitize text for TTS: remove anything that isn't speakable prose.
 * Strips JSON wrappers, [[markers]], emojis, braces, quotes used as
 * structural JSON delimiters, and other non-speech characters. Words in
 * capitals and digits are turned into something the voice can say.
 */
export function sanitizeForTts(text: string): string {
  const cleaned = String(text)
    .replace(/\[\[.*?\]\]/g, '')            // [[SHOW_QR]] etc.
    .replace(/\[[^\]]*\]/g, '')             // echoed notes like [cut off by the visitor]
    .replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, ' ')
    .replace(/[{}[\]"]/g, '')               // braces, brackets, double quotes
    .replace(/\b204\b/g, 'two-oh-four')    // the studio, said the way it's said there
    .replace(/\s+/g, ' ')
    .trim();
  return stripSpeakerLabels(speakableNumbers(withoutShouting(cleaned)));
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

/**
 * Streamed replies reach TTS in clause-sized chunks. The cap counts whole
 * sentences, so a reply never stops on a comma (it used to count chunks and
 * cut off "...judging by the dread in this room," mid-thought).
 */
export function createSentenceCap(max = MAX_OUTPUT_SENTENCES): (chunk: string) => boolean {
  let ended = 0;
  return (chunk) => {
    if (ended >= max) return false;
    if (/[.!?]["')\]]*$/.test(chunk.trim())) ended += 1;
    return true;
  };
}

export function clampOutput(text: string, maxSentences = MAX_OUTPUT_SENTENCES): string {
  const normalized = normalizeInput(text);
  if (!normalized) {
    return '';
  }

  const sentences = normalized.match(/[^.!?]+[.!?]?/g) ?? [normalized];
  const limited = sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, maxSentences)
    .join(' ')
    .trim();

  const charLimit = maxSentences > MAX_OUTPUT_SENTENCES ? BIT_CHAR_LIMIT : OUTPUT_CHAR_LIMIT;
  if (limited.length <= charLimit) {
    return limited;
  }

  const shortened = limited.slice(0, charLimit);
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
