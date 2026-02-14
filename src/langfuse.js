const { Langfuse } = require('langfuse');

let client = null;
let initialized = false;
let warnedMissingConfig = false;
let warnedInitError = false;

function normalizeEnvValue(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function getLangfuseClient() {
  if (initialized) return client;
  initialized = true;

  const publicKey = normalizeEnvValue(process.env.LANGFUSE_PUBLIC_KEY);
  const secretKey = normalizeEnvValue(process.env.LANGFUSE_SECRET_KEY);
  const baseUrl = normalizeEnvValue(process.env.LANGFUSE_BASE_URL);

  if (!publicKey || !secretKey || !baseUrl) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.log('[Langfuse] Disabled (missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL)');
    }
    return null;
  }

  try {
    client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl,
      flushAt: 10,
      flushInterval: 3000,
      requestTimeout: 5000,
      enabled: true,
    });
    console.log(`[Langfuse] Enabled (${baseUrl})`);
  } catch (err) {
    if (!warnedInitError) {
      warnedInitError = true;
      console.warn('[Langfuse] Failed to initialize:', err?.message || err);
    }
    client = null;
  }

  return client;
}

function normalizeTiming(turnTimer) {
  const rowsRaw = Array.isArray(turnTimer?.rows) ? turnTimer.rows : [];
  if (!rowsRaw.length) return null;

  const rows = rowsRaw
    .map((row) => ({
      event: String(row?.event || ''),
      atMs: Number(row?.atMs) || 0,
    }))
    .filter((row) => row.event && row.atMs > 0)
    .sort((a, b) => a.atMs - b.atMs);

  if (!rows.length) return null;

  const startedAt = Number(turnTimer?.startedAt) || rows[0].atMs;
  let prev = startedAt;
  const events = rows.map((row) => {
    const offsetMs = Math.max(0, row.atMs - startedAt);
    const deltaMs = Math.max(0, row.atMs - prev);
    prev = row.atMs;
    return {
      event: row.event,
      offsetMs,
      deltaMs,
      atIso: new Date(row.atMs).toISOString(),
    };
  });

  return {
    startedAt,
    endedAt: rows[rows.length - 1].atMs,
    totalMs: Math.max(0, rows[rows.length - 1].atMs - startedAt),
    rows,
    events,
  };
}

function findEventTime(timing, prefix) {
  if (!timing || !Array.isArray(timing.rows)) return null;
  const row = timing.rows.find((entry) => entry.event === prefix || entry.event.startsWith(prefix));
  return row ? row.atMs : null;
}

function captureTurnTrace({
  turnId,
  source = 'unknown',
  userText = '',
  reply = null,
  telemetry = null,
  turnTimer = null,
} = {}) {
  const langfuse = getLangfuseClient();
  if (!langfuse) return;

  try {
    const timing = normalizeTiming(turnTimer);
    const llmRequest = telemetry?.llmRequest || null;
    const context = telemetry?.context || {};
    const tokensIn = Number(reply?.tokens?.in || 0);
    const tokensOut = Number(reply?.tokens?.out || 0);
    const totalTokens = tokensIn + tokensOut;
    const costUsd = Number(reply?.costUsd || 0);

    const trace = langfuse.trace({
      id: turnId || undefined,
      name: 'assistant_turn',
      timestamp: timing?.startedAt ? new Date(timing.startedAt) : new Date(),
      input: {
        text: String(userText || ''),
        source,
      },
      output: {
        text: String(reply?.text || ''),
      },
      tags: ['tubs-face', source, String(reply?.source || 'unknown')],
      metadata: {
        responseSource: reply?.source || null,
        imageAttached: Boolean(context.imageAttached),
        imageMode: context.mode || 'text',
        historyMessages: Number(context.historyMessages || 0),
        historyChars: Number(context.historyChars || 0),
        timingTotalMs: timing?.totalMs ?? null,
      },
    });

    if (llmRequest || reply?.model) {
      const llmStart = Number(telemetry?.llmStartAt)
        || findEventTime(timing, 'LLM started')
        || timing?.startedAt
        || Date.now();
      const llmEnd = Number(telemetry?.llmEndAt)
        || findEventTime(timing, 'LLM completed')
        || timing?.endedAt
        || Date.now();

      trace.generation({
        name: 'assistant_generation',
        model: reply?.model || undefined,
        startTime: new Date(llmStart),
        endTime: new Date(llmEnd),
        input: llmRequest
          ? {
            systemInstruction: String(llmRequest.systemInstruction || ''),
            contents: Array.isArray(llmRequest.contents) ? llmRequest.contents : [],
          }
          : String(userText || ''),
        output: reply?.beats
          ? {
            text: String(reply?.text || ''),
            beats: reply.beats,
          }
          : String(reply?.text || ''),
        usageDetails: {
          input: tokensIn,
          output: tokensOut,
          total: totalTokens,
        },
        costDetails: {
          total: costUsd,
        },
        metadata: {
          source,
          responseSource: reply?.source || null,
          donation: reply?.donation?.show ? (reply.donation.reason || 'shown') : 'none',
          imageAttached: Boolean(context.imageAttached),
          historyMessages: Number(context.historyMessages || 0),
          historyChars: Number(context.historyChars || 0),
        },
      });
    }

    if (timing?.events?.length) {
      trace.event({
        name: 'turn_timing',
        metadata: {
          source,
          totalMs: timing.totalMs,
          events: timing.events,
        },
      });
    }
  } catch (err) {
    console.warn('[Langfuse] Failed to capture turn trace:', err?.message || err);
  }
}

async function shutdownLangfuse(timeoutMs = 1500) {
  const langfuse = getLangfuseClient();
  if (!langfuse) return;
  try {
    await Promise.race([
      langfuse.shutdownAsync(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch (err) {
    console.warn('[Langfuse] Shutdown flush failed:', err?.message || err);
  }
}

module.exports = {
  captureTurnTrace,
  shutdownLangfuse,
};
