import { openTtsStream } from '../tts/stream.js';

/**
 * A short sound ("Oh.", "Right.") played the moment a voice turn starts.
 * The spoken reply needs ~1.3 s after the clip arrives, on top of the time it
 * took to notice the visitor stopped talking. People expect a reaction within
 * a few hundred milliseconds; a filler makes the wait read as thinking rather
 * than lag (Shiwa et al. 2008). Played on some turns only, never twice in a
 * row, so it does not become a tic.
 */

// Kokoro garbles "Hm", "Mm" and "Uh huh" (speech-to-text heard "Am I?",
// "MESS", "As high"). These come out clean.
export const FILLER_LINES = ['Oh.', 'Okay.', 'Right.', 'Well.', 'Oh boy.', 'Wow.'] as const;
export const FILLER_CHANCE = 0.4;
const RENDER_RETRY_MS = 60_000;
const RENDER_TIMEOUT_MS = 15_000;

type Random = () => number;

export interface Filler {
  text: string;
  audio: string;
}

const clips = new Map<string, Filler[]>();
const rendering = new Set<string>();
const lastRenderAttempt = new Map<string, number>();
let lastWasFiller = false;
let lastText = '';

/** Renders all filler lines for a voice once. Failures leave the voice without fillers. */
export function prepareFillers(voice: string, now = Date.now()): void {
  if (clips.has(voice) || rendering.has(voice)) return;
  if (now - (lastRenderAttempt.get(voice) ?? -Infinity) < RENDER_RETRY_MS) return;
  lastRenderAttempt.set(voice, now);
  rendering.add(voice);

  const rendered: Filler[] = [];
  let pending = 0;
  let finish = (): void => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = openTtsStream({
    onChunk(chunk) {
      if (chunk.text && chunk.audio) rendered.push({ text: chunk.text, audio: chunk.audio });
    },
    onSentenceDone() {
      pending -= 1;
      if (pending <= 0) finish();
    },
    onClose: () => finish(),
  });

  void (async () => {
    try {
      if (!(await session.opened)) return;
      for (const line of FILLER_LINES) {
        pending += 1;
        session.send(line, voice);
      }
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, RENDER_TIMEOUT_MS))]);
      if (rendered.length > 0) clips.set(voice, rendered);
    } finally {
      session.close();
      rendering.delete(voice);
    }
  })();
}

/** The filler for this voice turn, or null when this turn goes without one. */
export function pickFiller(voice: string, random: Random = Math.random): Filler | null {
  const available = clips.get(voice);
  if (!available) {
    prepareFillers(voice);
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
