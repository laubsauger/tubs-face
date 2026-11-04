import { geminiProvider } from './providers/gemini.js';
import { realtimeProvider } from './providers/realtime.js';
import type { LlmProvider } from './types.js';

/**
 * LLM_PROVIDER=gemini (default) streams from Gemini; LLM_PROVIDER=ollama (or
 * the older "realtime") goes through the speech service to a local or remote
 * Ollama / OpenAI-compatible model, also streamed.
 */
export function resolveLlmProvider(): LlmProvider {
  const providerType = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  return providerType === 'ollama' || providerType === 'realtime' ? realtimeProvider : geminiProvider;
}
