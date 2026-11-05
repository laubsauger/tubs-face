// Two-head replies: one LLM call returns a beat script for Main and Small.

import { recordFieldNotes } from './field-notes.js';
import type { TurnEmotion } from '../../shared/contracts/turn-script.js';
import type { SpeechEmotionPayload } from '../../shared/contracts/ws.js';
import { runtimeConfig } from '../config/runtime.js';
import type { TurnTimer } from '../turn-timing.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { buildDualHeadSystemInstruction } from './prompt.js';
import { buildTurnDirection } from './variety.js';
import { defaultDualHeadSpeakEmotion } from './emotion.js';
import { estimateCostUsd, estimateTokens, normalizeInput, stripSpeakerLabels } from './text.js';
import { beatsForHistory, buildContents, buildProactiveContents, pushHistory, getVisualContext } from './context.js';
import { DUAL_HEAD_RESPONSE_SCHEMA, hasRequiredDualHeadCoverage, type ParsedDualHeadScript, parseDualHeadScript, rescueBeatsFromRawText, summarizeDualHeadBeatsForLog } from './dual-head.js';
import { logDualHeadInvalidScript, logRawModelOutput } from './llm-log.js';
import { type DualHeadReply, assistantUnavailable } from './reply-types.js';
import { directionFor } from './single-head.js';

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
    maxOutputTokens: dualHeadMaxOutputTokens(),
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

export async function generateDualHeadReply(userText: string, turnTimer?: TurnTimer): Promise<DualHeadReply> {
  const startedAt = Date.now();
  const normalized = userText.trim();
  const context = buildContents(normalized, directionFor('dual', turnTimer).text);
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
      maxOutputTokens: dualHeadMaxOutputTokens(),
      temperature: Math.max(0, Math.min(1.2, Number.parseFloat(String(process.env.DUAL_HEAD_TEMPERATURE || '0.25')) || 0.25)),
      timeoutMs: 18_000,
      responseMimeType: 'application/json',
      responseSchema: DUAL_HEAD_RESPONSE_SCHEMA,
    });
    endLlmSpan?.();
    logRawModelOutput('dual', result.text);
    recordFieldNotes(result.text);

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

    const beats = script.beats;
    let fullText = beats
      .filter((beat) => beat.action === 'speak')
      .map((beat) => beat.text?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();

    // Each beat is already clamped. Clamping the whole turn again stored every
    // two-head turn in the history as two sentences, and the model copied that.
    fullText = normalizeInput(stripSpeakerLabels(fullText));
    if (!fullText) {
      throw new Error('Dual-head script produced empty output');
    }

    const tokensIn = (Number(result.usage.promptTokenCount || 0) + repairUsageIn) || estimateTokens(normalized);
    const tokensOut = (Number(result.usage.candidatesTokenCount || 0) + repairUsageOut) || estimateTokens(fullText);
    const primaryEmotion = beats.find((beat) => beat.actor === 'main' && beat.emotion)?.emotion ?? null;
    pushHistory('user', normalized);
    // Labeled, so a visitor reacting to Mini's line is understood as such.
    pushHistory('model', beatsForHistory(beats));
    console.log(`[LLM:dual] turn_script beats=${beats.length}${summarizeDualHeadBeatsForLog(beats, { userInput: normalized })}`);

    return {
      beats,
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

export async function generateDualHeadProactiveReply(context: string): Promise<DualHeadReply | null> {
  const startedAt = Date.now();
  const provider = resolveLlmProvider();
  const authState = provider.getAuthState();
  if (!authState.ready) {
    return null;
  }

  const contents = buildProactiveContents(context, buildTurnDirection('proactive'));
  const systemInstruction = `${buildDualHeadSystemInstruction(getVisualContext())}\n\nPROACTIVE: Nobody asked you anything; you are speaking up on your own. ${context}\nOne punchy sentence from main. Small head should chime in with something creative, a roast, a jab, or an unhinged observation.`;

  try {
    const dualHeadModel = String(process.env.DUAL_HEAD_LLM_MODEL || '').trim() || runtimeConfig.llmModel;
    let repairUsageIn = 0;
    let repairUsageOut = 0;
    const result = await provider.generateContent({
      auth: authState.auth,
      model: dualHeadModel,
      systemInstruction,
      contents: contents.contents,
      maxOutputTokens: dualHeadMaxOutputTokens(),
      temperature: Math.max(0, Math.min(1.2, Number.parseFloat(String(process.env.DUAL_HEAD_TEMPERATURE || '0.25')) || 0.25)),
      timeoutMs: 18_000,
      responseMimeType: 'application/json',
      responseSchema: DUAL_HEAD_RESPONSE_SCHEMA,
    });
    logRawModelOutput('dual-proactive', result.text);
    recordFieldNotes(result.text);

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

    const beats = script.beats;
    let fullText = beats
      .filter((beat) => beat.action === 'speak')
      .map((beat) => beat.text?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();

    // Each beat is already clamped. Clamping the whole turn again stored every
    // two-head turn in the history as two sentences, and the model copied that.
    fullText = normalizeInput(stripSpeakerLabels(fullText));
    if (!fullText) {
      return null;
    }

    // Labeled, so a visitor reacting to Mini's line is understood as such.
    pushHistory('model', beatsForHistory(beats));
    const primaryEmotion = beats.find((beat) => beat.actor === 'main' && beat.emotion)?.emotion ?? null;
    const tokensIn = (Number(result.usage.promptTokenCount || 0) + repairUsageIn) || estimateTokens(context);
    const tokensOut = (Number(result.usage.candidatesTokenCount || 0) + repairUsageOut) || estimateTokens(fullText);
    console.log(`[LLM:dual-proactive] beats=${beats.length}${summarizeDualHeadBeatsForLog(beats, { userInput: context })}`);

    return {
      beats,
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

/**
 * The JSON beats of a two-head turn with a bit in it run past 256 tokens; at
 * the old cap the reply was cut off mid-JSON and fell back to the rescue parser.
 */
const DUAL_HEAD_MIN_OUTPUT_TOKENS = 640;

function dualHeadMaxOutputTokens(): number {
  return Math.max(DUAL_HEAD_MIN_OUTPUT_TOKENS, Number(runtimeConfig.llmMaxOutputTokens || 0));
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
