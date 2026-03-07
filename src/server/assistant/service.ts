import { randomBytes } from 'node:crypto';
import type { TurnBeat, TurnContextMeta, TurnDonation, TurnEmotion } from '../../shared/contracts/turn-script.js';
import type { SpeechEmotionPayload, WsServerMessage, WsSpeakServerMessage, WsStatsServerMessage, WsTurnStartServerMessage } from '../../shared/contracts/ws.js';
import { runtimeConfig, sessionStats } from '../config/runtime.js';
import { generateDemoResponse } from './demo.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { pickGreetingResponse } from '../persona/index.js';
import { buildAssistantSystemInstruction, buildDualHeadSystemInstruction } from './prompt.js';
import { buildDonationPayload, extractDonationSignal, maybeInjectDonationNudge } from './donation.js';
import { defaultDualHeadSpeakEmotion, splitTrailingEmotionEmoji } from './emotion.js';
import { clampOutput, estimateCostUsd, estimateTokens, normalizeInput, stripFormatting } from './text.js';
import { buildContents, buildProactiveContents, pushHistory, getVisualContext } from './context.js';
import {
  DUAL_HEAD_RESPONSE_SCHEMA,
  hasRequiredDualHeadCoverage,
  mergeDonationSignalFromBeats,
  parseDualHeadScript,
  rescueBeatsFromRawText,
  shouldUseDualHeadDirectedMode,
  summarizeDualHeadBeatsForLog,
} from './dual-head.js';

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
  source: 'demo' | 'greeting' | 'llm';
  fullText: string;
  emotion: SpeechEmotionPayload | null;
  contextMeta: TurnContextMeta;
}

export function createTurnId(): string {
  return randomBytes(6).toString('hex');
}

