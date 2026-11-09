// Plays a two-head beat script: TTS per speak beat, routed to its head, with
// the pauses between beats.

import type { TurnBeat } from '../../shared/contracts/turn-script.js';
import type { WsAudioChunkServerMessage, WsServerMessage, WsSpeakEndServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig } from '../config/runtime.js';
import type { TurnTimer } from '../turn-timing.js';
import { sanitizeForTts, stripFormatting } from './text.js';
import { openTtsStream, type TtsStreamSession } from '../tts/stream.js';
import { wavDurationS } from '../tts/wav.js';
import { assistantUnavailable } from './reply-types.js';
import { isAssistantTurnActive } from './turn-state.js';

const ESTIMATED_SPEECH_WORD_MS = 440;

const ESTIMATED_MIN_SPEECH_MS = 800;

/**
 * The pause after a line: a breath when the script sets none (back to back
 * sounds unnatural; people leave ~0.2-0.5 s), and never a long silence when it
 * does (it allowed 8 s).
 */
const HANDOVER_MS = 300;
const HANDOVER_MAX_MS = 1_200;

type TtsHandlers = Parameters<typeof openTtsStream>[0];

function voiceFor(actor: 'main' | 'small'): string {
  const mainVoice = runtimeConfig.kokoroVoice ?? 'af_heart';
  return actor === 'small' ? runtimeConfig.secondaryVoice ?? mainVoice : mainVoice;
}

function ttsTextOf(beat: TurnBeat): string {
  return sanitizeForTts(stripFormatting(beat.text?.trim() ?? ''));
}

/**
 * A speak beat whose TTS started while the model was still writing the rest
 * of the script. Its audio waits here until the beat plays, so clients still
 * get the turn_script first. Ming's first chunk takes ~0.2 s and the rest of
 * the script ~0.15 s (up to ~0.45 s on three beats): the two now overlap.
 */
export interface EarlyBeat {
  readonly actor: 'main' | 'small';
  readonly text: string;
  readonly session: TtsStreamSession;
  /** Hands over what arrived so far, then everything as it comes. */
  attach(handlers: TtsHandlers): void;
  close(): void;
}

export function startEarlyBeat(beat: TurnBeat): EarlyBeat | null {
  const actor = beat.actor === 'small' ? 'small' as const : 'main' as const;
  const text = ttsTextOf(beat);
  if (beat.action !== 'speak' || !text) return null;
  const voice = voiceFor(actor);
  const waiting: Array<(handlers: TtsHandlers) => void> = [];
  let target: TtsHandlers | null = null;
  const relay = (call: (handlers: TtsHandlers) => void) => (target ? call(target) : waiting.push(call));
  const session = openTtsStream({
    onChunk: (chunk) => relay((handlers) => handlers.onChunk(chunk)),
    onSentenceDone: () => relay((handlers) => handlers.onSentenceDone()),
    onError: (error) => relay((handlers) => handlers.onError?.(error)),
    onClose: () => relay((handlers) => handlers.onClose?.()),
  });
  void session.opened.then((ok) => {
    if (ok && session.ready) session.send(text, voice);
  });
  return {
    actor,
    text,
    session,
    attach(handlers) {
      target = handlers;
      for (const call of waiting.splice(0)) call(handlers);
    },
    close: () => session.close(),
  };
}

/**
 * Stream TTS audio for dual-head speak beats server-side, broadcasting
 * audio_chunk messages so clients can play them immediately via the
 * streaming audio pipeline instead of per-beat tts_request round-trips.
 */
