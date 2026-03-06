import type { LlmAuthState, LlmGenerateArgs, LlmGenerateResult, LlmProvider } from '../types.js';

const DEFAULT_REALTIME_PORT = Number.parseInt(process.env.REALTIME_PROCESSING_PORT || '3002', 10) || 3002;
const DEFAULT_REALTIME_HOST = process.env.REALTIME_PROCESSING_HOST || '127.0.0.1';
const DEFAULT_REALTIME_LLM_MODEL = String(process.env.REALTIME_LLM_MODEL || '').trim();

function getRealtimeBaseUrl(): string {
  return `http://${DEFAULT_REALTIME_HOST}:${DEFAULT_REALTIME_PORT}`;
}

function getRealtimeLlmProvider(): string {
  return String(process.env.REALTIME_LLM_PROVIDER || 'ollama').trim().toLowerCase();
}

function getAuthState(): LlmAuthState {
  if (getRealtimeLlmProvider() !== 'openai') {
    return {
      ready: true,
      warningMessage: null,
      auth: null,
    };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ready: false,
      warningMessage: '[llm] OPENAI_API_KEY missing for realtime provider. Falling back to demo replies.',
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
  const endpoint = `${getRealtimeBaseUrl()}/llm/generate`;
  const payload = buildPayload(args);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  const json = parseRealtimeJson(raw);
  if (!response.ok) {
    const detail = json?.error || json?.message || raw.slice(0, 300) || `HTTP ${response.status}`;
    throw new Error(`Realtime LLM API error: ${detail}`);
  }
  if (!json) {
    throw new Error('Realtime LLM API returned non-JSON response');
  }

  return {
    text: String(json.text || '').trim(),
    usage: (json.usage as Record<string, unknown> | undefined) ?? {},
    model: String(json.model || payload.model),
  };
}

function buildPayload(args: LlmGenerateArgs): Record<string, unknown> {
  const requestedModel = String(args.model || '').trim();
  const systemInstruction = String(args.systemInstruction || '').trim();
  let model = requestedModel;
  if (!model || /^gemini[-._]/i.test(model)) {
    model = DEFAULT_REALTIME_LLM_MODEL;
  }
  if (!model) {
    throw new Error('REALTIME_LLM_MODEL is not configured');
  }
  if (!systemInstruction) {
    throw new Error('systemInstruction is empty');
  }

  return {
    model,
    systemInstruction,
    contents: args.contents,
    maxOutputTokens: args.maxOutputTokens,
    temperature: args.temperature,
    timeoutMs: args.timeoutMs,
  };
}

function parseRealtimeJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const realtimeProvider: LlmProvider = {
  id: 'realtime',
  getAuthState,
  generateContent,
};
