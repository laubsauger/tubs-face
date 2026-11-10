// The heads lead the gallery tour (sentient-studio contract §8): a reply that says they move on now
// carries "lead": "next" in its JSON (the model's call: a visitor asked to move on or to start, or
// they are done here). Seen live: asked to move on, Small said "Follow the flag to the book wall!"
// and nothing moved, the director still holding the floor open. The decision now reaches the
// director, which moves the tour on, so the words and the walk match. Only while the tour runs.

import { studioTour } from './context.js';
import { dropWaitingLine } from './present.js';

let sink: (() => void) | null = null;

/** Where a lead goes (the WebSocket server broadcasts it to the director). */
export function setLeadSink(fn: (() => void) | null): void {
  sink = fn;
}

/** "lead": "next" in a reply's JSON, or null. */
export function leadOf(rawText: string): 'next' | null {
  const text = String(rawText ?? '');
  if (!text.includes('"lead"')) return null;
  try {
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    const parsed = JSON.parse(text.slice(start, end + 1)) as { lead?: unknown };
    return parsed?.lead === 'next' ? 'next' : null;
  } catch {
    return /"lead"\s*:\s*"next"/.test(text) ? 'next' : null;
  }
}

/** A reply was made: if it leads on while the tour runs, tell the director. Returns whether it did. */
export function noteReplyLead(rawText: string, now = Date.now()): boolean {
  if (!studioTour(now) || leadOf(rawText) !== 'next') return false;
  console.log('[studio] the heads lead on: the tour moves');
  dropWaitingLine();
  sink?.();
  return true;
}
