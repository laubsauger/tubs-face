// The floating transcript: the last few chat lines over the face, gone again
// once the conversation goes quiet.

import type { SpokenItem, VoiceClock } from '../../audio/voice-clock.js';
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

// Typing out. A new reply appears a bit at a time, with the voice, instead of
// all at once. The face window plays main Tubs's voice, so a main line follows
// it (see audio/voice-clock.ts); Mini's voice plays in its own window, so a
// Mini line types at a steady pace.

/** Without a voice to follow: a little faster than Tubs talks, so the text finishes early rather than late. */
export const TYPE_CHARS_PER_SECOND = 18;
/** How long a line in this window's voice waits for that voice to start before typing on its own. */
export const VOICE_WAIT_MS = 2500;
/** Speech that started this long before its line showed up (a render behind) still counts for it. */
const VOICE_SLACK_MS = 300;

export interface Typing {
  id: string;
  actor: TranscriptLine['actor'];
  /** performance.now() when the line arrived. */
  startedAt: number;
  /** Characters on screen; only ever grows. */
  shown: number;
}

/** Replies type out. A visitor's own words and fillers appear whole. */
export function typesOut(line: TranscriptLine): boolean {
  return line.actor !== 'user' && !line.filler;
}

/**
 * Which line is typing once the lines change. Only the newest line types, and
 * only a reply that arrived just now: a line that was already on screen stays
 * whole (so nothing types twice), and a newer line ends the typing of the one
 * before it. `previousIds` are the lines on screen before this change.
 */
export function nextTyping(
  typing: Typing | null,
  previousIds: ReadonlySet<string>,
  lines: readonly TranscriptLine[],
  now: number,
  instant = false,
): Typing | null {
  const newest = lines[lines.length - 1];
  if (!newest || instant || !typesOut(newest)) return null;
  if (typing?.id === newest.id) return typing;
  // A streamed reply is committed under a new id when it ends: the same reply, typing on.
  if (typing && typing.actor === newest.actor && !previousIds.has(newest.id) && !lines.some((line) => line.id === typing.id)) {
    return { ...typing, id: newest.id };
  }
  if (previousIds.has(newest.id)) return null;
  return { id: newest.id, actor: newest.actor, startedAt: now, shown: 0 };
}

function spokenShare(item: SpokenItem, now: number): number {
  if (item.seconds <= 0) return 1;
  // While more audio is coming its length is a guess: hold back the last bit.
  return Math.min(item.open ? 0.99 : 1, Math.max(0, (now - item.startedAt) / (item.seconds * 1000)));
}

/**
 * How many characters of the typing line show at `now`. A line in this
 * window's voice shows what that voice has said since the line arrived: each
 * sentence as its audio plays, all of it once the voice goes quiet. Until its
 * voice starts it waits (a filler may still be talking), up to VOICE_WAIT_MS.
 * Other lines, or one whose voice never comes, type at TYPE_CHARS_PER_SECOND.
 * Never shows less than it already did.
 */
export function revealedChars(
  typing: Typing,
  text: string,
  voice: VoiceClock,
  now: number,
  voiceActor: TranscriptLine['actor'] = 'main',
): number {
  const ownVoice = typing.actor === voiceActor;
  // Quiet since before the line arrived: nothing said so far was this line.
  const quietBefore = voice.quietAt != null && voice.quietAt < typing.startedAt;
  const heard = ownVoice && !quietBefore ? voice.items.filter((item) => item.startedAt >= typing.startedAt - VOICE_SLACK_MS) : [];
  let target: number;
  if (heard.length > 0) {
    target = voice.quietAt != null ? text.length : heard.reduce((sum, item) => sum + item.chars * spokenShare(item, now), 0);
  } else {
    const waited = now - typing.startedAt - (ownVoice ? VOICE_WAIT_MS : 0);
    target = (Math.max(0, waited) / 1000) * TYPE_CHARS_PER_SECOND;
  }
  return Math.min(text.length, Math.max(typing.shown, Math.floor(target)));
}
