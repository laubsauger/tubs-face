import { randomBytes } from 'node:crypto';
import type { TurnBeat, TurnContextMeta, TurnDonation, TurnEmotion } from '../../shared/contracts/turn-script.js';
import type { SpeechEmotionPayload, WsAudioChunkServerMessage, WsServerMessage, WsSpeakEndServerMessage, WsSpeakServerMessage, WsStatsServerMessage, WsTurnStartServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig, sessionStats } from '../config/runtime.js';
import type { TurnTimer } from '../turn-timing.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { pickGreetingResponse } from '../persona/index.js';
import { buildAssistantSystemInstruction, buildDualHeadSystemInstruction } from './prompt.js';
import { buildDonationPayload, extractDonationSignal, maybeInjectDonationNudge } from './donation.js';
import { defaultDualHeadSpeakEmotion, splitTrailingEmotionEmoji } from './emotion.js';
import { clampOutput, estimateCostUsd, estimateTokens, normalizeInput, stripFormatting } from './text.js';
import { buildContents, buildProactiveContents, pushHistory, getVisualContext } from './context.js';
import { createSentenceSplitter } from './sentence-splitter.js';
import { openTtsStream, type TtsStreamSession } from '../tts/stream.js';
import {
  DUAL_HEAD_RESPONSE_SCHEMA,
  hasRequiredDualHeadCoverage,
  mergeDonationSignalFromBeats,
  type ParsedDualHeadScript,
  parseDualHeadScript,
  rescueBeatsFromRawText,
  shouldUseDualHeadDirectedMode,
  summarizeDualHeadBeatsForLog,
} from './dual-head.js';

export interface AssistantReply {
  text: string;
  model: string;
  latencyMs: number;
  source: 'greeting' | 'llm';
  donation: TurnDonation | null;
  emotion: SpeechEmotionPayload | null;
  contextMeta: TurnContextMeta;
  tokens: {
    in: number;
    out: number;
  };
  costUsd: number;
}

export interface AssistantTurnResult {
  turnId: string;
  reply: AssistantReply;
  superseded?: boolean;
}

interface DualHeadReply {
  beats: TurnBeat[];
  donation: TurnDonation | null;
  model: string;
  latencyMs: number;
  tokens: {
    in: number;
    out: number;
  };
  costUsd: number;
  source: 'greeting' | 'llm';
  fullText: string;
  emotion: SpeechEmotionPayload | null;
  contextMeta: TurnContextMeta;
}

export function createTurnId(): string {
  return randomBytes(6).toString('hex');
}