export async function streamDualHeadBeatAudio(
  beats: TurnBeat[],
  turnId: string,
  epoch: number,
  broadcast: (message: WsServerMessage) => void,
  turnTimer?: TurnTimer,
  early: EarlyBeat | null = null,
): Promise<void> {
  const startedAt = Date.now();
  let firstSpeakBeat = true;
  let chunkIndex = 0;
  let firstChunkSent = false;
  // The next speak beat, rendering while this one still plays. Started only
  // after Ming is done with the line before it (Ming renders one at a time),
  // and released when that line stops playing: the next head answers on cue,
  // not a render later.
  const prefetch: { next: { index: number; beat: EarlyBeat } | null } = { next: null };

  console.log(`\x1b[36m[DualHead TTS]\x1b[0m scheduling ${beats.length} beat(s)`);

  try {
  for (const [index, beat] of beats.entries()) {
    if (!isAssistantTurnActive(turnId, epoch)) {
      break;
    }

    if (beat.action === 'wait') {
      const waitMs = clampBeatDelay(beat.delayMs, 320);
      await waitForBeatDelay(waitMs);
      continue;
    }

    if (beat.action === 'react') {
      if (beat.delayMs != null) {
        await waitForBeatDelay(clampBeatDelay(beat.delayMs, 420));
      }
      continue;
    }

    const actor = beat.actor === 'small' ? 'small' as const : 'main' as const;
    const voice = voiceFor(actor);
    const text = ttsTextOf(beat);
    if (!text) {
      continue;
    }
    // The early render is used only if the finished script starts with the
    // same line; otherwise it is stopped at once (Ming renders one at a time).
    let earlyForBeat: EarlyBeat | null = null;
    if (firstSpeakBeat) {
      firstSpeakBeat = false;
      if (early && early.actor === actor && early.text === text) {
        earlyForBeat = early;
        turnTimer?.mark('First line rendered early');
      } else {
        early?.close();
      }
    } else if (prefetch.next?.index === index) {
      earlyForBeat = prefetch.next.beat;
      prefetch.next = null;
    }

    const beatChunks = await streamDualHeadSpeakBeat({
      turnId,
      epoch,
      broadcast,
      actor,
      beatIndex: index,
      text,
      voice,
      early: earlyForBeat,
      nextChunkIndex: chunkIndex,
      callout: beat.callout === true,
      onRendered: () => {
        const nextIndex = nextSpeakBeatIndex(beats, index);
        if (nextIndex < 0 || !isAssistantTurnActive(turnId, epoch)) return;
        const started = startEarlyBeat(beats[nextIndex]!);
        if (started) prefetch.next = { index: nextIndex, beat: started };
      },
      onFirstChunk: () => {
        if (!firstChunkSent) {
          firstChunkSent = true;
          turnTimer?.mark('First audio chunk sent');
          console.log(`\x1b[36m[DualHead TTS]\x1b[0m first chunk in ${Date.now() - startedAt}ms`);
        }
      },
    });
    chunkIndex += beatChunks;

    if (!isAssistantTurnActive(turnId, epoch)) {
      break;
    }

    await waitForBeatDelay(beat.delayMs != null ? Math.min(HANDOVER_MAX_MS, clampBeatDelay(beat.delayMs, HANDOVER_MS)) : HANDOVER_MS);
  }
  } finally {
    prefetch.next?.beat.close();
  }
}

function nextSpeakBeatIndex(beats: TurnBeat[], after: number): number {
  for (let index = after + 1; index < beats.length; index += 1) {
    if (beats[index]!.action === 'speak' && ttsTextOf(beats[index]!)) return index;
  }
  return -1;
}

/** Seconds of audio in a TTS chunk, or null if it isn't a WAV this can read. */
function chunkSeconds(audio: string): number | null {
  try {
    return wavDurationS(audio);
  } catch {
    return null;
  }
}

