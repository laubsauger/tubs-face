// Runs an assistant turn: picks the streamed, one-call or two-head path,
// announces the turn and reports the result. Called from turns.ts.

import type { WsAudioChunkServerMessage, WsServerMessage, WsSpeakEndServerMessage, WsSpeakServerMessage, WsStatsServerMessage, WsTurnStartServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig, sessionStats } from '../config/runtime.js';
import type { TurnTimer } from '../turn-timing.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { pickFiller } from './fillers.js';
import type { TurnBeat } from '../../shared/contracts/turn-script.js';
import { normalizeInput } from './text.js';
import { shouldUseDualHeadDirectedMode } from './dual-head.js';
import { type EarlyBeat, startEarlyBeat, streamDualHeadBeatAudio } from './dual-head-playback.js';
import { generateDualHeadProactiveReply, generateDualHeadReply } from './dual-head-reply.js';
import { logAssistantUserInput } from './llm-log.js';
import { type AssistantTurnResult, isDualHeadReply } from './reply-types.js';
import { generateAssistantReply, generateProactiveReply } from './single-head.js';
import { runStreamingAssistantTurn } from './streaming-turn.js';
import { activateAssistantTurn, createTurnId, emitIfActive, finishAssistantTurn, isAssistantTurnActive } from './turn-state.js';
import { forgetLastReply, markLastReplyUnheard } from './context.js';

export { createTurnId, hasActiveAssistantTurn, interruptAssistantTurns } from './turn-state.js';
export type { AssistantReply, AssistantTurnResult } from './reply-types.js';

export async function runAssistantTurn(
  userText: string,
  broadcast: (message: WsServerMessage) => void,
  turnTimer?: TurnTimer,
  options: { filler?: boolean } = {},
): Promise<AssistantTurnResult> {
  const turnId = createTurnId();
  const epoch = activateAssistantTurn(turnId);
  try {
    return await runAssistantTurnBody(userText, broadcast, turnTimer, turnId, epoch, options.filler ?? false);
  } finally {
    finishAssistantTurn(turnId, epoch);
  }
}

