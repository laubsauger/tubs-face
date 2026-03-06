import { generateGeminiContent } from '../gemini-client.js';
import type { LlmAuthState, LlmGenerateArgs, LlmGenerateResult, LlmProvider } from '../types.js';

function getAuthState(): LlmAuthState {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ready: false,
      warningMessage: '[llm] GEMINI_API_KEY missing. Falling back to demo replies.',
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
  return generateGeminiContent(request);
}

export const geminiProvider: LlmProvider = {
  id: 'gemini',
  getAuthState,
  generateContent,
};
