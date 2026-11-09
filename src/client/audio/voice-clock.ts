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
  /** What it says (trimmed), and the turn it belongs to. */
  text?: string;
  turnId?: string | null;
  /** Where its audio sits on the playback clock, when known (streamed speech). */
  playback?: Playback;
}

/**
 * The item's audio on the AudioContext's own clock: a stalled stream (the next
 * piece not here yet) or a suspended context stops that clock's progress
 * through the audio, where wall time would run on.
 */
export interface Playback {
  /** The context's currentTime now. */
  clock: () => number;
  /** Each piece of the item's audio: start on that clock, and length, in seconds. Grows as pieces arrive. */
  pieces: ReadonlyArray<{ at: number; seconds: number }>;
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

export function noteVoiceStarted(
  text: string,
  seconds: number,
  open: boolean,
  at = performance.now(),
  extra: { turnId?: string | null; playback?: Playback } = {},
): void {
  items.push({ chars: text.trim().length, startedAt: at, seconds, open, text: text.trim(), ...extra });
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

/** Seconds of the item's audio that have actually played. */
export function heardSeconds(playback: Playback): number {
  const now = playback.clock();
  let heard = 0;
  for (const piece of playback.pieces) heard += Math.max(0, Math.min(piece.seconds, now - piece.at));
  return heard;
}

/**
 * How much of an item has been said at `now` (performance.now()), 0..1. From
 * the audio that has played when its playback is known, so a stall or a pause
 * holds it; else from the time since it started. While more audio is coming
 * its length is a guess: the last bit is held back.
 */
export function spokenShare(item: SpokenItem, now: number): number {
  if (item.seconds <= 0) return 1;
  const played = item.playback ? heardSeconds(item.playback) : (now - item.startedAt) / 1000;
  return Math.min(item.open ? 0.99 : 1, Math.max(0, played / item.seconds));
}
