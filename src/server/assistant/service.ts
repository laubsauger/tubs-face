import { randomBytes } from 'node:crypto';
import type { TurnContextMeta, TurnDonation } from '../../shared/contracts/turn-script.js';
import type { SpeechEmotionPayload, WsServerMessage, WsSpeakServerMessage, WsStatsServerMessage, WsTurnStartServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig, sessionStats } from '../config/runtime.js';
import { generateDemoResponse } from './demo.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { pickGreetingResponse } from '../persona/index.js';
import { buildAssistantSystemInstruction } from './prompt.js';
import { buildDonationPayload, extractDonationSignal, maybeInjectDonationNudge } from './donation.js';
import { splitTrailingEmotionEmoji } from './emotion.js';
import { clampOutput, estimateCostUsd, estimateTokens, stripFormatting } from './text.js';
import { buildContents, pushHistory } from './context.js';

export interface AssistantReply {
  text: string;
  model: string;
  latencyMs: number;
  source: 'demo' | 'greeting' | 'llm';
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
}

export function createTurnId(): string {
  return randomBytes(6).toString('hex');
}

let assistantReplyCount = 0;

export async function generateAssistantReply(userText: string): Promise<AssistantReply> {
  const normalized = userText.trim();
  const startedAt = Date.now();
  const context = buildContents(normalized);
  if (!normalized) {
    const text = 'I did not catch that. Try again.';
    return {
      text,
      model: runtimeConfig.llmModel,
      latencyMs: Date.now() - startedAt,
      source: 'demo',
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
    return buildDemoReply(normalized, startedAt, context.meta);
  }

  try {
    const result = await provider.generateContent({
      auth: authState.auth,
      model: runtimeConfig.llmModel,
      systemInstruction: buildAssistantSystemInstruction(),
      contents: context.contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 1,
      timeoutMs: 12_000,
    });
    const cleaned = stripFormatting(result.text);
    const parsed = splitTrailingEmotionEmoji(cleaned);
    const donationSignal = extractDonationSignal(parsed.text);
    const nudged = maybeInjectDonationNudge(
      donationSignal.text,
      Boolean(donationSignal.donation.show),
      assistantReplyCount,
    );
    const text = clampOutput(nudged.text);
    if (!text) {
      return buildDemoReply(normalized, startedAt, context.meta);
    }

    const tokensIn = Number(result.usage.promptTokenCount || 0) || estimateTokens(normalized);
    const tokensOut = Number(result.usage.candidatesTokenCount || 0) || estimateTokens(text);
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
    return buildDemoReply(normalized, startedAt, context.meta);
  }
}

function buildDemoReply(userText: string, startedAt: number, contextMeta: TurnContextMeta = { mode: 'text' }): AssistantReply {
  const parsed = splitTrailingEmotionEmoji(generateDemoResponse(userText));
  const text = parsed.text || 'Okay.';
  assistantReplyCount += 1;
  pushHistory('user', userText);
  pushHistory('model', text);
  return {
    text,
    model: runtimeConfig.llmModel,
    latencyMs: Date.now() - startedAt,
    source: 'demo',
    donation: buildDonationPayload(false),
    emotion: parsed.emotion,
    contextMeta,
    tokens: {
      in: estimateTokens(userText),
      out: estimateTokens(text),
    },
    costUsd: 0,
  };
}

export async function runAssistantTurn(userText: string, broadcast: (message: WsServerMessage) => void): Promise<AssistantTurnResult> {
  const turnId = createTurnId();
  broadcast({
    type: 'turn_start',
    turnId,
  } satisfies WsTurnStartServerMessage);

  const reply = await generateAssistantReply(userText);

  broadcast({
    type: 'turn_context',
    turnId,
    meta: reply.contextMeta,
  });

  broadcast({
    type: 'speak',
    text: reply.text,
    ts: Date.now(),
    donation: reply.donation,
    emotion: reply.emotion,
    turnId,
  } satisfies WsSpeakServerMessage);

  sessionStats.messagesOut += 1;
  sessionStats.lastActivity = Date.now();
  sessionStats.tokensIn += reply.tokens.in;
  sessionStats.tokensOut += reply.tokens.out;
  sessionStats.costUsd += reply.costUsd;
  sessionStats.model = reply.model;

  broadcast({
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
