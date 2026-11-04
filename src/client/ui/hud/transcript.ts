// The floating transcript: the last few chat lines over the face, gone again
// once the conversation goes quiet.

import { splitLeadingEmoji } from '../../chat/emoji.js';
import type { ChatEntry } from '../../state/app-state.js';

export const TRANSCRIPT_LINES = 4;
export const TRANSCRIPT_HOLD_MS = 20_000;

export interface TranscriptLine {
  id: string;
  actor: 'user' | 'main' | 'small';
  emoji: string;
  text: string;
  /** A pre-rendered "Um, okay." line, not model output. */
  filler: boolean;
  draft: boolean;
}

/** The newest conversation lines. System notices are operator noise, not conversation. */
export function selectTranscriptLines(entries: readonly ChatEntry[], limit = TRANSCRIPT_LINES): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (let index = entries.length - 1; index >= 0 && lines.length < limit; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type === 'sys' || !entry.text.trim()) continue;
    const actor = entry.type === 'in' ? 'user' : entry.actor === 'small' ? 'small' : 'main';
    const { emoji, body } = actor === 'user' ? { emoji: '', body: entry.text } : splitLeadingEmoji(entry.text);
    lines.unshift({
      id: entry.id,
      actor,
      emoji,
      text: body,
      filler: Boolean(entry.filler),
      draft: Boolean(entry.draft),
    });
  }
  return lines;
}

/** Changes whenever a line is added or a streaming line grows, which restarts the hold. */
export function transcriptKey(lines: readonly TranscriptLine[]): string {
  return lines.map((line) => `${line.id}:${line.text.length}`).join('|');
}

export function isTranscriptShown(lastChangeAt: number | null, now: number, holdMs = TRANSCRIPT_HOLD_MS): boolean {
  return lastChangeAt != null && now - lastChangeAt < holdMs;
}
