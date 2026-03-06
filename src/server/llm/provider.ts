import { runtimeConfig } from '../config/runtime.js';
import { geminiProvider } from './providers/gemini.js';
import { realtimeProvider } from './providers/realtime.js';
import type { LlmProvider } from './types.js';

export function resolveLlmProvider(): LlmProvider {
  const providerType = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (providerType === 'gemini') {
    return geminiProvider;
  }
  if (providerType === 'realtime') {
    return realtimeProvider;
  }
  return runtimeConfig.processingMode === 'realtime' ? realtimeProvider : geminiProvider;
}
