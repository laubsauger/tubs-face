// Plays a two-head beat script: TTS per speak beat, routed to its head, with
// the pauses between beats.

import type { TurnBeat } from '../../shared/contracts/turn-script.js';
import type { WsAudioChunkServerMessage, WsServerMessage, WsSpeakEndServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig } from '../config/runtime.js';
import type { TurnTimer } from '../turn-timing.js';
import { sanitizeForTts, stripFormatting } from './text.js';
import { openTtsStream } from '../tts/stream.js';
import { assistantUnavailable } from './reply-types.js';
import { isAssistantTurnActive } from './turn-state.js';

const ESTIMATED_SPEECH_WORD_MS = 440;

const ESTIMATED_MIN_SPEECH_MS = 800;

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
): Promise<void> {
  const mainVoice = runtimeConfig.kokoroVoice ?? 'af_heart';
  const smallVoice = runtimeConfig.secondaryVoice ?? mainVoice;
  const startedAt = Date.now();
  let chunkIndex = 0;
  let firstChunkSent = false;

  console.log(`\x1b[36m[DualHead TTS]\x1b[0m scheduling ${beats.length} beat(s)`);

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
    const voice = actor === 'small' ? smallVoice : mainVoice;
    const text = sanitizeForTts(stripFormatting(beat.text?.trim() ?? ''));
    if (!text) {
      continue;
    }

    const beatChunks = await streamDualHeadSpeakBeat({
      turnId,
      epoch,
      broadcast,
      actor,
      beatIndex: index,
      text,
      voice,
      nextChunkIndex: chunkIndex,
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

    if (beat.delayMs != null) {
      await waitForBeatDelay(clampBeatDelay(beat.delayMs, 320));
    }
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
  nextChunkIndex: number;
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
    nextChunkIndex,
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

    const ttsSession = openTtsStream({
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
        broadcast({
          type: 'audio_chunk',
          audio: chunk.audio,
          text,
          turnId,
          chunkIndex: nextChunkIndex + chunkCount,
          actor,
          beatIndex,
          ...(chunk.more ? { more: true } : {}),
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
        const streamedPlaybackMs = firstChunkAt > 0 ? Math.max(0, Date.now() - firstChunkAt) : 0;
        const remainingPlaybackMs = Math.max(
          0,
          // A bit runs well past 8 s; a shorter wait let the other head talk over it.
          Math.min(20_000, estimateSpeechDurationMs(text) - streamedPlaybackMs),
        );
        if (remainingPlaybackMs <= 0 || !isAssistantTurnActive(turnId, epoch)) {
          finishResolve();
          return;
        }
        void waitForTurnPlaybackWindow(turnId, epoch, remainingPlaybackMs).then(() => {
          finishResolve();
        });
      },
    });

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
