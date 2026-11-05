/**
 * What this window's voice has said and when, so the floating transcript can
 * type a reply out with the voice. The speech runtime notes each TTS item the
 * moment its audio starts (when its subtitle starts too) and when the voice
 * goes quiet; the transcript reads this on its own animation frame, so
 * following the voice costs no store updates. One per window, like the lip
 * sync level in speech-level.ts.
 */

export interface SpokenItem {
  /** Length of the text it says. */
  chars: number;
  /** performance.now() when its audio started. */
  startedAt: number;
  /** How long its audio runs; an estimate while `open`. */
  seconds: number;
  /** More audio for it is still coming (Ming streams a reply in pieces). */
  open: boolean;
}

export interface VoiceClock {
  /** Recent items, oldest first. */
  items: readonly SpokenItem[];
  /** When the voice last went quiet (reply over or cut off); null once it speaks again. */
  quietAt: number | null;
}

const MAX_ITEMS = 24;
const items: SpokenItem[] = [];
let quietAt: number | null = null;

export function noteVoiceStarted(text: string, seconds: number, open: boolean, at = performance.now()): void {
  items.push({ chars: text.trim().length, startedAt: at, seconds, open });
  if (items.length > MAX_ITEMS) items.shift();
  quietAt = null;
}

/** The running item's audio is now this long (see subtitleSeconds). */
export function noteVoiceRetimed(seconds: number, open: boolean): void {
  const last = items[items.length - 1];
  if (!last) return;
  last.seconds = seconds;
  last.open = open;
}

export function noteVoiceQuiet(at = performance.now()): void {
  quietAt = at;
}

export function readVoiceClock(): VoiceClock {
  return { items, quietAt };
}
