import type { LlmContent, LlmGenerateResult, LlmUsage } from './types.js';

const DEFAULT_GEMINI_BASE_URL = process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

interface GenerateGeminiArgs {
  apiKey: string;
  model: string;
  systemInstruction: string;
  contents: LlmContent[];
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

interface GeminiResponseJson {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
  usageMetadata?: LlmUsage;
  modelVersion?: string;
  error?: {
    message?: string;
  };
}

export interface StreamGeminiArgs extends GenerateGeminiArgs {
  onChunk: (delta: string) => void;
  abortSignal?: AbortSignal;
}

export interface StreamGeminiResult extends LlmGenerateResult {
  aborted: boolean;
}

export async function streamGeminiContent(args: StreamGeminiArgs): Promise<StreamGeminiResult> {
  if (!args.apiKey) {
    const error = new Error('Missing GEMINI_API_KEY');
    error.name = 'MissingApiKeyError';
    throw error;
  }

  const endpoint = `${DEFAULT_GEMINI_BASE_URL}/models/${encodeURIComponent(args.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(args.apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 12_000);

  if (args.abortSignal) {
    if (args.abortSignal.aborted) {
      clearTimeout(timeout);
      return { text: '', usage: {}, model: args.model, aborted: true };
    }
    args.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let fullText = '';
  let usage: LlmUsage = {};
  let aborted = false;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: args.contents,
        systemInstruction: { parts: [{ text: args.systemInstruction }] },
        generationConfig: {
          maxOutputTokens: args.maxOutputTokens,
          temperature: args.temperature ?? 1,
          ...(args.responseMimeType ? { responseMimeType: args.responseMimeType } : {}),
          ...(args.responseSchema ? { responseSchema: args.responseSchema } : {}),
          thinkingConfig: { thinkingLevel: 'MINIMAL' },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const raw = await response.text();
      const json = parseGeminiJson(raw);
      const detail = json?.error?.message || raw.slice(0, 300) || `HTTP ${response.status}`;
      throw new Error(`Gemini API error: ${detail}`);
    }

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        let chunk: GeminiResponseJson;
        try {
          chunk = JSON.parse(jsonStr) as GeminiResponseJson;
        } catch {
          continue;
        }

        const delta = extractResponseText(chunk);
        if (delta) {
          fullText += delta;
          args.onChunk(delta);
        }

        if (chunk.usageMetadata) {
          usage = chunk.usageMetadata;
        }
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

  return { text: fullText, usage, model: args.model, aborted };
}

export async function generateGeminiContent(args: GenerateGeminiArgs): Promise<LlmGenerateResult> {
  if (!args.apiKey) {
    const error = new Error('Missing GEMINI_API_KEY');
    error.name = 'MissingApiKeyError';
    throw error;
  }
  if (!args.model) {
    const error = new Error('Missing model name');
    error.name = 'MissingModelError';
    throw error;
  }

  const endpoint = `${DEFAULT_GEMINI_BASE_URL}/models/${encodeURIComponent(args.model)}:generateContent?key=${encodeURIComponent(args.apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 12_000);

  let response: Response;
  let raw = '';
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: args.contents,
        systemInstruction: {
          parts: [{ text: args.systemInstruction }],
        },
        generationConfig: {
          maxOutputTokens: args.maxOutputTokens,
          temperature: args.temperature ?? 1,
          ...(args.responseMimeType ? { responseMimeType: args.responseMimeType } : {}),
          ...(args.responseSchema ? { responseSchema: args.responseSchema } : {}),
          thinkingConfig: {
            thinkingLevel: 'MINIMAL',
          },
        },
      }),
      signal: controller.signal,
    });
    raw = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutError = new Error('Gemini request timed out');
      timeoutError.name = 'GeminiTimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const json = parseGeminiJson(raw);
  if (!response.ok) {
    const detail = json?.error?.message || raw.slice(0, 300) || `HTTP ${response.status}`;
    throw new Error(`Gemini API error: ${detail}`);
  }
  if (!json) {
    throw new Error('Gemini API returned non-JSON response');
  }

  const text = extractResponseText(json);
  if (!text) {
    throw new Error('Gemini response did not contain text output');
  }

  return {
    text,
    usage: json.usageMetadata ?? {},
    model: json.modelVersion || args.model,
  };
}

function parseGeminiJson(raw: string): GeminiResponseJson | null {
  try {
    return JSON.parse(raw) as GeminiResponseJson;
  } catch {
    return null;
  }
}

function extractResponseText(responseJson: GeminiResponseJson): string {
  const candidates = Array.isArray(responseJson.candidates) ? responseJson.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    const text = parts
      .filter((part) => !part.thought)
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
    if (text) {
      return text;
    }
  }
  return '';
}
