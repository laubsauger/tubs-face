const DEFAULT_GEMINI_BASE_URL = process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

function extractResponseText(responseJson, { trim = true } = {}) {
  const candidates = Array.isArray(responseJson.candidates) ? responseJson.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    const raw = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
    const text = trim ? raw.trim() : raw;
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
  temperature = 1,
  timeoutMs = 12000,
  responseMimeType = null,
  responseSchema = null,
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
  console.log(`[Gemini] Request: model=${model}, maxOutputTokens=${maxOutputTokens}, temperature=${temperature}`);
  const payload = {
    contents,
    generationConfig: {
      maxOutputTokens,
      temperature,
      thinkingConfig: {
        // thinkingBudget: 0,
        thinkingLevel: 'MINIMAL',
      },
    },
  };
  if (responseMimeType) {
    payload.generationConfig.responseMimeType = responseMimeType;
  }
  if (responseSchema && typeof responseSchema === 'object') {
    payload.generationConfig.responseSchema = responseSchema;
  }

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
  console.log(`[Gemini] Extracted text (${text.length} chars), finishReason: ${json.candidates?.[0]?.finishReason || 'unknown'}, usage: promptTokens=${json.usageMetadata?.promptTokenCount || '?'}, outputTokens=${json.usageMetadata?.candidatesTokenCount || '?'}`);
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

async function streamGeminiContent({
  apiKey,
  model,
  systemInstruction,
  contents,
  maxOutputTokens = 256,
  temperature = 1,
  timeoutMs = 20000,
  onChunk,
  abortSignal,
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

  const endpoint = `${DEFAULT_GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  console.log(`[Gemini:stream] Request: model=${model}, maxOutputTokens=${maxOutputTokens}, temperature=${temperature}`);

  const payload = {
    contents,
    generationConfig: {
      maxOutputTokens,
      temperature,
      thinkingConfig: {
        //thinkingBudget: 0,
        thinkingLevel: 'MINIMAL',
      },
    },
  };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // If caller provides an abort signal, chain it
  if (abortSignal) {
    if (abortSignal.aborted) {
      clearTimeout(timeout);
      return { text: '', usage: {}, model, aborted: true };
    }
    abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res;
  let fullText = '';
  let usage = {};
  let aborted = false;

  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const raw = await res.text();
      let json;
      try { json = JSON.parse(raw); } catch { json = null; }
      const detail = json?.error?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
      const err = new Error(`Gemini API error: ${detail}`);
      err.code = 'GEMINI_HTTP_ERROR';
      err.status = res.status;
      throw err;
    }

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        let chunk;
        try { chunk = JSON.parse(jsonStr); } catch { continue; }

        const delta = extractResponseText(chunk, { trim: false });
        if (delta) {
          fullText += delta;
          if (onChunk) onChunk(delta);
        }

        // Capture usage from last chunk
        if (chunk.usageMetadata) {
          usage = chunk.usageMetadata;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      aborted = true;
      console.log(`[Gemini:stream] Aborted (${fullText.length} chars so far)`);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }

  console.log(`[Gemini:stream] Complete: ${fullText.length} chars, aborted=${aborted}, usage: promptTokens=${usage.promptTokenCount || '?'}, outputTokens=${usage.candidatesTokenCount || '?'}`);

  return {
    text: fullText,
    usage,
    model,
    aborted,
  };
}

module.exports = { generateGeminiContent, streamGeminiContent };
