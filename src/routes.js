const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  runtimeConfig,
  sessionStats,
  normalizeSttModel,
  normalizeLlmModel,
  normalizeLlmMaxOutputTokens,
  normalizeDonationSignalMode,
  normalizeMinFaceBoxAreaRatio,
  normalizeFaceRenderMode,
  normalizeRenderQuality,
  normalizeKokoroVoice,
  normalizeBooleanConfig,
  normalizeDualHeadMode,
  normalizeSecondaryAudioGain,
  normalizeDualHeadTurnPolicy,
  normalizeHexColor,
} = require('./config');
const { broadcast, getClients, getLatestFrame, consumeAppearanceFrame, abortActiveWsTurn } = require('./websocket');
const { detectWakeWord, WAKE_MATCHER_VERSION } = require('./wake-word');
const {
  transcribeAudio,
  restartTranscriptionService,
  getProcessingMode,
  getTtsProxyTarget,
} = require('./processing/mode-manager');
const { readFaceLib, writeFaceLib } = require('./face-library');
const { generateAssistantReply, generateStreamingAssistantReply } = require('./assistant-service');
const crypto = require('crypto');
const { createOrder: createPayPalOrder, captureOrder: capturePayPalOrder } = require('./paypal-client');
const { logConversation, logTubsReply } = require('./logger');
const { createTurnTimer } = require('./turn-timing');
const { captureTurnTrace } = require('./langfuse');

const staticPath = path.join(__dirname, '../public');

// After a wake word is detected, Tubs stays in "conversation mode" for this
// duration — subsequent speech is processed without requiring the wake word.
const CONVERSATION_WINDOW_MS = 45_000; // 45 seconds
let lastConversationAt = 0;

// --- Turn accumulation state (Phase 2) ---
let activeTurn = null;
const MANUAL_TURN_MAX_BEATS = 48;
const MANUAL_ACTORS = new Set(['main', 'small']);
const MANUAL_ACTIONS = new Set(['speak', 'react', 'wait']);
const MANUAL_EMOJI_CUES = new Set(['🙂', '😄', '😏', '🥺', '😢', '😤', '🤖', '🫶']);

function isMuted() {
  return runtimeConfig.muted === true;
}

function computeEndpointTimeout(text) {
  if (!text) return 520;
  const words = text.trim().split(/\s+/);
  if (/[.!?]\s*$/.test(text) && words.length > 3) return 260;
  if (/[,]\s*$/.test(text) || /\b(and|but|so|because|or|then|that|which|when|while|if)\s*$/i.test(text)) return 860;
  if (words.length < 3) return 620;
  if (words.length > 18) return 420;
  return 340;
}

function markTurnContext(turnTimer, meta) {
  if (!turnTimer || !meta) return;
  turnTimer.mark(`Image attached: ${meta.imageAttached ? 'yes' : 'no'}`);
  turnTimer.mark(`History context: ${meta.historyMessages || 0} msgs / ${meta.historyChars || 0} chars`);
  turnTimer.mark(`LLM mode: ${meta.mode || 'text'}`);
}

function abortActiveTurn(turnId) {
  if (!activeTurn || activeTurn.turnId !== turnId) return false;
  console.log(`[Turn] Aborting turn ${turnId}`);
  if (activeTurn.turnTimer) {
    activeTurn.turnTimer.mark('Turn aborted');
    activeTurn.turnTimer.log({ title: '[Turn Timing]' });
  }
  if (activeTurn.abortController) activeTurn.abortController.abort();
  if (activeTurn.endpointTimer) clearTimeout(activeTurn.endpointTimer);
  activeTurn = null;
  return true;
}

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.woff': 'application/font-woff',
  '.ttf': 'application/font-ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'application/font-otf',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
  '.onnx': 'application/octet-stream'
};

