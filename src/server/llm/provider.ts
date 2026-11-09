import { geminiProvider } from './providers/gemini.js';
import { realtimeProvider } from './providers/realtime.js';
import type { LlmProvider, LlmStreamArgs } from './types.js';
import { trackLlmCall } from './last-call.js';

/**
 * LLM_PROVIDER=gemini (default) streams from Gemini; LLM_PROVIDER=ollama (or
 * the older "realtime") goes through the speech service to a local or remote
 * Ollama / OpenAI-compatible model, also streamed.
 */
export function resolveLlmProvider(): LlmProvider {
  const providerType = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  return tracked(providerType === 'ollama' || providerType === 'realtime' ? realtimeProvider : geminiProvider);
}

/** The same provider, with each call's outcome kept for GET /studio (the brain part). */
function tracked(provider: LlmProvider): LlmProvider {
  const stream = provider.streamContent;
  return {
    ...provider,
    getAuthState: () => provider.getAuthState(),
    generateContent: (args) => trackLlmCall(() => provider.generateContent(args)),
    ...(stream ? { streamContent: (args: LlmStreamArgs) => trackLlmCall(() => stream.call(provider, args)) } : {}),
  };
}
