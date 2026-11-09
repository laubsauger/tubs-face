// studio_caption: the line a head is saying now and how much of it has been
// heard (sentient-studio contract section 8, captions). Read from this page's
// voice clock, the same record the operator transcript types out with, so a
// window can light up the spoken part the way the app does. The page plays
// this head's voice into its stream, so this playback clock is the stream's.

import { spokenShare, type SpokenItem, type VoiceClock } from '../audio/voice-clock.js';

/** The guard's limit for text on the socket. */
export const MAX_CAPTION_CHARS = 2000;
/** The page reads the clock this often while studio mode is on: at most 10 captions a second. */
export const CAPTION_TICK_MS = 100;

export interface StudioCaptionState {
  turnId: string;
  text: string;
  /** Characters of `text` heard so far. */
  spoken: number;
  /** The line has finished (all of it heard, or cut off). */
  done: boolean;
}

export interface CaptionTracker {
  /** The captions to send now: none while nothing changed. */
  update(clock: VoiceClock, now: number): StudioCaptionState[];
}

/**
 * Every TTS item is a line, as on the face's own subtitle: a sentence, a
 * whole streamed reply, a filler or lead-in. Each line is reported as it is
 * heard and gets exactly one done: when it has played out, when the voice is
 * cut off (with what was heard by then), or at the latest when the next line
 * starts.
 */
export function createCaptionTracker(): CaptionTracker {
  // Lines that were already there or already finished: never reported (again).
  const seen = new WeakSet<SpokenItem>();
  let current: { item: SpokenItem; sent: StudioCaptionState | null } | null = null;
  let started = false;

  return {
    update(clock, now) {
      const out: StudioCaptionState[] = [];
      const latest = clock.items[clock.items.length - 1] ?? null;
      if (!started) {
        // Lines spoken before the page started reporting are history.
        started = true;
        for (const item of clock.items) seen.add(item);
        return out;
      }
      if (current && current.item !== latest) {
        // The next line started: this one played out (audio plays in order).
        out.push({ ...captionOf(current.item, 1), done: true });
        current = null;
      }
      if (!current && latest && !seen.has(latest)) {
        seen.add(latest);
        current = { item: latest, sent: null };
      }
      if (!current) return out;

      const item = current.item;
      const cutOff = clock.quietAt != null && clock.quietAt >= item.startedAt;
      const share = spokenShare(item, now);
      const caption = captionOf(item, share);
      caption.done = cutOff || (!item.open && share >= 1);
      if (!sameCaption(current.sent, caption)) {
        out.push(caption);
        current.sent = caption;
      }
      if (caption.done) current = null;
      return out;
    },
  };
}

function captionOf(item: SpokenItem, share: number): StudioCaptionState {
  const text = (item.text ?? '').slice(0, MAX_CAPTION_CHARS);
  return {
    turnId: item.turnId ?? '',
    text,
    spoken: Math.min(text.length, Math.floor(text.length * share)),
    done: false,
  };
}

function sameCaption(a: StudioCaptionState | null, b: StudioCaptionState): boolean {
  return a !== null && a.text === b.text && a.spoken === b.spoken && a.done === b.done && a.turnId === b.turnId;
}