function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Donation-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: getClients().size,
      uptime: Math.floor((Date.now() - sessionStats.uptime) / 1000),
      processingMode: getProcessingMode(),
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessionStats));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/speak') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        if (isMuted()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ignored: true, reason: 'muted' }));
          return;
        }
        const { text } = JSON.parse(body);
        if (!text) throw new Error('Missing text');
        broadcast({ type: 'speak', text, ts: Date.now() });
        logConversation('TUBS', text);
        sessionStats.messagesOut++;
        sessionStats.lastActivity = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/turn-script/manual') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        if (isMuted()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ignored: true, reason: 'muted' }));
          return;
        }

        const payload = JSON.parse(body || '{}');
        const beats = normalizeManualTurnBeats(payload);
        const donation = normalizeManualDonation(payload?.donation);

        if (activeTurn) {
          if (activeTurn.turnTimer) {
            activeTurn.turnTimer.mark('Turn superseded by manual script');
            activeTurn.turnTimer.log({ title: '[Turn Timing]' });
          }
          if (activeTurn.abortController) activeTurn.abortController.abort();
          if (activeTurn.endpointTimer) clearTimeout(activeTurn.endpointTimer);
          activeTurn = null;
        }
        abortActiveWsTurn('manual_turn_script');

        const turnId = crypto.randomBytes(6).toString('hex');
        broadcast({ type: 'turn_start', turnId });
        broadcast({
          type: 'turn_script',
          turnId,
          beats,
          donation,
          ts: Date.now(),
        });

        const spokenText = beats
          .filter((beat) => beat.action === 'speak' && beat.text)
          .map((beat) => beat.text)
          .join(' ')
          .trim();
        if (spokenText) {
          logConversation('TUBS:manual', spokenText);
        }

        sessionStats.messagesOut++;
        sessionStats.lastActivity = Date.now();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          turnId,
          beatCount: beats.length,
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/voice') {
    const wakeWord = url.searchParams.get('wakeWord') === 'true';

    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      const turnTimer = createTurnTimer({ side: 'backend', source: 'voice' });
      turnTimer.mark('Voice request received');
      if (isMuted()) {
        turnTimer.mark('Ignored (muted)');
        broadcast({ type: 'expression', expression: 'idle' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        turnTimer.mark('HTTP response sent');
        turnTimer.log({ title: '[Turn Timing]' });
        res.end(JSON.stringify({ ok: true, ignored: true, reason: 'muted' }));
        return;
      }

      const audioBuffer = Buffer.concat(body);
      console.log(`[Voice] Received ${audioBuffer.length} bytes`);

      broadcast({ type: 'thinking' });

      try {
        turnTimer.mark('STT started');
        const result = await transcribeAudio(audioBuffer, req.headers['content-type']);
        turnTimer.mark('STT completed');
        const text = result.text;
        console.log(`[Transcribed] "${text}"`);
        let wake = null;
        const inConversation = (Date.now() - lastConversationAt) < CONVERSATION_WINDOW_MS;

        if (wakeWord) {
          wake = detectWakeWord(text);
          const skipWake = !wake.detected && inConversation;
          console.log(
            `[WakeWord:${WAKE_MATCHER_VERSION}] detected=${wake.detected} convo=${inConversation} skip=${skipWake} reason=${wake.reason} source=${wake.matchedSource || ''} normalized="${wake.normalized}" matched="${wake.matchedToken || ''}"`
          );
          if (!wake.detected && !inConversation) {
            console.log('[Voice] Wake word not detected and not in conversation, ignoring.');
            turnTimer.mark('Ignored (wake word missing)');
            broadcast({ type: 'expression', expression: 'idle' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            turnTimer.mark('HTTP response sent');
            turnTimer.log({ title: '[Turn Timing]' });
            res.end(JSON.stringify({
              ok: true,
              ignored: true,
              text: text,
              wake: {
                ...wake,
                version: WAKE_MATCHER_VERSION,
              },
            }));
            return;
          }
          if (skipWake) {
            console.log('[Voice] No wake word but in conversation mode — processing.');
          }
        }

        broadcast({ type: 'incoming', text: text });
        logConversation('USER', text);
        sessionStats.messagesIn++;
        lastConversationAt = Date.now();
        broadcast({ type: 'conversation_mode', active: true, expiresIn: CONVERSATION_WINDOW_MS });

        const turnId = crypto.randomBytes(6).toString('hex');
        broadcast({ type: 'turn_start', turnId });
        turnTimer.mark('Turn started');

        const reply = await generateStreamingAssistantReply(text, {
          broadcast,
          turnId,
          abortController: activeTurn?.abortController,
          frame: getLatestFrame(),
          appearanceFrame: consumeAppearanceFrame(),
          timingHooks: {
            onLlmStart: () => turnTimer.mark('LLM started'),
            onFirstToken: (source) => turnTimer.mark(`LLM first token (${source})`),
            onLlmDone: () => turnTimer.mark('LLM completed'),
            onContextMeta: (meta) => markTurnContext(turnTimer, meta),
          },
        });
        turnTimer.mark('Reply ready');
        logTubsReply(reply);
        captureTurnTrace({
          turnId,
          source: 'voice',
          userText: text,
          reply,
          telemetry: reply?.telemetry || null,
          turnTimer,
        });

        sessionStats.messagesOut++;
        sessionStats.lastActivity = Date.now();
        sessionStats.tokensIn += reply.tokens.in || 0;
        sessionStats.tokensOut += reply.tokens.out || 0;
        sessionStats.costUsd += reply.costUsd || 0;
        if (reply.model) {
          sessionStats.model = reply.model;
        }

        broadcast({
          type: 'stats',
          tokens: { in: reply.tokens.in || 0, out: reply.tokens.out || 0 },
          totals: {
            in: sessionStats.tokensIn,
            out: sessionStats.tokensOut,
            cost: sessionStats.costUsd,
          },
          latency: reply.latencyMs,
          model: reply.model || runtimeConfig.llmModel || runtimeConfig.model,
          cost: reply.costUsd || 0,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        turnTimer.mark('HTTP response sent');
        turnTimer.log({ title: '[Turn Timing]' });
        res.end(JSON.stringify({
          ok: true,
          turnId,
          text: text,
          wake: wakeWord && wake
            ? {
              ...wake,
              version: WAKE_MATCHER_VERSION,
            }
            : undefined,
        }));

      } catch (err) {
        turnTimer.mark(`Error (${err?.message || 'unknown'})`);
        turnTimer.log({ title: '[Turn Timing]' });
        console.error('[Voice] Transcription error:', err);
        broadcast({ type: 'error', text: 'Transcription failed' });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // --- Preview-only voice transcription (live subtitle fallback) ---
  if (req.method === 'POST' && url.pathname === '/voice/preview') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      if (isMuted()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ignored: true, reason: 'muted', text: '' }));
        return;
      }

      const audioBuffer = Buffer.concat(body);
      if (!audioBuffer.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text: '' }));
        return;
      }

      try {
        const result = await transcribeAudio(audioBuffer, req.headers['content-type']);
        const text = String(result?.text || '').trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text }));
      } catch (err) {
        console.error('[Voice:preview] Transcription error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // --- Segment-based voice input (Phase 2: turn accumulation) ---
  if (req.method === 'POST' && url.pathname === '/voice/segment') {
    const wakeWord = url.searchParams.get('wakeWord') === 'true';
    const FILLER_RE = /^(um+|uh+|hmm+|ah+|oh+|er+|huh|mhm|mm+)\s*[.!?]?\s*$/i;

    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      if (isMuted()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ignored: true, reason: 'muted' }));
        return;
      }

      const audioBuffer = Buffer.concat(body);
      console.log(`[Segment] Received ${audioBuffer.length} bytes`);

      try {
        const result = await transcribeAudio(audioBuffer, req.headers['content-type']);
        const text = result.text?.trim();
        console.log(`[Segment] Transcribed: "${text}"`);

        if (!text || FILLER_RE.test(text)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ignored: true, text }));
          return;
        }

        // Wake word check on first segment of a new turn
        if (wakeWord && !activeTurn) {
          const inConversation = (Date.now() - lastConversationAt) < CONVERSATION_WINDOW_MS;
          const wake = detectWakeWord(text);
          if (!wake.detected && !inConversation) {
            console.log('[Segment] Wake word not detected, not in conversation — ignoring.');
            broadcast({ type: 'expression', expression: 'idle' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ignored: true, text, wake }));
            return;
          }
        }

        // Create or extend active turn
        if (!activeTurn) {
          const turnId = crypto.randomBytes(6).toString('hex');
          const turnTimer = createTurnTimer({ side: 'backend', source: 'voice-segment', turnId });
          turnTimer.mark('First segment received');
          activeTurn = {
            turnId,
            segments: [],
            fullText: '',
            endpointTimer: null,
            state: 'accumulating',
            abortController: new AbortController(),
            turnTimer,
          };
          broadcast({ type: 'turn_start', turnId: activeTurn.turnId });
          activeTurn.turnTimer.mark('Turn started');
        }

        activeTurn.segments.push(text);
        activeTurn.fullText = activeTurn.segments.join(' ');

        // Backchannel: occasionally emit a filler when user has been speaking for 2+ segments
        if (activeTurn.segments.length >= 2 && Math.random() < 0.4) {
          const fillers = ['mhm', 'yeah', 'right', 'uh huh', 'okay', 'mm'];
          const filler = fillers[Math.floor(Math.random() * fillers.length)];
          broadcast({ type: 'backchannel', text: filler });
        }

        // Show progressive text
        broadcast({ type: 'incoming', text: activeTurn.fullText });
        lastConversationAt = Date.now();
        broadcast({ type: 'conversation_mode', active: true, expiresIn: CONVERSATION_WINDOW_MS });

        // Reset adaptive endpoint timer
        if (activeTurn.endpointTimer) clearTimeout(activeTurn.endpointTimer);
        const timeout = computeEndpointTimeout(activeTurn.fullText);
        console.log(`[Segment] Endpoint timeout: ${timeout}ms for "${activeTurn.fullText}"`);

        activeTurn.endpointTimer = setTimeout(() => {
          if (!activeTurn || activeTurn.state !== 'accumulating') return;
          activeTurn.state = 'generating';
          const turn = activeTurn;
          const turnText = turn.fullText;
          const turnId = turn.turnId;
          turn.turnTimer?.mark('User stopped speaking (endpoint)');

          console.log(`[Segment] Endpoint fired — generating reply for: "${turnText}"`);
          logConversation('USER', turnText);
          sessionStats.messagesIn++;
          broadcast({ type: 'thinking' });

          generateStreamingAssistantReply(turnText, {
            broadcast,
            turnId,
            abortController: turn.abortController,
            frame: getLatestFrame(),
            appearanceFrame: consumeAppearanceFrame(),
            timingHooks: {
              onLlmStart: () => turn.turnTimer?.mark('LLM started'),
              onFirstToken: (source) => turn.turnTimer?.mark(`LLM first token (${source})`),
              onLlmDone: () => turn.turnTimer?.mark('LLM completed'),
              onContextMeta: (meta) => markTurnContext(turn.turnTimer, meta),
            },
          }).then((reply) => {
            turn.turnTimer?.mark('Reply ready');
            logTubsReply(reply);
            captureTurnTrace({
              turnId,
              source: 'voice-segment',
              userText: turnText,
              reply,
              telemetry: reply?.telemetry || null,
              turnTimer: turn.turnTimer,
            });
            sessionStats.messagesOut++;
            sessionStats.lastActivity = Date.now();
            sessionStats.tokensIn += reply.tokens.in || 0;
            sessionStats.tokensOut += reply.tokens.out || 0;
            sessionStats.costUsd += reply.costUsd || 0;
            if (reply.model) sessionStats.model = reply.model;

            broadcast({
              type: 'stats',
              tokens: { in: reply.tokens.in || 0, out: reply.tokens.out || 0 },
              totals: {
                in: sessionStats.tokensIn,
                out: sessionStats.tokensOut,
                cost: sessionStats.costUsd,
              },
              latency: reply.latencyMs,
              model: reply.model || runtimeConfig.llmModel || runtimeConfig.model,
              cost: reply.costUsd || 0,
            });
            turn.turnTimer?.mark('Stats broadcast');
            turn.turnTimer?.log({ title: '[Turn Timing]' });
          }).catch((err) => {
            turn.turnTimer?.mark(`Error (${err?.message || 'unknown'})`);
            turn.turnTimer?.log({ title: '[Turn Timing]' });
            console.error('[Segment] Generation error:', err);
            broadcast({ type: 'error', text: 'Response generation failed' });
          }).finally(() => {
            // Clear turn if it's still the same one
            if (activeTurn && activeTurn.turnId === turnId) {
              activeTurn = null;
            }
          });
        }, timeout);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text, turnId: activeTurn?.turnId }));

      } catch (err) {
        console.error('[Segment] Error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/sleep') {
    lastConversationAt = 0;
    broadcast({ type: 'conversation_mode', active: false });
    broadcast({ type: 'sleep' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/tts') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const ttsTarget = getTtsProxyTarget();
      const reqOptions = {
        hostname: ttsTarget.hostname || 'localhost',
        port: ttsTarget.port || 3001,
        path: ttsTarget.path || '/tts',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const proxyReq = http.request(reqOptions, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (e) => {
        console.error('[Bridge] TTS Proxy execution error:', e);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'TTS Service unavailable', details: e.message }));
        }
      });

      proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/wake') {
    broadcast({ type: 'wake' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/checkout/paypal/order') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const order = await createPayPalOrder({
          amount: payload.amount ?? process.env.PAYPAL_DEFAULT_DONATION_AMOUNT ?? '5.00',
          currency: payload.currency ?? 'USD',
          description: payload.description ?? 'Wheels for Tubs',
          referenceId: payload.referenceId,
        });
        const approveUrl = Array.isArray(order.links)
          ? (order.links.find(link => link.rel === 'approve') || {}).href
          : undefined;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          orderId: order.id,
          status: order.status,
          approveUrl,
          order,
        }));
      } catch (e) {
        const status = (
          e.code === 'BAD_PAYPAL_AMOUNT'
          || e.code === 'BAD_PAYPAL_CURRENCY'
          || e instanceof SyntaxError
        )
          ? 400
          : e.code === 'MISSING_PAYPAL_CREDENTIALS'
            ? 503
            : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, details: e.details }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/checkout/paypal/capture') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const capture = await capturePayPalOrder(payload.orderId);
        const signal = toDonationSignalFromPayPalCapture(capture);
        if (signal) emitDonationSignal(signal);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          capture,
          donationSignal: signal || null,
        }));
      } catch (e) {
        const status = (
          e.code === 'BAD_PAYPAL_ORDER_ID'
          || e instanceof SyntaxError
        )
          ? 400
          : e.code === 'MISSING_PAYPAL_CREDENTIALS'
            ? 503
            : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, details: e.details }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/donations/confirm') {
    if (!isDonationWebhookAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized donation confirmation' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const certainty = normalizeDonationSignalCertainty(payload.certainty || 'confident');
        const signal = {
          certainty,
          source: String(payload.source || 'manual-confirm'),
          amount: toSafeAmount(payload.amount),
          currency: normalizeCurrencyCode(payload.currency),
          note: payload.note ? String(payload.note).slice(0, 180) : undefined,
          donor: payload.donor ? String(payload.donor).slice(0, 64) : undefined,
          reference: payload.reference ? String(payload.reference).slice(0, 120) : undefined,
        };

        emitDonationSignal(signal);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, signal }));
      } catch (e) {
        const status = e.code === 'BAD_CONFIG' || e instanceof SyntaxError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/paypal') {
    if (!isDonationWebhookAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized webhook' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const event = JSON.parse(body || '{}');
        const eventType = String(event.event_type || '').trim();
        const signal = toDonationSignalFromPaypalEvent(eventType, event);

        if (signal) {
          emitDonationSignal(signal);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, processed: true, eventType, signal }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, processed: false, eventType }));
      } catch (e) {
        const status = e instanceof SyntaxError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Face Library CRUD
  if (req.method === 'GET' && url.pathname === '/faces') {
    const lib = readFaceLib();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lib));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/faces') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { name, embedding, thumbnail } = JSON.parse(body);
        if (!name || !embedding || !Array.isArray(embedding)) {
          throw new Error('Missing name or embedding array');
        }
        const lib = readFaceLib();
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const entry = { id, name, embedding, createdAt: Date.now() };
        if (thumbnail && typeof thumbnail === 'string') {
          entry.thumbnail = thumbnail;
        }
        lib.faces.push(entry);
        writeFaceLib(lib);
        console.log(`[Faces] Added "${name}" (id=${id})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/faces') {
    const id = url.searchParams.get('id');
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing id parameter' }));
      return;
    }
    const lib = readFaceLib();
    const before = lib.faces.length;
    lib.faces = lib.faces.filter(f => f.id !== id);
    writeFaceLib(lib);
    console.log(`[Faces] Deleted id=${id} (${before - lib.faces.length} removed)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Face Ingestion Routes
  if (req.method === 'GET' && url.pathname === '/ingest/list') {
    const inputDir = path.join(__dirname, '../input_faces');
    const files = [];

    if (fs.existsSync(inputDir)) {
      const entries = fs.readdirSync(inputDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const name = entry.name;
          const personDir = path.join(inputDir, name);
          const personFiles = fs.readdirSync(personDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
          for (const f of personFiles) {
            files.push({
              name,
              filename: f,
              url: `/raw-faces/${encodeURIComponent(name)}/${encodeURIComponent(f)}`,
              relPath: `${name}/${f}`
            });
          }
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ingest/done') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { relPath } = JSON.parse(body);
        if (!relPath) throw new Error('Missing relPath');

        const inputPath = path.join(__dirname, '../input_faces', relPath);
        const processedPath = path.join(__dirname, '../processed_faces', relPath);

        if (fs.existsSync(inputPath)) {
          const targetDir = path.dirname(processedPath);
          fs.mkdirSync(targetDir, { recursive: true });
          fs.renameSync(inputPath, processedPath);
          console.log(`[Ingest] Moved ${relPath} to processed_faces`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve raw face images for ingestion
  if (req.method === 'GET' && url.pathname.startsWith('/raw-faces/')) {
    const relPath = decodeURIComponent(url.pathname.replace('/raw-faces/', ''));
    const fullPath = path.join(__dirname, '../input_faces', relPath);

    // preventing directory traversal for security
    if (!fullPath.startsWith(path.join(__dirname, '../input_faces'))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
      } else {
        const ext = path.extname(fullPath).toLowerCase();
        const mime = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/shapes/')) {
    const filename = decodeURIComponent(url.pathname.replace('/shapes/', ''));
    if (!/^[a-zA-Z0-9._-]+\.svg$/.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid shape filename' }));
      return;
    }

    const shapesDir = path.join(__dirname, 'shapes');
    const fullPath = path.join(shapesDir, filename);
    if (!fullPath.startsWith(shapesDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Shape not found' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(runtimeConfig));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/config') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const config = JSON.parse(body || '{}');
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          const err = new Error('Config payload must be a JSON object');
          err.code = 'BAD_CONFIG';
          throw err;
        }
        if (Object.hasOwn(config, 'processingMode')) {
          const err = new Error('processingMode is startup-only; restart with PROCESSING_MODE=legacy or PROCESSING_MODE=realtime');
          err.code = 'BAD_CONFIG';
          throw err;
        }

        if (Object.hasOwn(config, 'sttModel')) {
          config.sttModel = normalizeSttModel(config.sttModel);
        }
        if (Object.hasOwn(config, 'llmModel')) {
          config.llmModel = normalizeLlmModel(config.llmModel);
        }
        if (Object.hasOwn(config, 'llmMaxOutputTokens')) {
          config.llmMaxOutputTokens = normalizeLlmMaxOutputTokens(config.llmMaxOutputTokens);
        }
        if (Object.hasOwn(config, 'donationSignalMode')) {
          config.donationSignalMode = normalizeDonationSignalMode(config.donationSignalMode);
        }
        if (Object.hasOwn(config, 'minFaceBoxAreaRatio')) {
          config.minFaceBoxAreaRatio = normalizeMinFaceBoxAreaRatio(config.minFaceBoxAreaRatio);
        }
        if (Object.hasOwn(config, 'faceRenderMode')) {
          config.faceRenderMode = normalizeFaceRenderMode(config.faceRenderMode);
        }
        if (Object.hasOwn(config, 'renderQuality')) {
          config.renderQuality = normalizeRenderQuality(config.renderQuality, 'renderQuality');
        }
        if (Object.hasOwn(config, 'kokoroVoice')) {
          config.kokoroVoice = normalizeKokoroVoice(config.kokoroVoice);
        }
        if (Object.hasOwn(config, 'dualHeadEnabled')) {
          config.dualHeadEnabled = normalizeBooleanConfig(config.dualHeadEnabled, 'dualHeadEnabled');
        }
        if (Object.hasOwn(config, 'dualHeadMode')) {
          config.dualHeadMode = normalizeDualHeadMode(config.dualHeadMode);
        }
        if (Object.hasOwn(config, 'secondaryVoice')) {
          config.secondaryVoice = normalizeKokoroVoice(config.secondaryVoice);
        }
        if (Object.hasOwn(config, 'secondaryRenderQuality')) {
          config.secondaryRenderQuality = normalizeRenderQuality(config.secondaryRenderQuality, 'secondaryRenderQuality');
        }
        if (Object.hasOwn(config, 'secondarySubtitleEnabled')) {
          config.secondarySubtitleEnabled = normalizeBooleanConfig(config.secondarySubtitleEnabled, 'secondarySubtitleEnabled');
        }
        if (Object.hasOwn(config, 'secondaryAudioGain')) {
          config.secondaryAudioGain = normalizeSecondaryAudioGain(config.secondaryAudioGain);
        }
        if (Object.hasOwn(config, 'dualHeadTurnPolicy')) {
          config.dualHeadTurnPolicy = normalizeDualHeadTurnPolicy(config.dualHeadTurnPolicy);
        }
        if (Object.hasOwn(config, 'muted')) {
          config.muted = normalizeBooleanConfig(config.muted, 'muted');
        }
        if (Object.hasOwn(config, 'ambientAudioEnabled')) {
          config.ambientAudioEnabled = normalizeBooleanConfig(config.ambientAudioEnabled, 'ambientAudioEnabled');
        }
        if (Object.hasOwn(config, 'glitchFxEnabled')) {
          config.glitchFxEnabled = normalizeBooleanConfig(config.glitchFxEnabled, 'glitchFxEnabled');
        }
        if (Object.hasOwn(config, 'glitchFxBaseColor')) {
          config.glitchFxBaseColor = normalizeHexColor(config.glitchFxBaseColor, 'glitchFxBaseColor');
        }
        if (Object.hasOwn(config, 'secondaryGlitchFxBaseColor')) {
          config.secondaryGlitchFxBaseColor = normalizeHexColor(config.secondaryGlitchFxBaseColor, 'secondaryGlitchFxBaseColor');
        }

        const nextConfig = { ...runtimeConfig, ...config };
        const shouldRestartStt = nextConfig.sttModel !== runtimeConfig.sttModel;

        if (shouldRestartStt) {
          await restartTranscriptionService(nextConfig.sttModel);
        }

        Object.assign(runtimeConfig, nextConfig);

        if (runtimeConfig.muted && activeTurn) {
          if (activeTurn.abortController) activeTurn.abortController.abort();
          if (activeTurn.endpointTimer) clearTimeout(activeTurn.endpointTimer);
          activeTurn = null;
        }

        if (runtimeConfig.muted) {
          abortActiveWsTurn('muted');
          lastConversationAt = 0;
          broadcast({ type: 'conversation_mode', active: false });
          broadcast({ type: 'expression', expression: 'idle' });
        }

        broadcast({ type: 'config', ...runtimeConfig });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          config: runtimeConfig,
          sttRestarted: shouldRestartStt,
        }));
      } catch (e) {
        const status = e.code === 'BAD_CONFIG' || e instanceof SyntaxError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static files
  let filePath = url.pathname === '/' ? 'index.html' : url.pathname;
  const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const ext = path.extname(safePath);

  if (!ext || url.pathname === '/') {
    filePath = 'index.html';
  }

  const fullPath = path.join(staticPath, filePath);

  fs.stat(fullPath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const isImmutable = ext === '.onnx' || ext === '.wasm';
    const isHotReloadAsset = ext === '.js' || ext === '.css' || ext === '.mjs' || ext === '.html';
    const cacheControl = filePath === 'index.html' || isHotReloadAsset
      ? 'no-cache'
      : isImmutable
        ? 'public, max-age=604800, immutable'
        : 'public, max-age=3600';

    // Stream large files (audio/video) for faster first-byte delivery
    if (stats.size > 1_000_000 && (ext === '.mp3' || ext === '.wav' || ext === '.mp4')) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
        'Content-Length': stats.size,
        'Accept-Ranges': 'none',
      });
      fs.createReadStream(fullPath).pipe(res);
    } else {
      fs.readFile(fullPath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end(`Error loading ${safePath}`);
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': cacheControl,
          });
          res.end(data);
        }
      });
    }
  });
}

