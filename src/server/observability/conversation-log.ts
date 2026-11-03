import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TurnBeat } from '../../shared/contracts/turn-script.js';

/**
 * Daily plain-text transcript, like main's logger: logs/YYYY-MM-DD.log with
 * one "[time] SPEAKER: text" line per utterance. For reading back what
 * visitors said and how Tubs answered after a studio session.
 */
const LOGS_DIR = resolve(process.cwd(), 'logs');
let dirReady: Promise<unknown> | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

export function logConversation(speaker: string, text: string, now = new Date()): Promise<void> {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) {
    return Promise.resolve();
  }
  const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
  const file = resolve(LOGS_DIR, `${now.toISOString().slice(0, 10)}.log`);
  dirReady ??= mkdir(LOGS_DIR, { recursive: true });
  // Serialise writes so lines from overlapping turns don't interleave.
  const write = writeChain.then(() => dirReady).then(() => appendFile(file, `[${stamp}] ${speaker}: ${clean}\n`));
  writeChain = write.catch((error: unknown) => {
    console.warn('[ConversationLog] write failed:', error instanceof Error ? error.message : error);
  });
  return writeChain.then(() => undefined);
}

/** Dual-head replies are logged per head (TUBS:main / TUBS:small). */
export function logTubsReply(text: string, beats?: TurnBeat[]): Promise<void> {
  const spoken = (beats ?? []).filter((beat) => beat.action === 'speak' && beat.text?.trim());
  if (spoken.length === 0) {
    return logConversation('TUBS', text);
  }
  return spoken.reduce<Promise<void>>((chain, beat) => chain.then(() => logConversation(`TUBS:${beat.actor}`, beat.text ?? '')), Promise.resolve());
}