let assistantReplyCount = 0;
let activeTurnEpoch = 0;
let activeTurnId: string | null = null;
const PERSONA_DRIFT_PHRASE_RE = /\b(certainly|however|it's important to remember|do you have any other questions|any other questions or topics you'd like to discuss|let me know if you|in conclusion)\b/i;
const PERSONA_DRIFT_FORMAL_RE = /\b(representation|subjective|therefore|additionally|furthermore|moreover)\b/i;
const PERSONA_MARKER_RE = /\b(tubs|rapha|wheel|wheels|venmo|thailand|robot|plastic tubs?)\b/i;
const CONTRACTION_RE = /\b(i'm|you're|we're|that's|it's|don't|can't|won't|let's)\b/i;
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

function assistantUnavailable(message: string): Error {
  const error = new Error(message);
  error.name = 'AssistantUnavailableError';
  return error;
}

export function interruptAssistantTurns(): string | null {
  const previousTurnId = activeTurnId;
  activeTurnEpoch += 1;
  activeTurnId = null;
  return previousTurnId;
}

function activateAssistantTurn(turnId: string): number {
  activeTurnEpoch += 1;
  activeTurnId = turnId;
  return activeTurnEpoch;
}

function isAssistantTurnActive(turnId: string, epoch: number): boolean {
  return activeTurnEpoch === epoch && activeTurnId === turnId;
}

function emitIfActive(
  turnId: string,
  epoch: number,
  broadcast: (message: WsServerMessage) => void,
  message: WsServerMessage,
): boolean {
  if (!isAssistantTurnActive(turnId, epoch)) {
    return false;
  }
  broadcast(message);
  return true;
}

export async function generateAssistantReply(userText: string, turnTimer?: TurnTimer): Promise<AssistantReply> {
  const normalized = userText.trim();
  const startedAt = Date.now();
  const context = buildContents(normalized);
  if (!normalized) {
    const text = 'I did not catch that. Try again.';
    return {
      text,
      model: runtimeConfig.llmModel,
      latencyMs: Date.now() - startedAt,
      source: 'llm',
      donation: buildDonationPayload(false),
      emotion: null,
      contextMeta: context.meta,
      tokens: {
        in: 1,
        out: estimateTokens(text),
      },
      costUsd: 0,
    };
  }

  const greeting = pickGreetingResponse(normalized);
  if (greeting) {
    const parsed = splitTrailingEmotionEmoji(greeting);
    const text = parsed.text || 'Hey.';
    assistantReplyCount += 1;
    pushHistory('user', normalized);
    pushHistory('model', text);
    return {
      text,
      model: 'fast-greeting',
      latencyMs: Date.now() - startedAt,
      source: 'greeting',
      donation: buildDonationPayload(false),
      emotion: parsed.emotion,
      contextMeta: context.meta,
      tokens: {
        in: estimateTokens(normalized),
        out: estimateTokens(text),
      },
      costUsd: 0,
    };
  }

  const provider = resolveLlmProvider();
  const authState = provider.getAuthState();
  if (!authState.ready) {
    if (authState.warningMessage) {
      console.warn(authState.warningMessage);
    }
    throw assistantUnavailable(authState.warningMessage || '[assistant] LLM provider unavailable');
  }

  try {
    const endLlmSpan = turnTimer?.span('LLM API Call');
    const result = await provider.generateContent({
      auth: authState.auth,
      model: runtimeConfig.llmModel,
      systemInstruction: buildAssistantSystemInstruction(getVisualContext()),
      contents: context.contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 1,
      timeoutMs: 12_000,
    });
    endLlmSpan?.();
    let cleaned = stripFormatting(result.text);
    const repaired = await maybeRepairPersonaDrift({
      draftText: cleaned,
      userInput: normalized,
      provider,
      auth: authState.auth,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      phase: 'reply',
      ...(turnTimer ? { turnTimer } : {}),
    });
    if (repaired.repaired) {
      cleaned = repaired.text;
    }
    const parsed = splitTrailingEmotionEmoji(cleaned);
    const donationSignal = extractDonationSignal(parsed.text);
    const nudged = maybeInjectDonationNudge(
      donationSignal.text,
      Boolean(donationSignal.donation.show),
      assistantReplyCount,
    );
    const text = clampOutput(nudged.text);
    if (!text) {
      throw assistantUnavailable('[assistant] LLM returned empty reply text');
    }

    const tokensIn = (Number(result.usage.promptTokenCount || 0) + repaired.usageIn) || estimateTokens(normalized);
    const tokensOut = (Number(result.usage.candidatesTokenCount || 0) + repaired.usageOut) || estimateTokens(text);
    const donation = nudged.forcedQr
      ? buildDonationPayload(true, 'periodic_nudge')
      : donationSignal.donation;
    assistantReplyCount += 1;
    pushHistory('user', normalized);
    pushHistory('model', text);

    return {
      text,
      model: result.model || runtimeConfig.llmModel,
      latencyMs: Date.now() - startedAt,
      source: 'llm',
      donation,
      emotion: parsed.emotion,
      contextMeta: context.meta,
      tokens: {
        in: tokensIn,
        out: tokensOut,
      },
      costUsd: estimateCostUsd(tokensIn, tokensOut),
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[assistant] ${provider.id} generation failed: ${error.message}`);
    }
    throw error instanceof Error ? error : assistantUnavailable('[assistant] Response generation failed');
  }
}

async function maybeRepairPersonaDrift(args: {
  draftText: string;
  userInput: string;
  provider: ReturnType<typeof resolveLlmProvider>;
  auth: Record<string, string> | null;
  maxOutputTokens: number;
  phase: 'reply' | 'dual';
  turnTimer?: TurnTimer;
}): Promise<{ text: string; usageIn: number; usageOut: number; repaired: boolean }> {
  const normalizedDraft = normalizeInput(args.draftText);
  const personaDriftReason = isPersonaDrift(normalizedDraft);
  const langDriftReason = isLanguageDrift(normalizedDraft, args.userInput);
  const driftReason = langDriftReason || personaDriftReason;

  if (!normalizedDraft || !driftReason) {
    return {
      text: normalizedDraft,
      usageIn: 0,
      usageOut: 0,
      repaired: false,
    };
  }

  console.warn(`\x1b[33m\x1b[1m[LLM:${args.phase}] Persona drift detected (${driftReason}); requesting strict rewrite.\x1b[0m`);
  args.turnTimer?.mark(`LLM Rewrite triggered (${driftReason})`);
  const strictSystemInstruction = [
    buildAssistantSystemInstruction(getVisualContext()),
    'STRICT STYLE OVERRIDE:',
    '- Rewrite the draft in Tubs voice: dry, chaotic, sharp, entirely natural.',
    '- Absolute maximum 1-2 punchy sentences. BE EXTREMELY BRIEF.',
    '- Never use these phrases: "certainly", "however", "it\'s important to remember", "do you have any other questions", "any other questions or topics".',
    '- End with a hook, a judgment, or a question.',
    '- Return only the rewritten reply text. No quotes. No introductory text.',
  ].join('\n');
  const rewritePrompt = [
    `User said: "${normalizeInput(args.userInput)}"`,
    `Draft reply (too generic): "${normalizedDraft}"`,
    'Rewrite the draft so it sounds unmistakably like Tubs.',
  ].join('\n');
  const llmResult = await args.provider.generateContent({
    auth: args.auth,
    model: runtimeConfig.llmModel,
    systemInstruction: strictSystemInstruction,
    contents: [{ role: 'user', parts: [{ text: rewritePrompt }] }],
    maxOutputTokens: Math.min(220, Number(args.maxOutputTokens || runtimeConfig.llmMaxOutputTokens || 256)),
    temperature: 0.95,
    timeoutMs: 15_000,
  });

  let rewritten = stripOuterQuotes(stripFormatting(llmResult.text));
  if (!rewritten) {
    return {
      text: normalizedDraft,
      usageIn: 0,
      usageOut: 0,
      repaired: false,
    };
  }
  if (!splitTrailingEmotionEmoji(rewritten).emotion) {
    rewritten = `😏 ${rewritten}`;
  }
  if (isLanguageDrift(rewritten, args.userInput) || isPersonaDrift(splitTrailingEmotionEmoji(rewritten).text)) {
    return {
      text: normalizedDraft,
      usageIn: 0,
      usageOut: 0,
      repaired: false,
    };
  }

  return {
    text: clampOutput(rewritten),
    usageIn: Number(llmResult.usage.promptTokenCount || 0),
    usageOut: Number(llmResult.usage.candidatesTokenCount || 0),
    repaired: true,
  };
}

async function maybeRepairDualHeadScript(args: {
  rawText: string;
  userInput: string;
  provider: ReturnType<typeof resolveLlmProvider>;
  auth: Record<string, string> | null;
  systemInstruction: string;
  model: string;
}): Promise<{ script: ParsedDualHeadScript | null; usageIn: number; usageOut: number; repaired: boolean }> {
  const rawText = String(args.rawText ?? '').trim();
  if (!rawText) {
    return { script: null, usageIn: 0, usageOut: 0, repaired: false };
  }

  const repairSystemInstruction = [
    args.systemInstruction,
    '',
    'You are repairing malformed model output into strict JSON.',
    'Return only a valid JSON object with a top-level "beats" array.',
    'Do not add commentary, markdown, or code fences.',
    'Preserve the original wording and beat intent as much as possible.',
    'Do not invent new dialogue unless required to make the structure valid.',
    'If a beat has dialogue text, set action to "speak".',
    'If a beat is silent, use action "react" with emoji and/or delayMs only.',
    'Allowed actors: "main", "small".',
    'Allowed actions: "speak", "react".',
  ].join('\n');

  const repairPrompt = [
    `Original user input: ${normalizeInput(args.userInput) || '[none]'}`,
    'Malformed raw model output to repair:',
    rawText,
    '',
    'Return repaired JSON only.',
  ].join('\n');

  const result = await args.provider.generateContent({
    auth: args.auth,
    model: args.model,
    systemInstruction: repairSystemInstruction,
    contents: [{ role: 'user', parts: [{ text: repairPrompt }] }],
    maxOutputTokens: Math.max(220, Math.min(runtimeConfig.llmMaxOutputTokens, 420)),
    temperature: 0,
    timeoutMs: 12_000,
    responseMimeType: 'application/json',
    responseSchema: DUAL_HEAD_RESPONSE_SCHEMA,
  });

  const repaired = parseDualHeadScript(result.text);
  if (!repaired || !hasRequiredDualHeadCoverage(repaired.beats)) {
    logDualHeadInvalidScript(result.text, 'Repair pass still returned invalid dual-head JSON.');
    return {
      script: null,
      usageIn: Number(result.usage.promptTokenCount || 0),
      usageOut: Number(result.usage.candidatesTokenCount || 0),
      repaired: false,
    };
  }

  return {
    script: repaired,
    usageIn: Number(result.usage.promptTokenCount || 0),
    usageOut: Number(result.usage.candidatesTokenCount || 0),
    repaired: true,
  };
}

function isPersonaDrift(text: string): string | null {
  const normalized = normalizeInput(text).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (PERSONA_DRIFT_PHRASE_RE.test(normalized)) {
    const match = normalized.match(PERSONA_DRIFT_PHRASE_RE)?.[1] || 'forbidden phrase';
    return `forbidden phrase: "${match}"`;
  }
  if (PERSONA_DRIFT_FORMAL_RE.test(normalized) && !CONTRACTION_RE.test(normalized)) {
    const match = normalized.match(PERSONA_DRIFT_FORMAL_RE)?.[1] || 'formal word';
    return `formal word: "${match}"`;
  }
  if (normalized.length > 110 && !normalized.includes('?')) {
    return 'too long and lacking questions';
  }
  if (normalized.length > 90 && !PERSONA_MARKER_RE.test(normalized) && !CONTRACTION_RE.test(normalized)) {
    return 'too long and lacking persona markers';
  }
  return null;
}

function isLanguageDrift(text: string, userInput: string): string | null {
  if (!isMostlyAsciiEnglish(userInput)) {
    return null;
  }
  if (CJK_RE.test(String(text || ''))) {
    return 'cjk characters detected';
  }
  return null;
}

function isMostlyAsciiEnglish(text: string): boolean {
  const normalized = normalizeInput(text);
  if (!normalized) {
    return true;
  }
  const letters = normalized.match(/[A-Za-z]/g) || [];
  const asciiFriendly = normalized.match(/[A-Za-z0-9\s.,!?'"()\-:;]/g) || [];
  if (letters.length === 0) {
    return false;
  }
  return asciiFriendly.length / normalized.length >= 0.85;
}

function stripOuterQuotes(text: string): string {
  const normalized = normalizeInput(text);
  return normalized.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
}

function formatDualHeadRawForLog(rawText: string): string {
  const normalized = String(rawText ?? '')
    .replace(/\r/g, '')
    .trim();
  if (!normalized) {
    return '[empty response]';
  }
  const limited = normalized.length > 2400
    ? `${normalized.slice(0, 2400)}\n...[truncated ${normalized.length - 2400} chars]`
    : normalized;
  return limited;
}

function logDualHeadInvalidScript(rawText: string, reason: string): void {
  const block = [
    `[LLM:dual] ${reason}`,
    '[LLM:dual] Raw model output begin',
    formatDualHeadRawForLog(rawText),
    '[LLM:dual] Raw model output end',
  ].join('\n');
  process.stderr.write(`${block}\n`);
}

export async function runAssistantTurn(userText: string, broadcast: (message: WsServerMessage) => void, turnTimer?: TurnTimer): Promise<AssistantTurnResult> {
  const turnId = createTurnId();
  const epoch = activateAssistantTurn(turnId);
  broadcast({
    type: 'turn_start',
    turnId,
  } satisfies WsTurnStartServerMessage);

  if (shouldUseDualHeadDirectedMode()) {
    const dualHead = await generateDualHeadReply(userText, turnTimer);

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
      return {
        turnId,
        reply: {
          text: dualHead.fullText,
          model: dualHead.model,
          latencyMs: dualHead.latencyMs,
          source: dualHead.source,
          donation: dualHead.donation,
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
      ...(dualHead.donation ? { donation: dualHead.donation } : {}),
      ts: Date.now(),
    })) {
      return {
        turnId,
        reply: {
          text: dualHead.fullText,
          model: dualHead.model,
          latencyMs: dualHead.latencyMs,
          source: dualHead.source,
          donation: dualHead.donation,
          emotion: dualHead.emotion,
          contextMeta: dualHead.contextMeta,
          tokens: dualHead.tokens,
          costUsd: dualHead.costUsd,
        },
        superseded: true,
      };
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
        donation: dualHead.donation,
        emotion: dualHead.emotion,
        contextMeta: dualHead.contextMeta,
        tokens: dualHead.tokens,
        costUsd: dualHead.costUsd,
      },
    };
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
      turnTimer,
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
    donation: reply.donation,
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
 * Streaming assistant turn: LLM tokens stream in via SSE, get split into sentences,
 * each sentence is sent to Python TTS via WebSocket, and audio chunks are broadcast
 * to clients as they arrive. This creates overlap between LLM generation, TTS
 * synthesis, and audio playback.
 */
async function runStreamingAssistantTurn(args: {
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
  const context = buildContents(normalized);

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
  let fullText = '';
  let rawEmotion: SpeechEmotionPayload | null = null;
  let emotionExtracted = false;
  let ttsWsResolve: (() => void) | null = null;
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
        broadcast({
          type: 'audio_chunk',
          audio: chunk.audio,
          text: chunk.text || currentTtsSentence,
          turnId,
          chunkIndex: chunkIndex++,
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
    // Wait briefly for the WS to connect
    await new Promise<void>((resolve) => {
      const check = () => {
        if (ttsWs!.ready || ttsWs!.closed) {
          ttsWsReady = ttsWs!.ready;
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
      setTimeout(() => { resolve(); }, 500); // max wait 500ms for connection
    });
    ttsWsReady = ttsWs.ready;
  } catch (error) {
    console.warn(`\x1b[31m\x1b[1m[Streaming]\x1b[0m TTS WebSocket failed to open: ${error instanceof Error ? error.message : 'unknown'} — falling through to sequential`);
    ttsWsResolve?.();
    return null;
  }

  if (!ttsWsReady) {
    console.warn('\x1b[31m\x1b[1m[Streaming]\x1b[0m TTS WebSocket did not connect within 500ms — falling through to sequential');
    ttsWs?.close();
    ttsWsResolve?.();
    return null;
  }

  const kokoroVoice = runtimeConfig.kokoroVoice ?? 'af_heart';

  const splitter = createSentenceSplitter((sentence) => {
    let text = sentence;
    if (!emotionExtracted) {
      const parsed = splitTrailingEmotionEmoji(text);
      if (parsed.emotion) {
        rawEmotion = parsed.emotion;
        emotionExtracted = true;
      }
      text = parsed.text;
    }
    text = stripFormatting(text);
    if (!text) return;

    fullText += (fullText ? ' ' : '') + text;

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
        splitter.push(delta);
      },
      abortSignal: abortController.signal,
    });
    endLlmStreamSpan?.();
    splitter.flush();
    llmDone = true;
    checkCloseWs();

    // If no chunks were sent (very short response), send full text
    if (chunkIndex === 0 && llmResult.text) {
      const parsed = splitTrailingEmotionEmoji(stripFormatting(llmResult.text));
      rawEmotion = parsed.emotion;
      fullText = parsed.text;
      if (fullText && ttsWsReady && ttsWs && ttsWs.ready) {
        pendingTtsSentences++;
        ttsWs.send(fullText, kokoroVoice);
      }
    }

    // Wait for TTS to finish sending all audio
    if (pendingTtsSentences > 0) {
      await Promise.race([
        ttsWsDone,
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);
    } else {
      ttsWs?.close();
    }

    if (!fullText) {
      fullText = clampOutput(stripFormatting(llmResult.text));
    }

    if (!fullText) {
      console.warn('\x1b[33m\x1b[1m[Streaming]\x1b[0m LLM stream produced empty text — falling through to sequential');
      return null;
    }

    const donationSignal = extractDonationSignal(fullText);
    const nudged = maybeInjectDonationNudge(donationSignal.text, Boolean(donationSignal.donation.show), assistantReplyCount);
    const donation = nudged.forcedQr
      ? buildDonationPayload(true, 'periodic_nudge')
      : donationSignal.donation;
    fullText = clampOutput(nudged.text);

    // Send speak_end to finalize streaming on the client
    emitIfActive(turnId, epoch, broadcast, {
      type: 'speak_end',
      turnId,
      emotion: rawEmotion,
      donation,
      fullText,
    } satisfies WsSpeakEndServerMessage);

    const tokensIn = Number(llmResult.usage.promptTokenCount || 0) || estimateTokens(normalized);
    const tokensOut = Number(llmResult.usage.candidatesTokenCount || 0) || estimateTokens(fullText);
    assistantReplyCount += 1;
    pushHistory('user', normalized);
    pushHistory('model', fullText);

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
    console.error(`\x1b[31m\x1b[1m[Streaming]\x1b[0m streaming turn threw: ${msg} — falling through to sequential`);
    return null;
  }
}

export async function runProactiveTurn(context: string, broadcast: (message: WsServerMessage) => void): Promise<AssistantTurnResult | null> {
  const turnId = createTurnId();
  const epoch = activateAssistantTurn(turnId);
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
    return {
      turnId,
      reply: {
        text: isDualHeadReply(reply) ? reply.fullText : reply.text,
        model: reply.model,
        latencyMs: reply.latencyMs,
        source: reply.source,
        donation: reply.donation,
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
      ...(reply.donation ? { donation: reply.donation } : {}),
      ts: Date.now(),
    })) {
      return {
        turnId,
        reply: {
          text: proactiveText,
          model: reply.model,
          latencyMs: reply.latencyMs,
          source: reply.source,
          donation: reply.donation,
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
      donation: reply.donation,
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
          donation: reply.donation,
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
      donation: reply.donation,
      emotion: reply.emotion,
      contextMeta: reply.contextMeta,
      tokens: reply.tokens,
      costUsd: reply.costUsd,
    },
  };
}

async function generateDualHeadReply(userText: string, turnTimer?: TurnTimer): Promise<DualHeadReply> {
  const startedAt = Date.now();
  const normalized = userText.trim();
  const context = buildContents(normalized);
  const provider = resolveLlmProvider();
  const authState = provider.getAuthState();

  if (!normalized) {
    const text = 'I did not catch that. Try again.';
    return {
      beats: [{
        actor: 'main',
        action: 'speak',
        text,
        emotion: toTurnEmotion(defaultDualHeadSpeakEmotion('main')),
      }],
      donation: buildDonationPayload(false),
      model: runtimeConfig.llmModel,
      latencyMs: Date.now() - startedAt,
      tokens: {
        in: 1,
        out: estimateTokens(text),
      },
      costUsd: 0,
      source: 'llm',
      fullText: text,
      emotion: defaultDualHeadSpeakEmotion('main'),
      contextMeta: context.meta,
    };
  }

  if (!authState.ready) {
    if (authState.warningMessage) {
      console.warn(authState.warningMessage);
    }
    throw assistantUnavailable(authState.warningMessage || '[assistant] Dual-head LLM provider unavailable');
  }

  try {
    const dualHeadModel = String(process.env.DUAL_HEAD_LLM_MODEL || '').trim() || runtimeConfig.llmModel;
    let repairUsageIn = 0;
    let repairUsageOut = 0;
    const endLlmSpan = turnTimer?.span('LLM API Call');
    const result = await provider.generateContent({
      auth: authState.auth,
      model: dualHeadModel,
      systemInstruction: buildDualHeadSystemInstruction(getVisualContext()),
      contents: context.contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: Math.max(0, Math.min(1.2, Number.parseFloat(String(process.env.DUAL_HEAD_TEMPERATURE || '0.25')) || 0.25)),
      timeoutMs: 18_000,
      responseMimeType: 'application/json',
      responseSchema: DUAL_HEAD_RESPONSE_SCHEMA,
    });
    endLlmSpan?.();

    let script = parseDualHeadScript(result.text);
    if (!script) {
      logDualHeadInvalidScript(result.text, 'Invalid script JSON, attempting regex rescue from raw text.');
      const rescued = rescueBeatsFromRawText(result.text);
      if (rescued && hasRequiredDualHeadCoverage(rescued.beats)) {
        script = rescued;
      } else {
        turnTimer?.mark('LLM Rewrite triggered (dual-head JSON repair)');
        const repaired = await maybeRepairDualHeadScript({
          rawText: result.text,
          userInput: normalized,
          provider,
          auth: authState.auth,
          systemInstruction: buildDualHeadSystemInstruction(getVisualContext()),
          model: dualHeadModel,
        });
        repairUsageIn += repaired.usageIn;
        repairUsageOut += repaired.usageOut;
        if (repaired.script) {
          script = repaired.script;
        }
      }
    }
    if (!script || !hasRequiredDualHeadCoverage(script.beats)) {
      logDualHeadInvalidScript(result.text, 'No valid dual-head script returned by LLM.');
      throw new Error('No valid dual-head script returned by LLM');
    }

    let { beats, donation } = mergeDonationSignalFromBeats(script.beats);
    let fullText = beats
      .filter((beat) => beat.action === 'speak')
      .map((beat) => beat.text?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();

    const nudged = maybeInjectDonationNudge(fullText, Boolean(donation.show), assistantReplyCount);
    if (nudged.forcedQr) {
      donation = buildDonationPayload(true, 'periodic_nudge');
      const nudgeText = `Venmo @${donation.venmoHandle ?? 'TubsBot'}.`;
      beats = [
        ...beats,
        {
          actor: 'main',
          action: 'speak',
          text: nudgeText,
          emotion: toTurnEmotion(defaultDualHeadSpeakEmotion('main')),
        },
      ];
      fullText = `${fullText} ${nudgeText}`.trim();
    }

    fullText = clampOutput(fullText);
    if (!fullText) {
      throw new Error('Dual-head script produced empty output');
    }

    const tokensIn = (Number(result.usage.promptTokenCount || 0) + repairUsageIn) || estimateTokens(normalized);
    const tokensOut = (Number(result.usage.candidatesTokenCount || 0) + repairUsageOut) || estimateTokens(fullText);
    const primaryEmotion = beats.find((beat) => beat.actor === 'main' && beat.emotion)?.emotion ?? null;
    assistantReplyCount += 1;
    pushHistory('user', normalized);
    pushHistory('model', fullText);
    console.log(`[LLM:dual] turn_script beats=${beats.length} donation=${donation.show ? donation.reason : 'none'}${summarizeDualHeadBeatsForLog(beats, { userInput: normalized })}`);

    return {
      beats,
      donation,
      model: result.model || dualHeadModel,
      latencyMs: Date.now() - startedAt,
      tokens: {
        in: tokensIn,
        out: tokensOut,
      },
      costUsd: estimateCostUsd(tokensIn, tokensOut),
      source: 'llm',
      fullText,
      emotion: primaryEmotion ? fromTurnEmotion(primaryEmotion) : null,
      contextMeta: context.meta,
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[assistant] dual-head generation failed: ${error.message}`);
    }
    throw error instanceof Error ? error : assistantUnavailable('[assistant] Dual-head generation failed');
  }
}

async function generateProactiveReply(context: string): Promise<AssistantReply | null> {
  const startedAt = Date.now();
  const provider = resolveLlmProvider();
  const authState = provider.getAuthState();
  if (!authState.ready) {
    return null;
  }

  const contents = buildProactiveContents(context);
  const proactiveInstruction = `${buildAssistantSystemInstruction(getVisualContext())}\n\nPROACTIVE: You are starting conversation unprompted. ${context}\nOne punchy sentence. Be curious, weird, or provocative and make them want to respond.`;

  try {
    const result = await provider.generateContent({
      auth: authState.auth,
      model: runtimeConfig.llmModel,
      systemInstruction: proactiveInstruction,
      contents: contents.contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 1,
      timeoutMs: 12_000,
    });

    let cleaned = stripFormatting(result.text);
    const repaired = await maybeRepairPersonaDrift({
      draftText: cleaned,
      userInput: context,
      provider,
      auth: authState.auth,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      phase: 'reply',
    });
    if (repaired.repaired) {
      cleaned = repaired.text;
    }
    const parsed = splitTrailingEmotionEmoji(cleaned);
    const donationSignal = extractDonationSignal(parsed.text);
    const text = clampOutput(donationSignal.text);
    if (!text) {
      return null;
    }

    pushHistory('model', text);
    assistantReplyCount += 1;
    const tokensIn = (Number(result.usage.promptTokenCount || 0) + repaired.usageIn) || estimateTokens(context);
    const tokensOut = (Number(result.usage.candidatesTokenCount || 0) + repaired.usageOut) || estimateTokens(text);
    return {
      text,
      model: result.model || runtimeConfig.llmModel,
      latencyMs: Date.now() - startedAt,
      source: 'llm',
      donation: donationSignal.donation,
      emotion: parsed.emotion,
      contextMeta: contents.meta,
      tokens: {
        in: tokensIn,
        out: tokensOut,
      },
      costUsd: estimateCostUsd(tokensIn, tokensOut),
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[assistant] proactive generation failed: ${error.message}`);
    }
    return null;
  }
}

async function generateDualHeadProactiveReply(context: string): Promise<DualHeadReply | null> {
  const startedAt = Date.now();
  const provider = resolveLlmProvider();
  const authState = provider.getAuthState();
  if (!authState.ready) {
    return null;
  }

  const contents = buildProactiveContents(context);
  const systemInstruction = `${buildDualHeadSystemInstruction(getVisualContext())}\n\nPROACTIVE: You are starting conversation unprompted. ${context}\nOne punchy sentence from main. Small head should chime in with something creative, a roast, a jab, or an unhinged observation.`;

  try {
    const dualHeadModel = String(process.env.DUAL_HEAD_LLM_MODEL || '').trim() || runtimeConfig.llmModel;
    let repairUsageIn = 0;
    let repairUsageOut = 0;
    const result = await provider.generateContent({
      auth: authState.auth,
      model: dualHeadModel,
      systemInstruction,
      contents: contents.contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: Math.max(0, Math.min(1.2, Number.parseFloat(String(process.env.DUAL_HEAD_TEMPERATURE || '0.25')) || 0.25)),
      timeoutMs: 18_000,
      responseMimeType: 'application/json',
      responseSchema: DUAL_HEAD_RESPONSE_SCHEMA,
    });

    let script = parseDualHeadScript(result.text);
    if (!script) {
      logDualHeadInvalidScript(result.text, 'Invalid proactive dual-head script JSON, attempting regex rescue from raw text.');
      const rescued = rescueBeatsFromRawText(result.text);
      if (rescued && hasRequiredDualHeadCoverage(rescued.beats)) {
        script = rescued;
      } else {
        const repaired = await maybeRepairDualHeadScript({
          rawText: result.text,
          userInput: context,
          provider,
          auth: authState.auth,
          systemInstruction,
          model: dualHeadModel,
        });
        repairUsageIn += repaired.usageIn;
        repairUsageOut += repaired.usageOut;
        if (repaired.script) {
          script = repaired.script;
        }
      }
    }
    if (!script || !hasRequiredDualHeadCoverage(script.beats)) {
      logDualHeadInvalidScript(result.text, 'No valid proactive dual-head script returned by LLM.');
      return null;
    }

    let { beats, donation } = mergeDonationSignalFromBeats(script.beats);
    let fullText = beats
      .filter((beat) => beat.action === 'speak')
      .map((beat) => beat.text?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();

    const nudged = maybeInjectDonationNudge(fullText, Boolean(donation.show), assistantReplyCount);
    if (nudged.forcedQr) {
      donation = buildDonationPayload(true, 'periodic_nudge');
      const nudgeText = `Venmo @${donation.venmoHandle ?? 'TubsBot'}.`;
      beats = [...beats, {
        actor: 'main',
        action: 'speak',
        text: nudgeText,
        emotion: toTurnEmotion(defaultDualHeadSpeakEmotion('main')),
      }];
      fullText = `${fullText} ${nudgeText}`.trim();
    }

    fullText = clampOutput(fullText);
    if (!fullText) {
      return null;
    }

    pushHistory('model', fullText);
    assistantReplyCount += 1;
    const primaryEmotion = beats.find((beat) => beat.actor === 'main' && beat.emotion)?.emotion ?? null;
    const tokensIn = (Number(result.usage.promptTokenCount || 0) + repairUsageIn) || estimateTokens(context);
    const tokensOut = (Number(result.usage.candidatesTokenCount || 0) + repairUsageOut) || estimateTokens(fullText);
    console.log(`[LLM:dual-proactive] beats=${beats.length} donation=${donation.show ? donation.reason : 'none'}${summarizeDualHeadBeatsForLog(beats, { userInput: context })}`);

    return {
      beats,
      donation,
      model: result.model || dualHeadModel,
      latencyMs: Date.now() - startedAt,
      tokens: {
        in: tokensIn,
        out: tokensOut,
      },
      costUsd: estimateCostUsd(tokensIn, tokensOut),
      source: 'llm',
      fullText,
      emotion: primaryEmotion ? fromTurnEmotion(primaryEmotion) : null,
      contextMeta: contents.meta,
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[assistant] dual proactive generation failed: ${error.message}`);
    }
    return null;
  }
}

function toTurnEmotion(emotion: SpeechEmotionPayload): TurnEmotion {
  const next: TurnEmotion = {};
  if (emotion.expression) {
    next.expression = emotion.expression;
  }
  const emoji = emotion.emoji;
  if (emoji !== undefined) {
    next.emoji = emoji as Exclude<TurnEmotion['emoji'], undefined>;
  }
  if (emotion.impulse) {
    next.impulse = emotion.impulse;
  }
  return next;
}

function fromTurnEmotion(emotion: TurnEmotion): SpeechEmotionPayload {
  return {
    ...(emotion.expression !== undefined ? { expression: emotion.expression } : {}),
    ...(emotion.emoji !== undefined ? { emoji: emotion.emoji } : {}),
    ...(emotion.impulse !== undefined ? { impulse: emotion.impulse } : {}),
  };
}

function isDualHeadReply(reply: AssistantReply | DualHeadReply): reply is DualHeadReply {
  return 'beats' in reply && Array.isArray(reply.beats);
}
