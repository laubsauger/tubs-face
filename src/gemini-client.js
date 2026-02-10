const DEFAULT_GEMINI_BASE_URL = process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

function extractResponseText(responseJson) {
  const candidates = Array.isArray(responseJson.candidates) ? responseJson.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    const text = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

async function generateGeminiContent({
  apiKey,
  model,
  systemInstruction,
  contents,
  maxOutputTokens = 120,
  temperature = 0.5,
  timeoutMs = 12000,
}) {
  if (!apiKey) {
    const err = new Error('Missing GEMINI_API_KEY');
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  if (!model) {
    const err = new Error('Missing model name');
    err.code = 'MISSING_MODEL';
    throw err;
  }

  const endpoint = `${DEFAULT_GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents,
    generationConfig: {
      maxOutputTokens,
      temperature,
      topP: 0.9,
    },
  };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  let raw = '';
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    raw = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Gemini request timed out');
      timeoutErr.code = 'GEMINI_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }

  if (!res.ok) {
    const detail = json?.error?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(`Gemini API error: ${detail}`);
    err.code = 'GEMINI_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }

  if (!json) {
    const err = new Error('Gemini API returned non-JSON response');
    err.code = 'GEMINI_BAD_RESPONSE';
    throw err;
  }

  const text = extractResponseText(json);
  if (!text) {
    const err = new Error('Gemini response did not contain text output');
    err.code = 'GEMINI_EMPTY_RESPONSE';
    throw err;
  }

  return {
    text,
    usage: json.usageMetadata || {},
    model: json.modelVersion || model,
  };
}

module.exports = { generateGeminiContent };
