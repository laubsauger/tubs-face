import type { LlmAuthState, LlmGenerateArgs, LlmGenerateResult, LlmProvider, LlmStreamArgs, LlmStreamResult, LlmUsage } from '../types.js';

/**
 * A local or remote Ollama (or an OpenAI-compatible server) behind the Python
 * speech service. REALTIME_LLM_PROVIDER picks ollama/openai there,
 * REALTIME_LLM_MODEL the model, OLLAMA_HOST where Ollama runs.
 */

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
      warningMessage: '[llm] OPENAI_API_KEY missing for realtime provider. Assistant generation is unavailable.',
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
    responseMimeType: args.responseMimeType,
    responseSchema: args.responseSchema,
  };
}

function parseRealtimeJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Streams the reply from the speech service's /llm/stream (NDJSON lines:
 * {"delta"} ... then {"done", usage, model} or {"error"}), so a local model
 * gets the same sentence-by-sentence speech as Gemini.
 */
async function streamContent(args: LlmStreamArgs): Promise<LlmStreamResult> {
  const payload = buildPayload(args);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 20_000);
  if (args.abortSignal) {
    if (args.abortSignal.aborted) {
      clearTimeout(timeout);
      return { text: '', usage: {}, model: String(payload.model), aborted: true };
    }
    args.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let text = '';
  let usage: LlmUsage = {};
  let model = String(payload.model);
  let aborted = false;
  try {
    const response = await fetch(`${getRealtimeBaseUrl()}/llm/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const raw = await response.text().catch(() => '');
      throw new Error(`Realtime LLM API error: ${raw.slice(0, 300) || `HTTP ${response.status}`}`);
    }
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(bytes, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (!line) continue;
        const event = parseRealtimeJson(line);
        if (!event) continue;
        if (typeof event.error === 'string') {
          throw new Error(`Realtime LLM API error: ${event.error}`);
        }
        if (typeof event.delta === 'string' && event.delta) {
          text += event.delta;
          args.onChunk(event.delta);
        }
        if (event.usage && typeof event.usage === 'object') usage = event.usage as LlmUsage;
        if (typeof event.model === 'string' && event.model) model = event.model;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      aborted = true;
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
  return { text: text.trim(), usage, model, aborted };
}

export const realtimeProvider: LlmProvider = {
  id: 'realtime',
  getAuthState,
  generateContent,
  streamContent,
};
