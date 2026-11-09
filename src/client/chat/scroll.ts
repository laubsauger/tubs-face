import type { ChatEntry } from '../state/app-state.js';

/** Within this many px of the bottom the chat log counts as "at the newest line". */
export const STICK_PX = 48;

/**
 * Changes whenever the newest line changes: a new line, a draft replaced by
 * its final line (same count), or a streaming line growing. Keyed on the count
 * alone, the log stayed put while two-head turns replaced their drafts.
 */
export function chatTailKey(entries: readonly ChatEntry[]): string {
  const last = entries.at(-1);
  return `${entries.length}:${last?.id ?? ''}:${last?.text.length ?? 0}`;
}

/** The reader is at the bottom (so new lines should keep it there), not scrolled up reading. */
export function nearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= STICK_PX;
}
