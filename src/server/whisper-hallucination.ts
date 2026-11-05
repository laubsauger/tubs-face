import { deflateSync } from 'node:zlib';

/**
 * Detect common Whisper hallucinations — short phantom phrases the model
 * produces when fed silence or background noise.
 */
const WHISPER_HALLUCINATIONS = new Set([
  'thank you.',
  'thank you',
  'thanks.',
  'thanks',
  'thanks for watching.',
  'thanks for watching',
  'thank you for watching.',
  'thank you for watching',
  'bye.',
  'bye',
  'goodbye.',
  'goodbye',
  'you',
  'the end.',
  'the end',
  'subscribe.',
  'subscribe',
  'like and subscribe.',
  '.',
  '...',
  'you.',
  'hmm.',
  'hmm',
  'hm.',
  'huh.',
  'uh.',
  'um.',
  'oh.',
  'ah.',
  'i\'m sorry.',
  // Frequent phantoms in the Bag of Hallucinations study (Baranski et al. 2025),
  // from subtitle credits in Whisper's training data.
  'subtitles by the amara.org community',
  'thank you so much for watching!',
  'thank you so much for watching.',
  'please subscribe.',
  'see you next time.',
]);

// Whisper's own test for a looping transcript: text that compresses far better
// than speech does is the same phrase over and over ("I'm sorry. I'm sorry. ..."
// 29 times, heard live). Speech stays under ~1.8; Whisper retries above 2.4.
const MAX_COMPRESSION_RATIO = 2.4;
const MIN_LENGTH_FOR_RATIO = 40;

export function compressionRatio(text: string): number {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length / deflateSync(bytes).length;
}

export function isWhisperHallucination(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (WHISPER_HALLUCINATIONS.has(lower)) {
    return true;
  }
  if (lower.length >= MIN_LENGTH_FOR_RATIO && compressionRatio(lower) > MAX_COMPRESSION_RATIO) {
    return true;
  }
  // Pure punctuation / whitespace
  if (/^[\s.,!?…\-–—]+$/.test(lower)) {
    return true;
  }
  return false;
}