async function streamDualHeadSpeakBeat(args: {
  turnId: string;
  epoch: number;
  broadcast: (message: WsServerMessage) => void;
  actor: 'main' | 'small';
  beatIndex: number;
  text: string;
  voice: string;
  early?: EarlyBeat | null;
  nextChunkIndex: number;
  /** A studio call-out (TurnBeat.callout): the face page plays it without waiting. */
  callout?: boolean;
  /** Ming is done with this line (its audio may still be playing). */
  onRendered?: () => void;
  onFirstChunk?: () => void;
}): Promise<number> {
  const {
    turnId,
    epoch,
    broadcast,
    actor,
    beatIndex,
    text,
    voice,
    early,
    nextChunkIndex,
    callout,
    onRendered,
    onFirstChunk,
  } = args;
  const startedAt = Date.now();

  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    let streamError: Error | null = null;
    let chunkCount = 0;
    let sentenceDone = false;
    let firstChunkLogged = false;
    let firstChunkAt = 0;
    // When the client runs out of this line's audio: it plays each chunk on
    // arrival or right after the one before. Null once a chunk can't be timed.
    let playbackEndsAt: number | null = 0;

    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(chunkCount);
    };
    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const handlers: TtsHandlers = {
      onChunk(chunk) {
        if (!isAssistantTurnActive(turnId, epoch)) {
          ttsSession.close();
          return;
        }
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          firstChunkAt = Date.now();
          onFirstChunk?.();
        }
        const seconds = chunkSeconds(chunk.audio);
        playbackEndsAt = playbackEndsAt == null || seconds == null ? null : Math.max(playbackEndsAt, Date.now()) + seconds * 1000;
        broadcast({
          type: 'audio_chunk',
          audio: chunk.audio,
          text,
          turnId,
          chunkIndex: nextChunkIndex + chunkCount,
          actor,
          beatIndex,
          ...(chunk.more ? { more: true } : {}),
          ...(callout ? { callout: true } : {}),
        } satisfies WsAudioChunkServerMessage);
        chunkCount += 1;
      },
      onSentenceDone() {
        sentenceDone = true;
        ttsSession.close();
      },
      onError(error) {
        console.warn(`\x1b[31m\x1b[1m[DualHead TTS]\x1b[0m error (${actor} beat ${beatIndex}): ${error.message}`);
        streamError = error;
      },
      onClose() {
        console.log(`\x1b[36m[DualHead TTS]\x1b[0m beat ${beatIndex} ${actor} done — ${chunkCount} chunks, ${Date.now() - startedAt}ms`);
        if (chunkCount === 0) {
          if (!isAssistantTurnActive(turnId, epoch)) {
            finishResolve();
            return;
          }
          finishReject(streamError ?? assistantUnavailable(`[streaming] Dual-head beat ${beatIndex} ended without audio chunks for turn ${turnId}`));
          return;
        }
        broadcast({
          type: 'speak_end',
          turnId,
          actor,
          text,
          fullText: text,
        } satisfies WsSpeakEndServerMessage);
        if (!sentenceDone && streamError) {
          finishReject(streamError);
          return;
        }
        onRendered?.();
        // From the audio itself: the old estimate (440 ms a word) ran ~1.5x
        // slower than Ming talks, so the next head waited seconds for nothing.
        const streamedPlaybackMs = firstChunkAt > 0 ? Math.max(0, Date.now() - firstChunkAt) : 0;
        const remainingPlaybackMs = Math.max(
          0,
          // A bit runs well past 8 s; a shorter wait let the other head talk over it.
          Math.min(20_000, playbackEndsAt ? playbackEndsAt - Date.now() : estimateSpeechDurationMs(text) - streamedPlaybackMs),
        );
        if (remainingPlaybackMs <= 0 || !isAssistantTurnActive(turnId, epoch)) {
          finishResolve();
          return;
        }
        void waitForTurnPlaybackWindow(turnId, epoch, remainingPlaybackMs).then(() => {
          finishResolve();
        });
      },
    };
    // An early beat's text is already rendering; its events so far replay now.
    const ttsSession = early ? early.session : openTtsStream(handlers);
    if (early) {
      early.attach(handlers);
    } else {
      void ttsSession.opened.then((ok) => {
        if (ok && ttsSession.ready) {
          ttsSession.send(text, voice);
          return;
        }
        if (!isAssistantTurnActive(turnId, epoch) || chunkCount > 0) {
          finishResolve();
          return;
        }
        finishReject(streamError ?? assistantUnavailable(`[streaming] Dual-head TTS closed before becoming ready for beat ${beatIndex} (${turnId})`));
      });
    }

    setTimeout(() => {
      if (!ttsSession.closed) {
        console.warn(`\x1b[33m[DualHead TTS]\x1b[0m beat ${beatIndex} safety timeout — closing`);
        streamError ??= assistantUnavailable(`[streaming] Dual-head beat ${beatIndex} timed out for turn ${turnId}`);
        ttsSession.close();
      }
    }, 30_000);
  });
}

function clampBeatDelay(value: number | undefined, fallbackMs: number): number {
  const normalized = Number.isFinite(value) ? Number(value) : fallbackMs;
  return Math.max(120, Math.min(8_000, normalized));
}

function estimateSpeechDurationMs(text: string): number {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  if (words <= 0) {
    return ESTIMATED_MIN_SPEECH_MS;
  }
  return Math.max(ESTIMATED_MIN_SPEECH_MS, words * ESTIMATED_SPEECH_WORD_MS);
}

async function waitForBeatDelay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function waitForTurnPlaybackWindow(turnId: string, epoch: number, delayMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, delayMs);
  while (Date.now() < deadline) {
    if (!isAssistantTurnActive(turnId, epoch)) {
      return;
    }
    await waitForBeatDelay(Math.min(90, Math.max(1, deadline - Date.now())));
  }
}
