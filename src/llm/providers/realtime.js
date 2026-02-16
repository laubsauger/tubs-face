const DEFAULT_REALTIME_PORT = Number.parseInt(process.env.REALTIME_PROCESSING_PORT || '3002', 10) || 3002;
const DEFAULT_REALTIME_HOST = process.env.REALTIME_PROCESSING_HOST || '127.0.0.1';
const DEFAULT_REALTIME_LLM_MODEL = String(process.env.REALTIME_LLM_MODEL || '').trim();

function getRealtimeBaseUrl() {
  return `http://${DEFAULT_REALTIME_HOST}:${DEFAULT_REALTIME_PORT}`;
}

function getRealtimeLlmProvider() {
  return String(process.env.REALTIME_LLM_PROVIDER || 'ollama').trim().toLowerCase();
}

function getAuthState() {
  const provider = getRealtimeLlmProvider();
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        ready: false,
        warningMessage: '[LLM] OPENAI_API_KEY missing for realtime openai provider. Conversational requests will fail.',
        auth: null,
      };
    }
    return {
      ready: true,
      warningMessage: null,
      auth: { apiKey },
    };
  }

  return {
    ready: true,
    warningMessage: null,
    auth: null,
  };
}

function buildPayload(args) {
  const requestedModel = String(args.model || '').trim();
  const systemInstruction = String(args.systemInstruction || '').trim();
  let model = requestedModel;
  if (!model || /^gemini[-._]/i.test(model)) {
    model = DEFAULT_REALTIME_LLM_MODEL;
  }
  if (!model) {
    const err = new Error(
      'REALTIME_LLM_MODEL is not configured. Set REALTIME_LLM_MODEL to an installed Ollama model (e.g. from `ollama list`).'
    );
    err.code = 'REALTIME_MODEL_NOT_CONFIGURED';
    throw err;
  }
  if (!systemInstruction) {
    const err = new Error(
      'systemInstruction is empty. Persona prompt must be present for realtime LLM calls.'
    );
    err.code = 'REALTIME_SYSTEM_PROMPT_MISSING';
    throw err;
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

async function parseJsonResponse(res) {
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }

  if (!res.ok) {
    const detail = json?.error || json?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(`Realtime LLM API error: ${detail}`);
    err.code = 'REALTIME_LLM_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }

  if (!json || typeof json !== 'object') {
    const err = new Error('Realtime LLM API returned non-JSON response');
    err.code = 'REALTIME_LLM_BAD_RESPONSE';
    throw err;
  }
  return json;
}

async function generateContent(args) {
  const endpoint = `${getRealtimeBaseUrl()}/llm/generate`;
  const payload = buildPayload(args);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await parseJsonResponse(res);
  return {
    text: String(json.text || '').trim(),
    usage: json.usage || {},
    model: json.model || args.model,
  };
}

async function streamContent(args) {
  const endpoint = `${getRealtimeBaseUrl()}/llm/stream`;
  const payload = buildPayload(args);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: args.abortSignal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return {
        text: '',
        usage: {},
        model: args.model,
        aborted: true,
      };
    }
    throw err;
  }

  if (!res.ok) {
    await parseJsonResponse(res);
  }

  if (!res.body) {
    const err = new Error('Realtime LLM stream API returned no response body');
    err.code = 'REALTIME_LLM_BAD_RESPONSE';
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let usage = {};
  let model = args.model;
  let aborted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.delta) {
          const delta = String(parsed.delta);
          fullText += delta;
          if (typeof args.onChunk === 'function') {
            args.onChunk(delta);
          }
        }
        if (parsed.usage) usage = parsed.usage;
        if (parsed.model) model = parsed.model;
      }
    }

    const tail = buffer.trim();
    if (tail) {
      let parsedTail = null;
      try {
        parsedTail = JSON.parse(tail);
      } catch {
        parsedTail = null;
      }
      if (parsedTail?.delta) {
        const delta = String(parsedTail.delta);
        fullText += delta;
        if (typeof args.onChunk === 'function') {
          args.onChunk(delta);
        }
      }
      if (parsedTail?.usage) usage = parsedTail.usage;
      if (parsedTail?.model) model = parsedTail.model;
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      aborted = true;
    } else {
      throw err;
    }
  }

  return {
    text: fullText,
    usage,
    model,
    aborted,
  };
}

module.exports = {
  id: 'realtime',
  getAuthState,
  generateContent,
  streamContent,
};