async function runAssistantTurnBody(
  userText: string,
  broadcast: (message: WsServerMessage) => void,
  turnTimer: TurnTimer | undefined,
  turnId: string,
  epoch: number,
  allowFiller: boolean,
): Promise<AssistantTurnResult> {
  const normalizedUserText = normalizeInput(userText);
  if (normalizedUserText) {
    logAssistantUserInput(normalizedUserText);
  }
  broadcast({
    type: 'turn_start',
    turnId,
  } satisfies WsTurnStartServerMessage);

  // Plays at once, ahead of the reply's audio in the same turn. With two
  // heads the main head says it (it is main's voice), and its speak_end lets
  // main's face stop talking when it ends: Mini may have the first line.
  const filler = allowFiller ? pickFiller(runtimeConfig.kokoroVoice ?? 'af_heart') : null;
  if (filler) {
    turnTimer?.mark(`Filler "${filler.text}"`);
    if (shouldUseDualHeadDirectedMode()) {
      broadcast({ type: 'audio_chunk', audio: filler.audio, text: filler.text, turnId, actor: 'main', filler: true } satisfies WsAudioChunkServerMessage);
      broadcast({ type: 'speak_end', turnId, actor: 'main', text: filler.text } satisfies WsSpeakEndServerMessage);
    } else {
      broadcast({ type: 'audio_chunk', audio: filler.audio, text: filler.text, turnId, filler: true } satisfies WsAudioChunkServerMessage);
    }
  }

  if (shouldUseDualHeadDirectedMode()) {
    // The first line's TTS starts while the model writes the rest of the script.
    const early: { beat: EarlyBeat | null } = { beat: null };
    try {
      const dualHead = await generateDualHeadReply(userText, turnTimer, runtimeConfig.ttsStreamingEnabled ? {
        onFirstSpeakBeat: (beat) => {
          if (isAssistantTurnActive(turnId, epoch)) early.beat = startEarlyBeat(beat);
        },
      } : {});

      if (turnTimer) {
        if (dualHead.contextMeta?.imageAttached) {
          turnTimer.setMeta('Image', 'attached');
        }
        for (const beat of dualHead.beats) {
          if (beat.action === 'speak' && beat.text?.trim()) {
            const actor = beat.actor === 'small' ? 'Mini' : 'Tubs';
            const emoji = beat.emotion?.emoji ? `${beat.emotion.emoji} ` : '';
            turnTimer.setMeta(actor, `${emoji}${beat.text.trim()}`);
          }
        }
      }

      if (!isAssistantTurnActive(turnId, epoch)) {
        markLastReplyUnheard();
        return {
          turnId,
          reply: {
            text: dualHead.fullText,
            model: dualHead.model,
            latencyMs: dualHead.latencyMs,
            source: dualHead.source,
            emotion: dualHead.emotion,
            contextMeta: dualHead.contextMeta,
            tokens: dualHead.tokens,
            costUsd: dualHead.costUsd,
          },
          superseded: true,
        };
      }

      emitIfActive(turnId, epoch, broadcast, {
        type: 'turn_context',
        turnId,
        meta: dualHead.contextMeta,
      });

      if (!emitIfActive(turnId, epoch, broadcast, {
        type: 'turn_script',
        turnId,
        beats: dualHead.beats,
        ts: Date.now(),
      })) {
        return {
          turnId,
          reply: {
            text: dualHead.fullText,
            model: dualHead.model,
            latencyMs: dualHead.latencyMs,
            source: dualHead.source,
            emotion: dualHead.emotion,
            contextMeta: dualHead.contextMeta,
            tokens: dualHead.tokens,
            costUsd: dualHead.costUsd,
          },
          superseded: true,
        };
      }

      // Stream TTS for speak beats server-side so clients get audio_chunk
      // messages immediately instead of per-beat tts_request round-trips.
      if (runtimeConfig.ttsStreamingEnabled) {
        await streamDualHeadBeatAudio(dualHead.beats, turnId, epoch, broadcast, turnTimer, early.beat);
      }

      sessionStats.messagesOut += 1;
      sessionStats.lastActivity = Date.now();
      sessionStats.tokensIn += dualHead.tokens.in;
      sessionStats.tokensOut += dualHead.tokens.out;
      sessionStats.costUsd += dualHead.costUsd;
      sessionStats.model = dualHead.model;

      emitIfActive(turnId, epoch, broadcast, {
        type: 'stats',
        tokens: dualHead.tokens,
        totals: {
          in: sessionStats.tokensIn,
          out: sessionStats.tokensOut,
          cost: sessionStats.costUsd,
        },
        latency: dualHead.latencyMs,
        model: dualHead.model,
        cost: dualHead.costUsd,
      } satisfies WsStatsServerMessage);

      return {
        turnId,
        reply: {
          text: dualHead.fullText,
          model: dualHead.model,
          latencyMs: dualHead.latencyMs,
          source: dualHead.source,
          emotion: dualHead.emotion,
          contextMeta: dualHead.contextMeta,
          tokens: dualHead.tokens,
          costUsd: dualHead.costUsd,
        },
        beats: dualHead.beats,
      };
    } finally {
      early.beat?.close();
    }
  }

  // Try streaming path: LLM stream → sentence split → TTS WS → audio chunks
  const provider = resolveLlmProvider();
  const authState = provider.getAuthState();
  const useStreaming = runtimeConfig.ttsStreamingEnabled && authState.ready && provider.streamContent;

  if (useStreaming) {
    const streamResult = await runStreamingAssistantTurn({
      userText,
      turnId,
      epoch,
      broadcast,
      ...(turnTimer ? { turnTimer } : {}),
      provider,
      authState,
    });
    if (streamResult) {
      return streamResult;
    }
    console.warn('\x1b[33m\x1b[1m[Streaming]\x1b[0m streaming path returned null — falling through to sequential mode');
  } else {
    const reasons: string[] = [];
    if (!runtimeConfig.ttsStreamingEnabled) reasons.push('ttsStreamingEnabled=false');
    if (!authState.ready) reasons.push('LLM auth not ready');
    if (!provider.streamContent) reasons.push(`provider "${provider.id}" has no streamContent`);
    console.warn(`\x1b[33m\x1b[1m[Streaming]\x1b[0m skipped — ${reasons.join(', ')}`);
  }

  const reply = await generateAssistantReply(userText, turnTimer);

  if (turnTimer) {
    if (reply.contextMeta?.imageAttached) {
      turnTimer.setMeta('Image', 'attached');
    }
    const emoji = reply.emotion?.emoji ? `${reply.emotion.emoji} ` : '';
    turnTimer.setMeta('Tubs', `${emoji}${reply.text}`);
  }

  if (!isAssistantTurnActive(turnId, epoch)) {
    markLastReplyUnheard();
    return { turnId, reply, superseded: true };
  }

  emitIfActive(turnId, epoch, broadcast, {
    type: 'turn_context',
    turnId,
    meta: reply.contextMeta,
  });

  if (!emitIfActive(turnId, epoch, broadcast, {
    type: 'speak',
    text: reply.text,
    ts: Date.now(),
    emotion: reply.emotion,
    turnId,
  } satisfies WsSpeakServerMessage)) {
    return { turnId, reply, superseded: true };
  }

  sessionStats.messagesOut += 1;
  sessionStats.lastActivity = Date.now();
  sessionStats.tokensIn += reply.tokens.in;
  sessionStats.tokensOut += reply.tokens.out;
  sessionStats.costUsd += reply.costUsd;
  sessionStats.model = reply.model;

  emitIfActive(turnId, epoch, broadcast, {
    type: 'stats',
    tokens: reply.tokens,
    totals: {
      in: sessionStats.tokensIn,
      out: sessionStats.tokensOut,
      cost: sessionStats.costUsd,
    },
    latency: reply.latencyMs,
    model: reply.model,
    cost: reply.costUsd,
  } satisfies WsStatsServerMessage);

  return { turnId, reply };
}

