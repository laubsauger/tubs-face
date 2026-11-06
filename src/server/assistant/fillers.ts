import { openTtsStream } from '../tts/stream.js';
import { isMingVoice, mingVoiceReady } from '../tts/voices.js';
import { joinWavChunks, wavDurationS } from '../tts/wav.js';

/**
 * A short sound ("Hmm.", "Right.") played the moment a voice turn starts.
 * After the visitor stops, about 1 s of quiet ends their turn; then the reply
 * needs another ~2 s after the clip arrives (Nov 2026, two heads with Ming:
 * Whisper 0.3 s, Gemini 1.5-2.7 s, Ming's first chunk 0.3 s), up from ~1.3 s
 * with one head on Kokoro. People expect a reaction within a few hundred
 * milliseconds; a filler makes the wait read as thinking rather than lag
 * (Shiwa et al. 2008). Played on some turns only, never twice in a row, so it
 * does not become a tic.
 */

// Kokoro (hm_omega) can't do a lone hum or hesitation sound: "Hm", "Mm",
// "Mhm", "Um" and "Ahm" all come out clipped or garbled, with plain spellings
// and phoneme overrides alike. The same sounds work as the start of a short
// phrase, so those are paired with a word. Kokoro's dictionary has no "Ähm"
// or "Ahm" (it drops them silently), hence the [word](/phonemes/) markup.
// No "Wow." or "Oh boy.": as a reaction to whatever was just said they sound
// wrong far more often than right.
export const KOKORO_FILLER_LINES = [
  'Oh.',
  'Okay.',
  'Right.',
  'Well.',
  'Um, okay.',
  'Hum, right.',
  'Uh, well.',
  '[Ähm](/ˈɛːm/), okay.',
  '[Ahm](/ˈɑːm/), right.',
] as const;

// Ming says the lone sounds Kokoro can't (voice lab run 16, checked with
// Whisper in both cloned voices). Left out: "Hm." (heard as "Damn."), "Uh."
// and "Uhh." (a groan), "Ha." and "Ahh." (a scream from Mini), "Ähm."
// (garbled), "Hmm?" (sounds like Tubs didn't hear). Ming renders with a fixed
// seed: one text, one sound, the same after a restart.
export const MING_FILLER_LINES = [
  'Hmm.',
  'Mm.',
  'Mhm.',
  'Um.',
  'Umm.',
  'Ah.',
  'Oh.',
  'Okay.',
  'Right.',
  'Well.',
  'So.',
  'Um, okay.',
  'Uh, well.',
  'Oh, right.',
  'Ah, okay.',
] as const;

export function fillerLinesFor(voice: string): readonly string[] {
  return isMingVoice(voice) ? MING_FILLER_LINES : KOKORO_FILLER_LINES;
}

// With the longer wait, more turns get one: about 37% of voice turns, as no
// turn right after a filler gets one (it was 0.4, about 29%).
export const FILLER_CHANCE = 0.6;
const PHONEME_MARKUP = /\[([^\]]+)\]\(\/[^)]*\/\)/g;
const RENDER_RETRY_MS = 60_000;
// Ming renders one line in about 0.6 s, slower while the GPU is busy.
const RENDER_TIMEOUT_MS = 60_000;
// The reply starts ~2 s after the filler; a longer one ("Ummm... okay.", 2.3 s)
// would still be going, or push the reply back.
export const MAX_FILLER_S = 1.5;

type Random = () => number;

export interface Filler {
  text: string;
  audio: string;
}

const clips = new Map<string, Filler[]>();
const rendering = new Map<string, Promise<boolean>>();
const lastRenderAttempt = new Map<string, number>();
let lastWasFiller = false;
let lastText = '';

/**
 * Renders all filler lines for a voice once. Resolves true when the voice has
 * fillers; failures leave it without and are retried at most once a minute.
 */
export function prepareFillers(voice: string, now = Date.now()): Promise<boolean> {
  if (clips.has(voice)) return Promise.resolve(true);
  const running = rendering.get(voice);
  if (running) return running;
  if (now - (lastRenderAttempt.get(voice) ?? -Infinity) < RENDER_RETRY_MS) return Promise.resolve(false);
  lastRenderAttempt.set(voice, now);
  const job = renderFillers(voice).finally(() => rendering.delete(voice));
  rendering.set(voice, job);
  return job;
}

/**
 * Renders the fillers as soon as the voice can be spoken, so the first turns
 * already have them and no turn shares the GPU with their render.
 */
export async function prepareFillersAtStartup(voice: string, options: { intervalMs?: number; attempts?: number } = {}): Promise<boolean> {
  const { intervalMs = 3_000, attempts = 60 } = options;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastRenderAttempt.delete(voice); // the once-a-minute limit is for turns, not for startup
    if (await prepareFillers(voice)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.warn(`[fillers] no fillers for ${voice}: its TTS never came up`);
  return false;
}

async function renderFillers(voice: string): Promise<boolean> {
  if (isMingVoice(voice) && !(await mingVoiceReady(voice))) return false;
  const startedAt = Date.now();
  const rendered: Filler[] = [];
  // Ming streams a line in several chunks; a filler plays as one clip, so they
  // are joined when the line is done. A line that never finishes is dropped.
  let lineText = '';
  let lineAudio: string[] = [];
  let pending = 0;
  let finish = (): void => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = openTtsStream({
    onChunk(chunk) {
      if (!chunk.text || !chunk.audio) return;
      lineText = chunk.text;
      lineAudio.push(chunk.audio);
    },
    onSentenceDone() {
      if (lineAudio.length > 0) {
        try {
          const audio = joinWavChunks(lineAudio);
          const seconds = wavDurationS(audio);
          if (seconds > MAX_FILLER_S) {
            console.log(`[fillers] left out "${lineText}": ${seconds.toFixed(2)} s is too long for a filler`);
          } else {
            // The text becomes the subtitle, so it shows the word, not the phonemes.
            rendered.push({ text: lineText.replace(PHONEME_MARKUP, '$1'), audio });
          }
        } catch (error) {
          console.warn(`[fillers] dropped "${lineText}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      lineAudio = [];
      pending -= 1;
      if (pending <= 0) finish();
    },
    onClose: () => finish(),
  });

  try {
    if (!(await session.opened)) return false;
    for (const line of fillerLinesFor(voice)) {
      pending += 1;
      session.send(line, voice);
    }
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, RENDER_TIMEOUT_MS))]);
    if (rendered.length === 0) return false;
    clips.set(voice, rendered);
    console.log(`[fillers] ${rendered.length} clips ready for ${voice} in ${Date.now() - startedAt}ms`);
    return true;
  } finally {
    session.close();
  }
}

/** The filler for this voice turn, or null when this turn goes without one. */
export function pickFiller(voice: string, random: Random = Math.random): Filler | null {
  const available = clips.get(voice);
  if (!available) {
    void prepareFillers(voice);
    return null;
  }
  if (lastWasFiller || random() >= FILLER_CHANCE) {
    lastWasFiller = false;
    return null;
  }
  const choices = available.filter((filler) => filler.text !== lastText);
  const filler = choices[Math.floor(random() * choices.length)] ?? available[0]!;
  lastWasFiller = true;
  lastText = filler.text;
  return filler;
}