function sanitizeManualText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toManualDelayMs(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(120, Math.min(8000, Math.round(parsed)));
}

function normalizeManualEmotion(raw) {
  let expression = '';
  let emoji = '';
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    expression = sanitizeManualText(raw.expression).toLowerCase();
    emoji = sanitizeManualText(raw.emoji);
  } else if (typeof raw === 'string') {
    expression = sanitizeManualText(raw).toLowerCase();
  }

  if (emoji && !MANUAL_EMOJI_CUES.has(emoji)) {
    console.warn(`[ManualBeats] Unsupported emoji cue "${emoji}" — dropping`);
    emoji = '';
  }
  if (!expression && !emoji) return null;
  const emotion = {};
  if (expression) emotion.expression = expression;
  if (emoji) emotion.emoji = emoji;
  return emotion;
}

function normalizeManualBeat(rawBeat, index) {
  if (!rawBeat || typeof rawBeat !== 'object' || Array.isArray(rawBeat)) {
    const err = new Error(`Beat ${index} must be an object`);
    err.code = 'BAD_CONFIG';
    throw err;
  }

  const actorRaw = sanitizeManualText(rawBeat.actor).toLowerCase();
  const actor = MANUAL_ACTORS.has(actorRaw) ? actorRaw : 'main';

  const actionRaw = sanitizeManualText(rawBeat.action).toLowerCase();
  if (actionRaw && !MANUAL_ACTIONS.has(actionRaw)) {
    const err = new Error(`Beat ${index} has unsupported action "${actionRaw}"`);
    err.code = 'BAD_CONFIG';
    throw err;
  }
  let action = actionRaw || 'speak';

  const text = sanitizeManualText(rawBeat.text);
  // Manual testbed convenience: text beats should speak unless explicitly wait.
  if (action === 'react' && text) {
    action = 'speak';
  }
  if (action === 'speak' && !text) {
    const err = new Error(`Beat ${index} requires text for action "speak"`);
    err.code = 'BAD_CONFIG';
    throw err;
  }

  const beat = { actor, action };
  if (text) {
    beat.text = text;
  }

  const delayMs = toManualDelayMs(rawBeat.delayMs);
  if (delayMs != null) {
    beat.delayMs = delayMs;
  }

  const emotionSource = (rawBeat.emotion && typeof rawBeat.emotion === 'object')
    ? rawBeat.emotion
    : typeof rawBeat.emotion === 'string'
      ? rawBeat.emotion
      : {
        expression: rawBeat.expression,
        emoji: rawBeat.emoji,
      };
  const emotion = normalizeManualEmotion(emotionSource);
  if (emotion && action !== 'wait') {
    beat.emotion = emotion;
  }

  return beat;
}

