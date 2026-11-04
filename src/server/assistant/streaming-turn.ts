// Single-head turn streamed sentence by sentence: LLM tokens go through the
// sentence splitter to the TTS socket and on to the faces as audio chunks.

import type { SpeechEmotionPayload, WsAudioChunkServerMessage, WsServerMessage, WsSpeakEndServerMessage, WsStatsServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig, sessionStats } from '../config/runtime.js';
import type { TurnTimer } from '../turn-timing.js';
import type { resolveLlmProvider } from '../llm/provider.js';
import { pickGreetingResponse } from '../persona/index.js';
import { buildAssistantSystemInstruction } from './prompt.js';
import { buildDonationPayload, extractDonationSignal, maybeInjectDonationNudge } from './donation.js';
import { splitTrailingEmotionEmoji } from './emotion.js';
import { MAX_OUTPUT_SENTENCES, clampOutput, createSentenceCap, estimateCostUsd, estimateTokens, sanitizeForTts, stripFormatting, unwrapJsonSpeechText } from './text.js';
import { buildContents, pushHistory, getVisualContext, markLastReplyCutOff } from './context.js';
import { createSentenceSplitter } from './sentence-splitter.js';
import { openTtsStream, type TtsStreamSession } from '../tts/stream.js';
import { logRawModelOutput } from './llm-log.js';
import { type AssistantReply, type AssistantTurnResult, assistantUnavailable } from './reply-types.js';
import { directionFor } from './single-head.js';
import { countReply, emitIfActive, isAssistantTurnActive, onTurnSuperseded, replyCount } from './turn-state.js';

/**
 * Streaming assistant turn: LLM tokens stream in via SSE, get split into sentences,
 * each sentence is sent to Python TTS via WebSocket, and audio chunks are broadcast
 * to clients as they arrive. This creates overlap between LLM generation, TTS
 * synthesis, and audio playback.
 */
