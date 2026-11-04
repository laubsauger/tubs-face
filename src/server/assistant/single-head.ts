// Single-head replies generated in one call (no streaming).

import { recordFieldNotes } from './field-notes.js';
import { runtimeConfig } from '../config/runtime.js';
import type { TurnTimer } from '../turn-timing.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { pickGreetingResponse } from '../persona/index.js';
import { buildAssistantSystemInstruction } from './prompt.js';
import { buildTurnDirection, directTurn } from './variety.js';
import { splitTrailingEmotionEmoji } from './emotion.js';
import { clampOutput, estimateCostUsd, estimateTokens, stripFormatting, stripSpeakerLabels, unwrapJsonSpeechText } from './text.js';
import { buildContents, buildProactiveContents, pushHistory, getVisualContext } from './context.js';
import { logRawModelOutput } from './llm-log.js';
import { maybeRepairPersonaDrift } from './persona-drift.js';
import { type AssistantReply, assistantUnavailable } from './reply-types.js';

/** This turn's variety direction, also shown in the turn timing log so odd replies can be explained. */
export function directionFor(mode: 'single' | 'dual', turnTimer?: TurnTimer): { text: string; maxSentences: number } {
  const direction = directTurn(mode);
  turnTimer?.setMeta('Direction', direction.text.split('\n').slice(1).map((line) => line.replace(/^- /, '')).join(' | '));
  return direction;
}

export async function generateAssistantReply(userText: string, turnTimer?: TurnTimer): Promise<AssistantReply> {
  const normalized = userText.trim();
  const startedAt = Date.now();
  const direction = directionFor('single', turnTimer);
  const context = buildContents(normalized, direction.text);
  if (!normalized) {
    const text = 'I did not catch that. Try again.';
    return {
      text,
      model: runtimeConfig.llmModel,
      latencyMs: Date.now() - startedAt,
      source: 'llm',
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
    pushHistory('user', normalized);
    pushHistory('model', text);
    return {
      text,
      model: 'fast-greeting',
      latencyMs: Date.now() - startedAt,
      source: 'greeting',
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
    logRawModelOutput('reply', result.text);
    recordFieldNotes(result.text);
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
    const text = clampOutput(stripSpeakerLabels(unwrapJsonSpeechText(parsed.text)), direction.maxSentences);
    if (!text) {
      throw assistantUnavailable('[assistant] LLM returned empty reply text');
    }

    const tokensIn = (Number(result.usage.promptTokenCount || 0) + repaired.usageIn) || estimateTokens(normalized);
    const tokensOut = (Number(result.usage.candidatesTokenCount || 0) + repaired.usageOut) || estimateTokens(text);
    pushHistory('user', normalized);
    pushHistory('model', text);

    return {
      text,
      model: result.model || runtimeConfig.llmModel,
      latencyMs: Date.now() - startedAt,
      source: 'llm',
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

export async function generateProactiveReply(context: string): Promise<AssistantReply | null> {
  const startedAt = Date.now();
  const provider = resolveLlmProvider();
  const authState = provider.getAuthState();
  if (!authState.ready) {
    return null;
  }

  const contents = buildProactiveContents(context, buildTurnDirection('proactive'));
  const proactiveInstruction = `${buildAssistantSystemInstruction(getVisualContext())}\n\nPROACTIVE: Nobody asked you anything; you are speaking up on your own. ${context}\nOne punchy sentence. Say what is on your mind. You are not begging for their attention.`;

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
    logRawModelOutput('proactive', result.text);
    recordFieldNotes(result.text);

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
    const text = clampOutput(stripSpeakerLabels(unwrapJsonSpeechText(parsed.text)));
    if (!text) {
      return null;
    }

    pushHistory('model', text);
    const tokensIn = (Number(result.usage.promptTokenCount || 0) + repaired.usageIn) || estimateTokens(context);
    const tokensOut = (Number(result.usage.candidatesTokenCount || 0) + repaired.usageOut) || estimateTokens(text);
    return {
      text,
      model: result.model || runtimeConfig.llmModel,
      latencyMs: Date.now() - startedAt,
      source: 'llm',
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
