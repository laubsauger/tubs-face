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
  normalizeKokoroVoice,
} = require('./config');
const { broadcast, getClients } = require('./websocket');
const { detectWakeWord, WAKE_MATCHER_VERSION } = require('./wake-word');
const { transcribeAudio, restartTranscriptionService } = require('./python-service');
const { readFaceLib, writeFaceLib } = require('./face-library');
const { generateAssistantReply } = require('./assistant-service');
const { createOrder: createPayPalOrder, captureOrder: capturePayPalOrder } = require('./paypal-client');
const { logConversation } = require('./logger');

const staticPath = path.join(__dirname, '../public');

// After a wake word is detected, Tubs stays in "conversation mode" for this
// duration — subsequent speech is processed without requiring the wake word.
const CONVERSATION_WINDOW_MS = 45_000; // 45 seconds
let lastConversationAt = 0;

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

  if (req.method === 'POST' && url.pathname === '/voice') {
    const wakeWord = url.searchParams.get('wakeWord') === 'true';

    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      const audioBuffer = Buffer.concat(body);
      console.log(`[Voice] Received ${audioBuffer.length} bytes`);

      broadcast({ type: 'thinking' });

      try {
        const result = await transcribeAudio(audioBuffer);
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
            broadcast({ type: 'expression', expression: 'idle' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
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

        const reply = await generateAssistantReply(text);
        broadcast({
          type: 'speak',
          text: reply.text,
          donation: reply.donation,
          emotion: reply.emotion || null,
          ts: Date.now(),
        });
        logConversation('TUBS', reply.text);

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
        res.end(JSON.stringify({
          ok: true,
          text: text,
          wake: wakeWord && wake
            ? {
              ...wake,
              version: WAKE_MATCHER_VERSION,
            }
            : undefined,
        }));

      } catch (err) {
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

  if (req.method === 'POST' && url.pathname === '/sleep') {
    lastConversationAt = 0;
    broadcast({ type: 'sleep' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/tts') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const reqOptions = {
        hostname: 'localhost',
        port: 3001,
        path: '/tts',
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
        if (Object.hasOwn(config, 'kokoroVoice')) {
          config.kokoroVoice = normalizeKokoroVoice(config.kokoroVoice);
        }

        const nextConfig = { ...runtimeConfig, ...config };
        const shouldRestartStt = nextConfig.sttModel !== runtimeConfig.sttModel;

        if (shouldRestartStt) {
          await restartTranscriptionService(nextConfig.sttModel);
        }

        Object.assign(runtimeConfig, nextConfig);
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
  });
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

module.exports = { handleRequest };
