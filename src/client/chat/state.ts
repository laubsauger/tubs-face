import type { AppState, ChatEntry, StreamDebugEntry, StreamDebugState } from '../state/app-state.js';

const MAX_CHAT_ENTRIES = 300;
const TRIM_CHAT_TO = 200;
const MAX_STREAM_DEBUG_ENTRIES = 140;

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
  actor: ChatEntry['actor'] = 'main',
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

export function commitChatDraft(state: AppState, type: ChatEntry['type']): AppState {
  return {
    ...state,
    chatEntries: state.chatEntries.map((entry) => (
      entry.draft && entry.type === type
        ? { ...entry, draft: false }
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

export function pushStreamDebugEntry(
  state: AppState,
  stage: string,
  payload: Record<string, unknown> = {},
): AppState {
  const entry: StreamDebugEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    stage,
    payload,
    ts: typeof payload.ts === 'number' ? payload.ts : Date.now(),
  };

  const nextEntries = [...state.streamDebug.entries, entry];
  const trimmedEntries = nextEntries.length > MAX_STREAM_DEBUG_ENTRIES
    ? nextEntries.slice(nextEntries.length - MAX_STREAM_DEBUG_ENTRIES)
    : nextEntries;

  const counters = applyStreamDebugCounters(state.streamDebug, stage, payload);
  return {
    ...state,
    streamDebug: {
      ...counters,
      entries: trimmedEntries,
      currentTurnId: typeof payload.turnId === 'string' ? payload.turnId : counters.currentTurnId,
    },
  };
}

export function resetStreamDebugState(state: AppState, turnId: string | null = null): AppState {
  return {
    ...state,
    streamDebug: {
      enabled: state.streamDebug.enabled,
      currentTurnId: turnId,
      llmDeltas: 0,
      llmChars: 0,
      sentences: 0,
      ttsSentences: 0,
      ttsChars: 0,
      audioChunksIn: 0,
      audioBytesIn: 0,
      audioChunksPlayed: 0,
      audioSecondsPlayed: 0,
      entries: [],
    },
  };
}

function applyStreamDebugCounters(
  debug: StreamDebugState,
  stage: string,
  payload: Record<string, unknown>,
): StreamDebugState {
  const next: StreamDebugState = {
    ...debug,
    entries: debug.entries,
  };

  switch (stage) {
    case 'llm_delta':
      next.llmDeltas += 1;
      next.llmChars += toNumber(payload.deltaChars);
      break;
    case 'sentence_ready':
      next.sentences += 1;
      break;
    case 'tts_sentence_sent':
      next.ttsSentences += 1;
      next.ttsChars += toNumber(payload.textChars);
      break;
    case 'tts_audio_chunk_in':
    case 'audio_chunk_ws_in':
      next.audioChunksIn += 1;
      next.audioBytesIn += toNumber(payload.audioBytes);
      break;
    case 'audio_chunk_played':
      next.audioChunksPlayed += 1;
      next.audioSecondsPlayed += toNumber(payload.audioDurationSec);
      break;
    default:
      break;
  }

  return next;
}

function toNumber(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
