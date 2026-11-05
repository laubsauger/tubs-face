import type { TurnContextMeta } from '../../shared/contracts/turn-script.js';
import type { LlmContent } from '../llm/types.js';
import { normalizeInput } from './text.js';

// Six exchanges. With three, a visitor's "no, I meant what Mini said" two
// turns later already pointed at something the model could no longer see.
const HISTORY_CONTEXT_SIZE = 12;
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

/** The visitor is gone: the next person starts fresh, not with their jacket. */
export function forgetConversation(): void {
  conversationHistory.length = 0;
  visualContextText = '';
  visualContextAt = 0;
}

/** Tubs's most recent replies (newest last), within the history window. */
export function recentModelReplies(limit: number): string[] {
  pruneConversationHistory();
  // Two-head turns are stored with who said each line; the rules that look at
  // openers and lengths need the words, not the labels.
  return conversationHistory.filter((entry) => entry.role === 'model').slice(-limit).map((entry) => entry.text.replace(HISTORY_SPEAKER_LABEL, '$1').trim());
}

export const CUT_OFF_MARK = '[cut off by the visitor]';
const HISTORY_SPEAKER_LABEL = /(^|\s)(?:Main|Small): /g;

/** A two-head turn as it goes into the history: each line marked with who said it. */
export function beatsForHistory(beats: ReadonlyArray<{ actor?: string; action?: string; text?: string | undefined }>): string {
  return beats
    .filter((beat) => beat.action === 'speak' && beat.text?.trim())
    .map((beat) => `${beat.actor === 'small' ? 'Small' : 'Main'}: ${beat.text!.trim()}`)
    .join(' ');
}

/**
 * The visitor talked over Tubs's last reply. Marked so the model knows they
 * did not hear all of it, instead of assuming its whole line landed.
 */
export function markLastReplyCutOff(): void {
  const last = conversationHistory.at(-1);
  if (last?.role === 'model' && !last.text.endsWith(CUT_OFF_MARK)) {
    last.text = `${last.text} ${CUT_OFF_MARK}`;
  }
}

/**
 * A reply was generated, then superseded before any of it played. It was
 * already pushed to history; keep the exchange, but not words nobody heard.
 */
export function markLastReplyUnheard(): void {
  const last = conversationHistory.at(-1);
  if (last?.role === 'model') {
    last.text = `... ${CUT_OFF_MARK}`;
  }
}

/** A proactive line was superseded before it played: as if never said. */
export function forgetLastReply(): void {
  if (conversationHistory.at(-1)?.role === 'model') {
    conversationHistory.pop();
  }
}

export function wasLastReplyCutOff(): boolean {
  pruneConversationHistory();
  const last = conversationHistory.at(-1);
  return last?.role === 'model' && last.text.endsWith(CUT_OFF_MARK);
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
