// Catches replies that slip out of character (assistant phrasing, wrong
// language) and asks the model for an in-character rewrite.

import { runtimeConfig } from '../config/runtime.js';
import type { TurnTimer } from '../turn-timing.js';
import type { resolveLlmProvider } from '../llm/provider.js';
import { buildAssistantSystemInstruction } from './prompt.js';
import { splitTrailingEmotionEmoji } from './emotion.js';
import { clampOutput, normalizeInput, stripFormatting } from './text.js';
import { getVisualContext } from './context.js';

const PERSONA_DRIFT_PHRASE_RE = /\b(certainly|however|it's important to remember|do you have any other questions|any other questions or topics you'd like to discuss|let me know if you|in conclusion)\b/i;

const PERSONA_DRIFT_FORMAL_RE = /\b(representation|subjective|therefore|additionally|furthermore|moreover)\b/i;

const PERSONA_MARKER_RE = /\b(tubs|robot|plastic tubs?)\b/i;

const CONTRACTION_RE = /\b(i'm|you're|we're|that's|it's|don't|can't|won't|let's)\b/i;

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

export async function maybeRepairPersonaDrift(args: {
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
    '- Absolute maximum 1-2 punchy sentences. One short sentence is preferred. BE EXTREMELY BRIEF.',
    '- Never use these phrases: "certainly", "however", "it\'s important to remember", "do you have any other questions", "any other questions or topics".',
    '- End with a hook or a judgment when it fits. A question is optional.',
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
    maxOutputTokens: Math.min(120, Number(args.maxOutputTokens || runtimeConfig.llmMaxOutputTokens || 256)),
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

export function isPersonaDrift(text: string): string | null {
  const normalized = normalizeInput(text).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (PERSONA_DRIFT_PHRASE_RE.test(normalized)) {
    const match = normalized.match(PERSONA_DRIFT_PHRASE_RE)?.[1] || 'forbidden phrase';
    return `forbidden phrase: "${match}"`;
  }
  const formalMatches = Array.from(normalized.matchAll(new RegExp(PERSONA_DRIFT_FORMAL_RE.source, 'gi')));
  if (formalMatches.length >= 2 && !CONTRACTION_RE.test(normalized)) {
    const match = formalMatches[0]?.[1] || formalMatches[0]?.[0] || 'formal wording';
    return `multiple formal cues: "${match}"`;
  }
  const sentenceCount = (normalized.match(/[^.!?]+[.!?]?/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .length;
  if (normalized.length > 140 && sentenceCount >= 3 && !PERSONA_MARKER_RE.test(normalized) && !CONTRACTION_RE.test(normalized)) {
    return 'overlong and generic';
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