function normalizeManualTurnBeats(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.beats)
      ? payload.beats
      : Array.isArray(payload?.turn_script?.beats)
        ? payload.turn_script.beats
        : null;

  if (!source) {
    const err = new Error('Manual turn payload must include beats[]');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (source.length === 0) {
    const err = new Error('Manual turn beats cannot be empty');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (source.length > MANUAL_TURN_MAX_BEATS) {
    const err = new Error(`Manual turn supports up to ${MANUAL_TURN_MAX_BEATS} beats`);
    err.code = 'BAD_CONFIG';
    throw err;
  }

  return source.map((beat, idx) => normalizeManualBeat(beat, idx));
}

function normalizeManualDonation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!raw.show) return null;
  return {
    show: true,
    reason: sanitizeManualText(raw.reason) || 'manual',
    venmoHandle: sanitizeManualText(raw.venmoHandle) || undefined,
    qrData: sanitizeManualText(raw.qrData) || undefined,
    qrImageUrl: sanitizeManualText(raw.qrImageUrl) || undefined,
  };
}

function normalizeCurrencyCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return undefined;
  if (!/^[A-Z]{3}$/.test(normalized)) return undefined;
  return normalized;
}

function toSafeAmount(value) {
  if (value == null || value === '') return undefined;
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Number(parsed.toFixed(2));
}

