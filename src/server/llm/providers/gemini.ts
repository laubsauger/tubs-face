import { generateGeminiContent, streamGeminiContent } from '../gemini-client.js';
import type { LlmAuthState, LlmGenerateArgs, LlmGenerateResult, LlmProvider, LlmStreamArgs, LlmStreamResult } from '../types.js';

function getAuthState(): LlmAuthState {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ready: false,
      warningMessage: '[llm] GEMINI_API_KEY missing. Assistant generation is unavailable.',
      auth: null,
    };
  }
  return {
    ready: true,
    warningMessage: null,
    auth: { apiKey },
  };
}

async function generateContent(args: LlmGenerateArgs): Promise<LlmGenerateResult> {
  const apiKey = args.auth?.apiKey ?? process.env.GEMINI_API_KEY?.trim() ?? '';
  const request = {
    apiKey,
    model: args.model,
    systemInstruction: args.systemInstruction,
    contents: args.contents,
    maxOutputTokens: args.maxOutputTokens,
  };
  if (args.temperature !== undefined) {
    Object.assign(request, { temperature: args.temperature });
  }
  if (args.timeoutMs !== undefined) {
    Object.assign(request, { timeoutMs: args.timeoutMs });
  }
  if (args.responseMimeType !== undefined) {
    Object.assign(request, { responseMimeType: args.responseMimeType });
  }
  if (args.responseSchema !== undefined) {
    Object.assign(request, { responseSchema: args.responseSchema });
  }
  return generateGeminiContent(request);
}

async function streamContent(args: LlmStreamArgs): Promise<LlmStreamResult> {
  const apiKey = args.auth?.apiKey ?? process.env.GEMINI_API_KEY?.trim() ?? '';
  return streamGeminiContent({
    apiKey,
    model: args.model,
    systemInstruction: args.systemInstruction,
    contents: args.contents,
    maxOutputTokens: args.maxOutputTokens,
    temperature: args.temperature,
    timeoutMs: args.timeoutMs,
    responseMimeType: args.responseMimeType,
    responseSchema: args.responseSchema,
    onChunk: args.onChunk,
    abortSignal: args.abortSignal,
  });
}

export const geminiProvider: LlmProvider = {
  id: 'gemini',
  getAuthState,
  generateContent,
  streamContent,
};
