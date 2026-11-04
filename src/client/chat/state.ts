import type { AppState, ChatEntry } from '../state/app-state.js';

const MAX_CHAT_ENTRIES = 300;
const TRIM_CHAT_TO = 200;

export function appendChatEntry(state: AppState, entry: Omit<ChatEntry, 'id'>): AppState {
  const nextEntry: ChatEntry = {
    id: `${entry.ts}-${Math.random().toString(16).slice(2, 8)}`,
    ...entry,
  };

  const filtered = state.chatEntries.filter((item) => !(item.draft && item.type === entry.type));
  const nextEntries = [...filtered, nextEntry];
  const trimmed = nextEntries.length > MAX_CHAT_ENTRIES
    ? nextEntries.slice(nextEntries.length - TRIM_CHAT_TO)
    : nextEntries;

  return {
    ...state,
    chatEntries: trimmed,
  };
}

export function upsertChatDraft(
  state: AppState,
  type: ChatEntry['type'],
  text: string,
  actor: ChatEntry['actor'] = type === 'in' ? 'user' : type === 'sys' ? 'system' : 'main',
): AppState {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return clearChatDraft(state, type);
  }

  const entry: ChatEntry = {
    id: `draft-${type}`,
    type,
    actor,
    text: normalized,
    ts: Date.now(),
    draft: true,
  };

  const withoutDraft = state.chatEntries.filter((item) => !(item.draft && item.type === type));
  return {
    ...state,
    chatEntries: [...withoutDraft, entry],
  };
}

/**
 * Streamed replies arrive one sentence per audio chunk. Each chunk extends the
 * draft; replacing it (as upsertChatDraft does) left only the last sentence.
 */
export function appendChatDraft(
  state: AppState,
  type: ChatEntry['type'],
  text: string,
  actor: ChatEntry['actor'] = 'main',
): AppState {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return state;
  }
  const existing = state.chatEntries.find((entry) => entry.draft && entry.type === type);
  if (!existing) {
    return upsertChatDraft(state, type, normalized, actor);
  }
  if (existing.text === normalized || existing.text.endsWith(` ${normalized}`)) {
    return state;
  }
  return upsertChatDraft(state, type, `${existing.text} ${normalized}`, actor);
}

export function reconcileIncomingChat(state: AppState, text: string): AppState {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return clearChatDraft(state, 'in');
  }

  for (let index = state.chatEntries.length - 1; index >= 0; index -= 1) {
    const entry = state.chatEntries[index];
    if (!entry) {
      continue;
    }
    if (entry.type !== 'in') {
      continue;
    }

    if (entry.draft) {
      const nextEntries = [...state.chatEntries];
      nextEntries[index] = {
        ...entry,
        text: normalized,
        ts: Date.now(),
      } satisfies ChatEntry;
      return {
        ...state,
        chatEntries: nextEntries,
      };
    }

    const recentUserEntry = entry.actor === 'user' && (Date.now() - entry.ts) < 8_000;
    if (recentUserEntry) {
      const nextEntries = [...state.chatEntries];
      nextEntries[index] = {
        ...entry,
        text: normalized,
        ts: Date.now(),
      } satisfies ChatEntry;
      return {
        ...state,
        chatEntries: nextEntries,
      };
    }

    break;
  }

  return upsertChatDraft(state, 'in', normalized, 'user');
}

export function commitChatDraft(state: AppState, type: ChatEntry['type']): AppState {
  return {
    ...state,
    chatEntries: state.chatEntries.map((entry) => (
      entry.draft && entry.type === type
        ? { ...entry, draft: false, id: `${entry.ts}-${Math.random().toString(16).slice(2, 8)}` }
        : entry
    )),
  };
}

export function clearChatDraft(state: AppState, type: ChatEntry['type']): AppState {
  return {
    ...state,
    chatEntries: state.chatEntries.filter((entry) => !(entry.draft && entry.type === type)),
  };
}