let assistantReplyCount = 0;
const PERSONA_DRIFT_PHRASE_RE = /\b(certainly|however|it's important to remember|do you have any other questions|any other questions or topics you'd like to discuss|let me know if you|in conclusion)\b/i;
const PERSONA_DRIFT_FORMAL_RE = /\b(representation|subjective|therefore|additionally|furthermore|moreover)\b/i;
const PERSONA_MARKER_RE = /\b(tubs|rapha|wheel|wheels|venmo|thailand|robot|plastic tubs?)\b/i;
const CONTRACTION_RE = /\b(i'm|you're|we're|that's|it's|don't|can't|won't|let's)\b/i;
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

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
      systemInstruction: buildAssistantSystemInstruction(getVisualContext()),
      contents: context.contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: 1,
      timeoutMs: 12_000,
    });
    let cleaned = stripFormatting(result.text);
    const repaired = await maybeRepairPersonaDrift({
      draftText: cleaned,
      userInput: normalized,
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
    const nudged = maybeInjectDonationNudge(
      donationSignal.text,
      Boolean(donationSignal.donation.show),
      assistantReplyCount,
    );
    const text = clampOutput(nudged.text);
    if (!text) {
      return buildDemoReply(normalized, startedAt, context.meta);
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
    return buildDemoReply(normalized, startedAt, context.meta);
  }
}

async function maybeRepairPersonaDrift(args: {
  draftText: string;
  userInput: string;
  provider: ReturnType<typeof resolveLlmProvider>;
  auth: Record<string, string> | null;
  maxOutputTokens: number;
  phase: 'reply' | 'dual';
}): Promise<{ text: string; usageIn: number; usageOut: number; repaired: boolean }> {
  const normalizedDraft = normalizeInput(args.draftText);
  const driftDetected = Boolean(
    normalizedDraft
      && (
        isPersonaDrift(normalizedDraft)
        || isLanguageDrift(normalizedDraft, args.userInput)
      ),
  );
  if (!normalizedDraft || !driftDetected) {
    return {
      text: normalizedDraft,
      usageIn: 0,
      usageOut: 0,
      repaired: false,
    };
  }

  console.warn(`[LLM:${args.phase}] Persona drift detected; requesting strict rewrite.`);
  const strictSystemInstruction = [
    buildAssistantSystemInstruction(getVisualContext()),
    'STRICT STYLE OVERRIDE:',
    '- Rewrite in Tubs voice: playful, slightly unhinged, never corporate.',
    '- 1-2 sentences max, concise and punchy.',
    '- End with a hook or question.',
    '- Never use these phrases: "certainly", "however", "it\'s important to remember", "do you have any other questions".',
    '- Return only the rewritten reply text.',
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

function isPersonaDrift(text: string): boolean {
  const normalized = normalizeInput(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (PERSONA_DRIFT_PHRASE_RE.test(normalized)) {
    return true;
  }
  if (PERSONA_DRIFT_FORMAL_RE.test(normalized) && !CONTRACTION_RE.test(normalized)) {
    return true;
  }
  if (normalized.length > 110 && !normalized.includes('?')) {
    return true;
  }
  if (normalized.length > 90 && !PERSONA_MARKER_RE.test(normalized) && !CONTRACTION_RE.test(normalized)) {
    return true;
  }
  return false;
}

function isLanguageDrift(text: string, userInput: string): boolean {
  if (!isMostlyAsciiEnglish(userInput)) {
    return false;
  }
  return CJK_RE.test(String(text || ''));
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

  if (shouldUseDualHeadDirectedMode()) {
    const dualHead = await generateDualHeadReply(userText);

    broadcast({
      type: 'turn_context',
      turnId,
      meta: dualHead.contextMeta,
    });

    broadcast({
      type: 'turn_script',
      turnId,
      beats: dualHead.beats,
      ...(dualHead.donation ? { donation: dualHead.donation } : {}),
      ts: Date.now(),
    });

    sessionStats.messagesOut += 1;
    sessionStats.lastActivity = Date.now();
    sessionStats.tokensIn += dualHead.tokens.in;
    sessionStats.tokensOut += dualHead.tokens.out;
    sessionStats.costUsd += dualHead.costUsd;
    sessionStats.model = dualHead.model;

    broadcast({
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

export async function runProactiveTurn(context: string, broadcast: (message: WsServerMessage) => void): Promise<AssistantTurnResult | null> {
  const turnId = createTurnId();
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

  broadcast({
    type: 'turn_context',
    turnId,
    meta: reply.contextMeta,
  });

  const proactiveText = isDualHeadReply(reply) ? reply.fullText : reply.text;

  if (isDualHeadReply(reply)) {
    broadcast({
      type: 'turn_script',
      turnId,
      beats: reply.beats,
      ...(reply.donation ? { donation: reply.donation } : {}),
      ts: Date.now(),
    });
  } else {
    broadcast({
      type: 'speak',
      text: proactiveText,
      ts: Date.now(),
      donation: reply.donation,
      emotion: reply.emotion,
      turnId,
    } satisfies WsSpeakServerMessage);
  }

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

async function generateDualHeadReply(userText: string): Promise<DualHeadReply> {
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
      source: 'demo',
      fullText: text,
      emotion: defaultDualHeadSpeakEmotion('main'),
      contextMeta: context.meta,
    };
  }

  if (!authState.ready) {
    if (authState.warningMessage) {
      console.warn(authState.warningMessage);
    }
    const demo = buildDemoReply(normalized, startedAt, context.meta);
    return {
      beats: [
        {
          actor: 'main',
          action: 'speak',
          text: demo.text,
          emotion: toTurnEmotion(demo.emotion ?? defaultDualHeadSpeakEmotion('main')),
        },
        {
          actor: 'small',
          action: 'speak',
          text: buildSecondaryFallback(demo.text),
          emotion: toTurnEmotion(defaultDualHeadSpeakEmotion('small')),
          delayMs: 180,
        },
      ],
      donation: demo.donation,
      model: `${demo.model}-dual-fallback`,
      latencyMs: Date.now() - startedAt,
      tokens: {
        in: demo.tokens.in,
        out: demo.tokens.out + estimateTokens(buildSecondaryFallback(demo.text)),
      },
      costUsd: 0,
      source: 'demo',
      fullText: demo.text,
      emotion: demo.emotion,
      contextMeta: demo.contextMeta,
    };
  }

  try {
    const result = await provider.generateContent({
      auth: authState.auth,
      model: String(process.env.DUAL_HEAD_LLM_MODEL || '').trim() || runtimeConfig.llmModel,
      systemInstruction: buildDualHeadSystemInstruction(getVisualContext()),
      contents: context.contents,
      maxOutputTokens: runtimeConfig.llmMaxOutputTokens,
      temperature: Math.max(0, Math.min(1.2, Number.parseFloat(String(process.env.DUAL_HEAD_TEMPERATURE || '0.25')) || 0.25)),
      timeoutMs: 18_000,
      responseMimeType: 'application/json',
      responseSchema: DUAL_HEAD_RESPONSE_SCHEMA,
    });

    let script = parseDualHeadScript(result.text);
    if (!script) {
      console.warn('[LLM:dual] Invalid script JSON, attempting regex rescue from raw text.');
      const rescued = rescueBeatsFromRawText(result.text);
      if (rescued && hasRequiredDualHeadCoverage(rescued.beats)) {
        script = rescued;
      }
    }
    if (!script || !hasRequiredDualHeadCoverage(script.beats)) {
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

    const tokensIn = Number(result.usage.promptTokenCount || 0) || estimateTokens(normalized);
    const tokensOut = Number(result.usage.candidatesTokenCount || 0) || estimateTokens(fullText);
    const primaryEmotion = beats.find((beat) => beat.actor === 'main' && beat.emotion)?.emotion ?? null;
    assistantReplyCount += 1;
    pushHistory('user', normalized);
    pushHistory('model', fullText);
    console.log(`[LLM:dual] turn_script beats=${beats.length} donation=${donation.show ? donation.reason : 'none'}${summarizeDualHeadBeatsForLog(beats, { userInput: normalized })}`);

    return {
      beats,
      donation,
      model: result.model || runtimeConfig.llmModel,
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
    const demo = buildDemoReply(normalized, startedAt, context.meta);
    return {
      beats: [
        {
          actor: 'main',
          action: 'speak',
          text: demo.text,
          emotion: toTurnEmotion(demo.emotion ?? defaultDualHeadSpeakEmotion('main')),
        },
        {
          actor: 'small',
          action: 'speak',
          text: buildSecondaryFallback(demo.text),
          emotion: toTurnEmotion(defaultDualHeadSpeakEmotion('small')),
          delayMs: 180,
        },
      ],
      donation: demo.donation,
      model: `${demo.model}-dual-fallback`,
      latencyMs: Date.now() - startedAt,
      tokens: {
        in: demo.tokens.in,
        out: demo.tokens.out + estimateTokens(buildSecondaryFallback(demo.text)),
      },
      costUsd: 0,
      source: 'demo',
      fullText: demo.text,
      emotion: demo.emotion,
      contextMeta: demo.contextMeta,
    };
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
    const result = await provider.generateContent({
      auth: authState.auth,
      model: String(process.env.DUAL_HEAD_LLM_MODEL || '').trim() || runtimeConfig.llmModel,
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
      const rescued = rescueBeatsFromRawText(result.text);
      if (rescued && hasRequiredDualHeadCoverage(rescued.beats)) {
        script = rescued;
      }
    }
    if (!script || !hasRequiredDualHeadCoverage(script.beats)) {
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
    const tokensIn = Number(result.usage.promptTokenCount || 0) || estimateTokens(context);
    const tokensOut = Number(result.usage.candidatesTokenCount || 0) || estimateTokens(fullText);
    console.log(`[LLM:dual-proactive] beats=${beats.length} donation=${donation.show ? donation.reason : 'none'}${summarizeDualHeadBeatsForLog(beats, { userInput: context })}`);

    return {
      beats,
      donation,
      model: result.model || runtimeConfig.llmModel,
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

function buildSecondaryFallback(mainText: string): string {
  const normalized = mainText.trim();
  if (!normalized) {
    return 'tiny tubs is here.';
  }
  const firstSentence = normalized.split(/[.!?]\s/)[0]?.trim() || normalized;
  return firstSentence.length > 48
    ? `${firstSentence.slice(0, 45).trim()}...`
    : `${firstSentence}`;
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