/**
 * If the LLM returned a JSON object like {"text":"..."} or {"main":"..."},
 * extract just the text value. Otherwise return the input unchanged.
 */
export async function runProactiveTurn(context: string, broadcast: (message: WsServerMessage) => void): Promise<AssistantTurnResult | null> {
  const turnId = createTurnId();
  const epoch = activateAssistantTurn(turnId);
  try {
    return await runProactiveTurnBody(context, broadcast, turnId, epoch);
  } finally {
    finishAssistantTurn(turnId, epoch);
  }
}

async function runProactiveTurnBody(
  context: string,
  broadcast: (message: WsServerMessage) => void,
  turnId: string,
  epoch: number,
): Promise<AssistantTurnResult | null> {
  broadcast({
    type: 'turn_start',
    turnId,
  } satisfies WsTurnStartServerMessage);

  const reply = shouldUseDualHeadDirectedMode()
    ? await generateDualHeadProactiveReply(context)
    : await generateProactiveReply(context);

  if (!reply) {
    return null;
  }

  if (!isAssistantTurnActive(turnId, epoch)) {
    forgetLastReply();
    return {
      turnId,
      reply: {
        text: isDualHeadReply(reply) ? reply.fullText : reply.text,
        model: reply.model,
        latencyMs: reply.latencyMs,
        source: reply.source,
        emotion: reply.emotion,
        contextMeta: reply.contextMeta,
        tokens: reply.tokens,
        costUsd: reply.costUsd,
      },
      superseded: true,
    };
  }

  emitIfActive(turnId, epoch, broadcast, {
    type: 'turn_context',
    turnId,
    meta: reply.contextMeta,
  });

  const proactiveText = isDualHeadReply(reply) ? reply.fullText : reply.text;

  if (isDualHeadReply(reply)) {
    if (!emitIfActive(turnId, epoch, broadcast, {
      type: 'turn_script',
      turnId,
      beats: reply.beats,
      ts: Date.now(),
    })) {
      return {
        turnId,
        reply: {
          text: proactiveText,
          model: reply.model,
          latencyMs: reply.latencyMs,
          source: reply.source,
          emotion: reply.emotion,
          contextMeta: reply.contextMeta,
          tokens: reply.tokens,
          costUsd: reply.costUsd,
        },
        superseded: true,
      };
    }
  } else {
    if (!emitIfActive(turnId, epoch, broadcast, {
      type: 'speak',
      text: proactiveText,
      ts: Date.now(),
      emotion: reply.emotion,
      turnId,
    } satisfies WsSpeakServerMessage)) {
      return {
        turnId,
        reply: {
          text: proactiveText,
          model: reply.model,
          latencyMs: reply.latencyMs,
          source: reply.source,
          emotion: reply.emotion,
          contextMeta: reply.contextMeta,
          tokens: reply.tokens,
          costUsd: reply.costUsd,
        },
        superseded: true,
      };
    }
  }

  sessionStats.messagesOut += 1;
  sessionStats.lastActivity = Date.now();
  sessionStats.tokensIn += reply.tokens.in;
  sessionStats.tokensOut += reply.tokens.out;
  sessionStats.costUsd += reply.costUsd;
  sessionStats.model = reply.model;

  emitIfActive(turnId, epoch, broadcast, {
    type: 'stats',
    tokens: reply.tokens,
    totals: {
      in: sessionStats.tokensIn,
      out: sessionStats.tokensOut,
      cost: sessionStats.costUsd,
    },
    latency: reply.latencyMs,
    model: reply.model,
    cost: reply.costUsd,
  } satisfies WsStatsServerMessage);

  return {
    turnId,
    reply: {
      text: proactiveText,
      model: reply.model,
      latencyMs: reply.latencyMs,
      source: reply.source,
      emotion: reply.emotion,
      contextMeta: reply.contextMeta,
      tokens: reply.tokens,
      costUsd: reply.costUsd,
    },
    ...(isDualHeadReply(reply) ? { beats: reply.beats } : {}),
  };
}

/**
 * Plays a written two-head script (the operator's manual beats) like a reply:
 * turn_start, turn_script, then each beat's audio from the server. Clients
 * don't render a turn_script's audio themselves while the server streams TTS,
 * so without this a manual script played silent. A new turn cuts it off.
 */
export function playManualTurnScript(beats: TurnBeat[], broadcast: (message: WsServerMessage) => void): { turnId: string; done: Promise<void> } {
  const turnId = createTurnId();
  const epoch = activateAssistantTurn(turnId);
  broadcast({ type: 'turn_start', turnId } satisfies WsTurnStartServerMessage);
  broadcast({ type: 'turn_script', turnId, beats, ts: Date.now() });
  const done = (runtimeConfig.ttsStreamingEnabled ? streamDualHeadBeatAudio(beats, turnId, epoch, broadcast) : Promise.resolve())
    .catch((error: unknown) => {
      console.error('[turn] manual script failed', error);
      broadcast({ type: 'error', text: error instanceof Error ? error.message : 'Manual script failed' });
    })
    .finally(() => finishAssistantTurn(turnId, epoch));
  return { turnId, done };
}