export async function runStreamingAssistantTurn(args: {
  userText: string;
  turnId: string;
  epoch: number;
  broadcast: (message: WsServerMessage) => void;
  turnTimer?: TurnTimer;
  provider: ReturnType<typeof resolveLlmProvider>;
  authState: ReturnType<ReturnType<typeof resolveLlmProvider>['getAuthState']>;
}): Promise<AssistantTurnResult | null> {
  const { userText, turnId, epoch, broadcast, turnTimer, provider, authState } = args;
  const normalized = userText.trim();
  const startedAt = Date.now();
  const context = buildContents(normalized, directionFor('single', turnTimer));

  if (!normalized) {
    console.warn('\x1b[33m\x1b[1m[Streaming]\x1b[0m empty input — falling through to sequential');
    return null;
  }

  const greeting = pickGreetingResponse(normalized);
  if (greeting) {
    console.warn('\x1b[33m\x1b[1m[Streaming]\x1b[0m greeting detected — falling through to sequential');
    return null;
  }

  if (!provider.streamContent) {
    console.warn(`\x1b[33m\x1b[1m[Streaming]\x1b[0m provider "${provider.id}" has no streamContent — falling through`);
    return null;
  }

  const abortController = new AbortController();
  let ttsWs: TtsStreamSession | null = null;
  let ttsWsReady = false;
  let pendingTtsSentences = 0;
  let llmDone = false;
  let chunkIndex = 0;
  // Sentences handed to TTS (or to the client as speak_chunk). Audio for them may
  // still be in flight when the LLM stream ends, so chunkIndex can still be 0.
  let sentencesQueued = 0;
  const admitToSpeech = createSentenceCap();
  let fullText = '';
  let sawFirstDelta = false;
  let rawEmotion: SpeechEmotionPayload | null = null;
  let emotionExtracted = false;
  let ttsWsResolve!: () => void;
  const ttsWsDone = new Promise<void>((resolve) => { ttsWsResolve = resolve; });
  let currentTtsSentence = '';

  emitIfActive(turnId, epoch, broadcast, {
    type: 'turn_context',
    turnId,
    meta: context.meta,
  });

  function checkCloseWs(): void {
    if (llmDone && pendingTtsSentences <= 0 && ttsWs && ttsWs.ready) {
      ttsWs.close();
    }
  }

  // Open TTS WebSocket connection in parallel with LLM call
  const endTtsStreamSpan = turnTimer?.span('TTS Stream');
  try {
    ttsWs = openTtsStream({
      onChunk(chunk) {
        if (!isAssistantTurnActive(turnId, epoch)) return;
        if (chunkIndex === 0) {
          turnTimer?.mark('First audio chunk sent');
        }
        broadcast({
          type: 'audio_chunk',
          audio: chunk.audio,
          text: chunk.text || currentTtsSentence,
          turnId,
          chunkIndex: chunkIndex++,
          // The emoji comes first in the reply, so this is set from the first chunk on.
          ...(rawEmotion ? { emotion: rawEmotion } : {}),
        } satisfies WsAudioChunkServerMessage);
      },
      onSentenceDone() {
        pendingTtsSentences = Math.max(0, pendingTtsSentences - 1);
        checkCloseWs();
      },
      onError(error) {
        console.warn(`\x1b[31m\x1b[1m[Streaming]\x1b[0m TTS WS error: ${error.message}`);
        ttsWsReady = false;
      },
      onClose() {
        ttsWsReady = false;
        endTtsStreamSpan?.();
        ttsWsResolve?.();
      },
    });
    // Wait up to 500 ms for the TTS socket; otherwise fall back to sequential.
    ttsWsReady = await Promise.race([
      ttsWs.opened,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]) && ttsWs.ready;
  } catch (error) {
    console.warn(`\x1b[31m\x1b[1m[Streaming]\x1b[0m TTS WebSocket failed to open: ${error instanceof Error ? error.message : 'unknown'} — falling through to sequential`);
    if (ttsWsResolve) ttsWsResolve();
    return null;
  }

  if (!ttsWsReady) {
    console.warn('\x1b[31m\x1b[1m[Streaming]\x1b[0m TTS WebSocket did not connect within 500ms — falling through to sequential');
    ttsWs?.close();
    if (ttsWsResolve) ttsWsResolve();
    return null;
  }

  const kokoroVoice = runtimeConfig.kokoroVoice ?? 'af_heart';
  let historyRecorded = false;
  const removeSupersedeHandler = onTurnSuperseded(epoch, () => {
    abortController.abort();
    ttsWs?.close();
    // Record it now, before the turn that interrupted this one builds its
    // context: what was said so far, marked as cut off.
    historyRecorded = true;
    pushHistory('user', normalized);
    pushHistory('model', fullText || '...');
    markLastReplyCutOff();
  });

  // Track raw LLM output to detect JSON-wrapped responses.
  // When the model returns {"text":"..."} or {"main":"..."}, we strip
  // the JSON envelope so only the prose reaches the sentence splitter.
  let rawAccumulator = '';
  let jsonUnwrapMode: 'unknown' | 'json' | 'plain' = 'unknown';
  let jsonPreambleStripped = false;

  function pushToSplitter(delta: string): void {
    if (jsonUnwrapMode === 'plain') {
      splitter.push(delta);
      return;
    }

    rawAccumulator += delta;

    if (jsonUnwrapMode === 'unknown') {
      const trimmed = rawAccumulator.trimStart();
      if (!trimmed) return;
      if (trimmed[0] !== '{') {
        // Not JSON — flush accumulated text and switch to plain mode
        jsonUnwrapMode = 'plain';
        splitter.push(rawAccumulator);
        rawAccumulator = '';
        return;
      }
      // Looks like JSON — find the first key's value
      const keyMatch = trimmed.match(/^\{\s*"(\w+)"\s*:\s*"/);
      if (keyMatch) {
        jsonUnwrapMode = 'json';
        // Strip everything up to and including the opening quote of the value
        const valueStart = trimmed.indexOf(keyMatch[0]) + keyMatch[0].length;
        rawAccumulator = trimmed.slice(valueStart);
        jsonPreambleStripped = true;
      } else if (rawAccumulator.length > 40) {
        // Accumulated enough — not a recognizable JSON pattern
        jsonUnwrapMode = 'plain';
        splitter.push(rawAccumulator);
        rawAccumulator = '';
        return;
      } else {
        // Still accumulating the JSON preamble — wait for more tokens
        return;
      }
    }

    // In JSON mode: feed text to splitter but watch for closing pattern
    if (jsonUnwrapMode === 'json' && jsonPreambleStripped) {
      // Strip trailing JSON closure: "} or "\n} etc. from the accumulated text.
      // We can't know if we're at the end yet, so just push what we have,
      // and clean up in flush.
      splitter.push(rawAccumulator);
      rawAccumulator = '';
    }
  }

  let qrMarkerSeen = false;
  const splitter = createSentenceSplitter((sentence) => {
    let text = sentence;
    if (/\[\[\s*SHOW[\s_-]*QR\s*\]\]/i.test(sentence)) qrMarkerSeen = true;
    if (!emotionExtracted) {
      const parsed = splitTrailingEmotionEmoji(text);
      if (parsed.emotion) {
        rawEmotion = parsed.emotion;
        emotionExtracted = true;
      }
      text = parsed.text;
    }
    text = sanitizeForTts(stripFormatting(text));
    if (!text) return;
    // Same limit clampOutput applies to non-streamed replies. Later sentences
    // are still parsed above so a trailing emotion emoji is not lost.
    if (!admitToSpeech(text)) {
      console.log(`\x1b[33m[Streaming TTS]\x1b[0m over ${MAX_OUTPUT_SENTENCES} sentences, not spoken → "${text}"`);
      return;
    }

    fullText += (fullText ? ' ' : '') + text;

    console.log(`\x1b[36m[Streaming TTS]\x1b[0m sentence → "${text}"`);
    if (sentencesQueued === 0) {
      turnTimer?.mark('First sentence to TTS');
    }
    sentencesQueued++;
    if (ttsWsReady && ttsWs && ttsWs.ready) {
      pendingTtsSentences++;
      currentTtsSentence = text;
      ttsWs.send(text, kokoroVoice);
    } else {
      console.warn('\x1b[33m\x1b[1m[Streaming]\x1b[0m TTS WS unavailable mid-stream — sending speak_chunk for client-side TTS fallback');
      broadcast({
        type: 'speak_chunk',
        text,
        chunkIndex: chunkIndex++,
        turnId,
      });
    }
  });

  try {
    const endLlmStreamSpan = turnTimer?.span('LLM Stream');
    const llmResult = await provider.streamContent({
      auth: authState.auth,
      model: runtimeConfig.llmModel,
      systemInstruction: buildAssistantSystemInstruction(getVisualContext()),
      contents: context.contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 1,
      timeoutMs: 12_000,
      onChunk: (delta) => {
        if (!isAssistantTurnActive(turnId, epoch)) {
          abortController.abort();
          return;
        }
        if (!sawFirstDelta) {
          sawFirstDelta = true;
          turnTimer?.mark('First LLM token');
        }
        console.log(`\x1b[90m[LLM delta]\x1b[0m ${JSON.stringify(delta)}`);
        pushToSplitter(delta);
      },
      abortSignal: abortController.signal,
    });
    endLlmStreamSpan?.();
    logRawModelOutput('stream', llmResult.text);
    const stillActive = isAssistantTurnActive(turnId, epoch);
    if (stillActive) {
      splitter.flush();
    }

    // If the splitter produced nothing speakable, send the full text once.
    // Before llmDone/checkCloseWs: with nothing pending, that closes the socket.
    if (stillActive && sentencesQueued === 0 && llmResult.text) {
      const unwrapped = unwrapJsonSpeechText(llmResult.text);
      const parsed = splitTrailingEmotionEmoji(stripFormatting(unwrapped));
      rawEmotion = parsed.emotion;
      fullText = sanitizeForTts(parsed.text);
      if (fullText && ttsWsReady && ttsWs && ttsWs.ready) {
        pendingTtsSentences++;
        ttsWs.send(fullText, kokoroVoice);
      }
    }
    llmDone = true;
    checkCloseWs();

    // Wait for TTS to finish sending all audio
    if (pendingTtsSentences > 0) {
      await Promise.race([
        ttsWsDone,
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);
    }
    // Also after a timeout: an unclosed socket leaks here and a thread in the TTS service.
    ttsWs?.close();

    if (!fullText && !isAssistantTurnActive(turnId, epoch)) {
      // Interrupted before the first word. The supersede handler already
      // recorded the cut-off; falling through would run a second LLM call
      // for a turn nobody is waiting for.
      return {
        turnId,
        reply: {
          text: '',
          model: runtimeConfig.llmModel,
          latencyMs: Date.now() - startedAt,
          source: 'llm',
          donation: null,
          emotion: null,
          contextMeta: context.meta,
          tokens: { in: 0, out: 0 },
          costUsd: 0,
        },
        superseded: true,
      };
    }

    if (!fullText) {
      fullText = clampOutput(sanitizeForTts(stripFormatting(unwrapJsonSpeechText(llmResult.text))));
    }

    if (!fullText) {
      console.warn('\x1b[33m\x1b[1m[Streaming]\x1b[0m LLM stream produced empty text — falling through to sequential');
      return null;
    }

    const donationSignal = extractDonationSignal(fullText);
    // Sentences were sanitized for TTS, which drops [[SHOW_QR]]; it was noted on the raw text.
    if (qrMarkerSeen && !donationSignal.donation.show) {
      donationSignal.donation = buildDonationPayload(true, 'marker');
    }
    const nudged = maybeInjectDonationNudge(donationSignal.text, Boolean(donationSignal.donation.show), replyCount());
    const donation = nudged.forcedQr
      ? buildDonationPayload(true, 'periodic_nudge')
      : donationSignal.donation;
    // Already capped sentence by sentence above; the character clamp would cut
    // the chat and history text short of what was spoken.
    fullText = nudged.text;

    if (turnTimer) {
      if (context.meta?.imageAttached) {
        turnTimer.setMeta('Image', 'attached');
      }
      const emoji = rawEmotion?.emoji ? `${rawEmotion.emoji} ` : '';
      turnTimer.setMeta('Tubs', `${emoji}${fullText}`);
    }

    // Always send speak_end if we sent any audio chunks — the client needs it
    // to finalize streaming state even if the turn was interrupted/superseded.
    if (chunkIndex > 0 || isAssistantTurnActive(turnId, epoch)) {
      broadcast({
        type: 'speak_end',
        turnId,
        emotion: rawEmotion,
        donation,
        fullText,
      } satisfies WsSpeakEndServerMessage);
    }

    const tokensIn = Number(llmResult.usage.promptTokenCount || 0) || estimateTokens(normalized);
    const tokensOut = Number(llmResult.usage.candidatesTokenCount || 0) || estimateTokens(fullText);
    countReply();
    if (!historyRecorded) {
      pushHistory('user', normalized);
      pushHistory('model', fullText);
    }

    const reply: AssistantReply = {
      text: fullText,
      model: llmResult.model || runtimeConfig.llmModel,
      latencyMs: Date.now() - startedAt,
      source: 'llm',
      donation,
      emotion: rawEmotion,
      contextMeta: context.meta,
      tokens: { in: tokensIn, out: tokensOut },
      costUsd: estimateCostUsd(tokensIn, tokensOut),
    };

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

    console.log(`\x1b[32m\x1b[1m[Streaming]\x1b[0m completed — ${chunkIndex} audio chunks, ${reply.latencyMs}ms total`);

    return {
      turnId,
      reply,
      superseded: !isAssistantTurnActive(turnId, epoch),
    };
  } catch (error) {
    ttsWs?.close();
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\x1b[31m\x1b[1m[Streaming]\x1b[0m streaming turn failed hard: ${msg}`);
    // If any audio chunks were already broadcast, send speak_end so the
    // client can finalize its streaming session instead of getting stuck.
    if (chunkIndex > 0) {
      broadcast({
        type: 'speak_end',
        turnId,
      } satisfies WsSpeakEndServerMessage);
      console.log(`\x1b[36m[Streaming]\x1b[0m sent speak_end after error (${chunkIndex} chunks were in flight)`);
    }
    throw error instanceof Error
      ? error
      : assistantUnavailable('[streaming] Assistant streaming turn failed');
  } finally {
    removeSupersedeHandler();
  }
}