function normalizeDonationSignalCertainty(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'confident' || normalized === 'implied') return normalized;
  const err = new Error('Donation certainty must be "confident" or "implied"');
  err.code = 'BAD_CONFIG';
  throw err;
}

function extractBearerToken(req) {
  const auth = String(req.headers.authorization || '').trim();
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  return auth.slice(7).trim();
}

function isDonationWebhookAuthorized(req) {
  const expectedToken = String(process.env.DONATION_WEBHOOK_TOKEN || '').trim();
  if (!expectedToken) return true;

  const headerToken = String(req.headers['x-donation-token'] || '').trim();
  const bearerToken = extractBearerToken(req);
  return headerToken === expectedToken || bearerToken === expectedToken;
}

function emitDonationSignal(signal) {
  broadcast({
    type: 'donation_signal',
    certainty: signal.certainty,
    source: signal.source,
    amount: signal.amount,
    currency: signal.currency,
    donor: signal.donor,
    note: signal.note,
    reference: signal.reference,
    ts: Date.now(),
  });
}

function extractPaypalAmount(resource) {
  if (!resource || typeof resource !== 'object') return { amount: undefined, currency: undefined };
  const directAmount = resource.amount || resource.gross_amount;
  if (directAmount) {
    return {
      amount: toSafeAmount(directAmount.value),
      currency: normalizeCurrencyCode(directAmount.currency_code),
    };
  }

  const gross = resource.seller_receivable_breakdown?.gross_amount;
  if (gross) {
    return {
      amount: toSafeAmount(gross.value),
      currency: normalizeCurrencyCode(gross.currency_code),
    };
  }

  return { amount: undefined, currency: undefined };
}

