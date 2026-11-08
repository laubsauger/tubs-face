// Who looks at a picture (docs/vision.md): Gemini, or any OpenAI-compatible
// server (Ollama, llama-server, vLLM, LM Studio, mlx-vlm) with the picture as
// an image_url data URL. The prompt is the caller's (assistant/vision.ts).

import { generateGeminiContent } from '../llm/gemini-client.js';

export interface VisionAsk {
  /** data:image/jpeg;base64,... */
  dataUrl: string;
  system: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
}

export interface VisionAnswer {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface VisionProviderDeps {
  fetch: typeof fetch;
  gemini: typeof generateGeminiContent;
  geminiApiKey: () => string;
}

export const defaultVisionDeps: VisionProviderDeps = {
  fetch: (...args) => fetch(...args),
  gemini: (...args) => generateGeminiContent(...args),
  geminiApiKey: () => process.env.GEMINI_API_KEY || '',
};

export async function askGemini(ask: VisionAsk, deps: VisionProviderDeps = defaultVisionDeps): Promise<VisionAnswer> {
  const match = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(ask.dataUrl);
  if (!match) throw new Error('not an image data URL');
  const result = await deps.gemini({
    apiKey: deps.geminiApiKey(),
    model: ask.model,
    systemInstruction: ask.system,
    contents: [{ role: 'user', parts: [{ text: ask.prompt }, { inlineData: { mimeType: match[1]!, data: match[2]! } }] }],
    maxOutputTokens: ask.maxTokens,
    timeoutMs: ask.timeoutMs,
  });
  return {
    text: (result.text ?? '').trim(),
    tokensIn: Number(result.usage?.promptTokenCount ?? 0),
    tokensOut: Number(result.usage?.candidatesTokenCount ?? 0),
  };
}

/** POST {base}/chat/completions with the picture as an image_url content part. */
export async function askOpenAiCompatible(
  ask: VisionAsk & { base: string; apiKey?: string },
  deps: VisionProviderDeps = defaultVisionDeps,
): Promise<VisionAnswer> {
  if (!ask.model) throw new Error('VISION_MODEL is required for an OpenAI-compatible provider');
  const response = await deps.fetch(`${ask.base.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ask.apiKey ? { Authorization: `Bearer ${ask.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: ask.model,
      messages: [
        { role: 'system', content: ask.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: ask.prompt },
            { type: 'image_url', image_url: { url: ask.dataUrl } },
          ],
        },
      ],
      max_tokens: ask.maxTokens,
      temperature: 0.2,
      stream: false,
    }),
    signal: AbortSignal.timeout(ask.timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
    throw new Error(`${ask.base} answered ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '';
  return {
    text: text.trim(),
    tokensIn: Number(json.usage?.prompt_tokens ?? 0),
    tokensOut: Number(json.usage?.completion_tokens ?? 0),
  };
}
