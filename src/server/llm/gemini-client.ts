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
      parts?: Array<{ text?: string }>;
    };
  }>;
  usageMetadata?: LlmUsage;
  modelVersion?: string;
  error?: {
    message?: string;
  };
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
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
    if (text) {
      return text;
    }
  }
  return '';
}
