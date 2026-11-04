// Streamed replies reach the chat from several messages (chunks, speak_end,
// beats); these keep one line from being added twice.

import type { AppState } from '../state/app-state.js';

export function hasRecentOutgoingAssistantEntry(
  state: AppState,
  text: string,
  actor: 'main' | 'small',
): boolean {
  const normalized = normalizeChatComparisonText(text);
  if (!normalized) {
    return false;
  }

  for (let index = state.chatEntries.length - 1; index >= 0; index -= 1) {
    const entry = state.chatEntries[index];
    // A filler is not model output; matching it would swallow the reply's first sentence.
    if (!entry || entry.type !== 'out' || entry.actor !== actor || entry.draft || entry.filler) {
      continue;
    }
    if ((Date.now() - entry.ts) > 15_000) {
      break;
    }
    return normalizeChatComparisonText(entry.text) === normalized;
  }

  return false;
}

function normalizeChatComparisonText(text: string): string {
  return String(text ?? '')
    .replace(/^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}
