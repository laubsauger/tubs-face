import type { TurnContextMeta } from '../../shared/contracts/turn-script.js';
import type { LlmContent } from '../llm/types.js';
import { normalizeInput } from './text.js';

const HISTORY_CONTEXT_SIZE = 6;
const HISTORY_STORE_LIMIT = 24;
const HISTORY_TTL_MS = Number.parseInt(process.env.ASSISTANT_HISTORY_TTL_MS || '240000', 10);

interface HistoryEntry {
  role: 'user' | 'model';
  text: string;
  ts: number;
}

const conversationHistory: HistoryEntry[] = [];
// The camera description is about whoever stood there when the frame was
// taken. Without an expiry Tubs kept roasting a visitor who left long ago,
// or one seen before the camera was switched off.
const VISUAL_CONTEXT_TTL_MS = 60_000;
let visualContextText = '';
let visualContextAt = 0;

export function updateVisualContext(text: string, now = Date.now()): void {
  visualContextText = text;
  visualContextAt = now;
}

export function getVisualContext(now = Date.now()): string {
  return now - visualContextAt <= VISUAL_CONTEXT_TTL_MS ? visualContextText : '';
}

export interface BuiltContentsResult {
  contents: LlmContent[];
  meta: TurnContextMeta;
}

/**
 * `direction` (per-turn variety, see variety.ts) rides as a second part of the
 * newest user message, never stored in history. In the system prompt the model
 * ignored it and copied the length of its own earlier replies instead.
 */
export function buildContents(nextUserText: string, direction = ''): BuiltContentsResult {
  pruneConversationHistory();
  const recent = conversationHistory.slice(-HISTORY_CONTEXT_SIZE);
  const contents: LlmContent[] = recent.map((entry) => ({
    role: entry.role,
    parts: [{ text: entry.text }],
  }));

  const normalized = compactForHistory(nextUserText);
  contents.push({
    role: 'user',
    parts: direction ? [{ text: normalized }, { text: direction }] : [{ text: normalized }],
  });

  const historyChars = recent.reduce((sum, entry) => sum + entry.text.length, 0);
  return {
    contents,
    meta: {
      mode: 'text',
      imageAttached: Boolean(getVisualContext()),
      historyMessages: recent.length,
      historyChars,
    },
  };
}

export function buildProactiveContents(context: string, direction = ''): BuiltContentsResult {
  pruneConversationHistory();
  const recent = conversationHistory.slice(-HISTORY_CONTEXT_SIZE);
  const contents: LlmContent[] = recent.map((entry) => ({
    role: entry.role,
    parts: [{ text: entry.text }],
  }));

  contents.push({
    role: 'user',
    parts: direction ? [{ text: compactForHistory(context) }, { text: direction }] : [{ text: compactForHistory(context) }],
  });

  const historyChars = recent.reduce((sum, entry) => sum + entry.text.length, 0);
  return {
    contents,
    meta: {
      mode: 'proactive',
      imageAttached: Boolean(getVisualContext()),
      historyMessages: recent.length,
      historyChars,
    },
  };
}

/** Tubs's most recent replies (newest last), within the history window. */
export function recentModelReplies(limit: number): string[] {
  pruneConversationHistory();
  return conversationHistory.filter((entry) => entry.role === 'model').slice(-limit).map((entry) => entry.text);
}

export function pushHistory(role: 'user' | 'model', text: string): void {
  const normalized = compactForHistory(text);
  if (!normalized) {
    return;
  }

  conversationHistory.push({
    role,
    text: normalized,
    ts: Date.now(),
  });

  while (conversationHistory.length > HISTORY_STORE_LIMIT) {
    conversationHistory.shift();
  }
}

function pruneConversationHistory(): void {
  const now = Date.now();
  while (conversationHistory.length > 0) {
    const entry = conversationHistory[0];
    if (!entry || now - entry.ts > HISTORY_TTL_MS) {
      conversationHistory.shift();
      continue;
    }
    break;
  }
}

function compactForHistory(text: string): string {
  const normalized = normalizeInput(text);
  if (normalized.length <= 800) {
    return normalized;
  }
  return `${normalized.slice(0, 800).trim()}...`;
}