function extractPaypalDonor(resource) {
  const payer = resource?.payer;
  if (!payer || typeof payer !== 'object') return undefined;
  const given = String(payer.name?.given_name || '').trim();
  const surname = String(payer.name?.surname || '').trim();
  const fullName = [given, surname].filter(Boolean).join(' ').trim();
  if (fullName) return fullName.slice(0, 64);
  const email = String(payer.email_address || '').trim();
  return email ? email.slice(0, 64) : undefined;
}

function toDonationSignalFromPayPalCapture(orderCapture) {
  if (!orderCapture || typeof orderCapture !== 'object') return null;
  const purchaseUnit = Array.isArray(orderCapture.purchase_units) ? orderCapture.purchase_units[0] : null;
  const capture = Array.isArray(purchaseUnit?.payments?.captures)
    ? purchaseUnit.payments.captures.find(item => item.status === 'COMPLETED') || purchaseUnit.payments.captures[0]
    : null;
  if (!capture) return null;

  const amount = toSafeAmount(capture.amount?.value);
  const currency = normalizeCurrencyCode(capture.amount?.currency_code);
  const donor = extractPaypalDonor(orderCapture);
  const reference = String(capture.id || orderCapture.id || '').trim() || undefined;

  return {
    certainty: 'confident',
    source: 'paypal-capture-api',
    amount,
    currency,
    donor,
    reference,
  };
}

function toDonationSignalFromPaypalEvent(eventType, event) {
  const resource = event?.resource || {};
  const { amount, currency } = extractPaypalAmount(resource);
  const donor = extractPaypalDonor(resource);
  const reference = String(resource?.id || event?.id || '').trim() || undefined;

  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    return {
      certainty: 'confident',
      source: 'paypal-webhook-capture',
      amount,
      currency,
      donor,
      reference,
    };
  }

  if (eventType === 'CHECKOUT.ORDER.APPROVED') {
    return {
      certainty: 'implied',
      source: 'paypal-webhook-approved',
      amount,
      currency,
      donor,
      reference,
    };
  }

  return null;
}

function touchConversation() {
  lastConversationAt = Date.now();
  broadcast({ type: 'conversation_mode', active: true, expiresIn: CONVERSATION_WINDOW_MS });
}

module.exports = { handleRequest, abortActiveTurn, touchConversation };
