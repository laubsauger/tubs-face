import type { ChatEntry } from '../state/app-state.js';

export interface ShownChatEntry extends ChatEntry {
  /** A filler said just before this reply by the same head ("Hmm."), shown as its lead-in. */
  lead?: string;
}

/**
 * A filler belongs to the reply that follows it: the same head says both. So
 * it is shown inside that reply's bubble, as a lead-in in its own colour (it
 * was heard, but it is not model output), not as a bubble of its own. A filler
 * whose head doesn't speak next (Mini has the first line) stays on its own.
 */
export function withFillerLeads(entries: readonly ChatEntry[]): ShownChatEntry[] {
  const shown: ShownChatEntry[] = [];
  for (const entry of entries) {
    const previous = shown[shown.length - 1];
    if (previous?.filler && entry.type === 'out' && !entry.filler && (entry.actor ?? 'main') === (previous.actor ?? 'main')) {
      shown[shown.length - 1] = { ...entry, lead: previous.text };
      continue;
    }
    shown.push(entry);
  }
  return shown;
}
