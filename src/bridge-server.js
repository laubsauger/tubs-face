/**
 * TUBS BOT — Bridge Server
 * Node.js WebSocket relay between the face UI and any LLM backend.
 * 
 * Usage:
 *   node bridge-server.js
 * 
 * Endpoints:
 *   GET  /          — Serve face UI (index.html)
 *   GET  /health    — Health check + connected client count
 *   POST /speak     — Send speech to face: { text }
 *   POST /sleep     — Trigger sleep mode
 *   POST /wake      — Trigger wake mode
 *   GET  /stats     — Return current session stats
 *   GET  /config    — Get runtime config
 *   POST /config    — Update runtime config: { sleepTimeout, model, prompt, sttModel }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const DEFAULT_STT_MODEL = process.env.WHISPER_MODEL || 'small';

// Runtime state
let clients = new Set();
let sessionStats = {
  messagesIn: 0,
  messagesOut: 0,
  tokensIn: 0,
  tokensOut: 0,
  uptime: Date.now(),
  lastActivity: null,
  model: 'Tubs Bot v1',
};
let runtimeConfig = {
  sleepTimeout: 10000, // 10 seconds
  model: 'Tubs Bot v1',
  prompt: 'Default personality',
  sttModel: DEFAULT_STT_MODEL,
};

const WAKE_PREFIXES = new Set(['hey', 'hi', 'yo', 'okay', 'ok', 'oi', 'ey', 'ay']);
const WAKE_NOISE_PREFIXES = new Set(['a', 'at', 'ah', 'uh', 'oh', 'um', 'hm', 'hmm']);
const WAKE_MATCHER_VERSION = '2026-02-10.3';
const WAKE_ALIASES = new Set([
  'tubs',
  'tub',
  'tubbs',
  'top',
  'tops',
  'tab',
  'tap',
  'tup',
  'tob',
  'toob',
  'dub',
  'dubs',
  'tobbs',
  'etab',
  'hotops',
]);
const WAKE_GLUE_PREFIXES = ['h', 'ho', 'hey', 'e', 'eh', 'a', 'at', 'yo', 'ok', 'okay'];

function normalizeSttModel(model) {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) {
    const err = new Error('sttModel must be a non-empty string');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    const err = new Error('sttModel contains invalid characters');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return normalized;
}

function normalizeWakeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

function isWakeAlias(token) {
  if (!token || token.length < 3 || token.length > 8) return false;
  const candidates = new Set([token, token.replace(/(.)\1+/g, '$1')]);

  for (const prefix of WAKE_GLUE_PREFIXES) {
    if (token.startsWith(prefix) && token.length > prefix.length + 2) {
      const stripped = token.slice(prefix.length);
      candidates.add(stripped);
      candidates.add(stripped.replace(/(.)\1+/g, '$1'));
    }
  }

  for (const candidate of candidates) {
    if (WAKE_ALIASES.has(candidate)) return true;
    if (candidate.length < 3 || candidate.length > 6) continue;

    // Whisper often misses one phoneme; tolerate small edit distances.
    if (levenshteinDistance(candidate, 'tubs') <= 1) return true;
    if (levenshteinDistance(candidate, 'tub') <= 1) return true;
    if (/^[td]/.test(candidate) && candidate.length >= 4 && levenshteinDistance(candidate, 'tubs') <= 2) {
      return true;
    }
  }

  return false;
}

function findWakeToken(tokens) {
  const directIndex = tokens.findIndex(isWakeAlias);
  if (directIndex !== -1) {
    return { index: directIndex, token: tokens[directIndex], source: 'token' };
  }

  // For very short utterances, Whisper sometimes splits one name into fragments.
  if (tokens.length <= 3) {
    const compact = tokens.join('');
    if (isWakeAlias(compact)) {
      return { index: 0, token: compact, source: 'compact' };
    }

    for (let i = 0; i < tokens.length - 1; i++) {
      const merged = `${tokens[i]}${tokens[i + 1]}`;
      if (isWakeAlias(merged)) {
        return { index: i, token: merged, source: 'merged' };
      }
    }
  }

  return { index: -1, token: null, source: null };
}

function detectWakeWord(text) {
  const normalized = normalizeWakeText(text);
  if (!normalized) {
    return {
      detected: false,
      reason: 'empty',
      normalized,
      tokens: [],
      matchedToken: null,
      matchedSource: null,
    };
  }

  const tokens = normalized.split(' ');
  const wakeMatch = findWakeToken(tokens);
  const wakeIndex = wakeMatch.index;
  const prefixIndex = tokens.findIndex(token => WAKE_PREFIXES.has(token));

  const hasWakeToken = wakeIndex !== -1;
  const greetingNearWake = prefixIndex !== -1 && prefixIndex <= 1 && wakeIndex <= prefixIndex + 2;
  const greetingWithTrailingWake = hasWakeToken && prefixIndex === 0 && wakeIndex === tokens.length - 1 && tokens.length <= 8;
  const wakeFirst = wakeIndex === 0 && tokens.length <= 6;
  const standaloneWake = hasWakeToken && (
    tokens.length === 1 ||
    (tokens.length === 2 && (
      wakeIndex === 0 ||
      WAKE_PREFIXES.has(tokens[0]) ||
      WAKE_NOISE_PREFIXES.has(tokens[0])
    ))
  );

  const detected = hasWakeToken && (greetingNearWake || greetingWithTrailingWake || wakeFirst || standaloneWake);
  const reason = !hasWakeToken
    ? 'no_wake_token'
    : greetingNearWake
      ? 'greeting_near_wake'
      : greetingWithTrailingWake
        ? 'greeting_with_trailing_wake'
      : wakeFirst
        ? 'wake_first'
        : standaloneWake
          ? 'standalone_wake'
          : 'wake_token_not_addressed';

  return {
    detected,
    reason,
    normalized,
    tokens,
    matchedToken: hasWakeToken ? wakeMatch.token : null,
    matchedSource: wakeMatch.source,
  };
}

let pythonProcess = null;
const pythonPath = path.join(__dirname, '../venv/bin/python');

function startTranscriptionService(modelName = runtimeConfig.sttModel) {
  const resolvedModel = normalizeSttModel(modelName);
  runtimeConfig.sttModel = resolvedModel;
  console.log(`[Bridge] Spawning Python service (Whisper=${resolvedModel})...`);

  const proc = spawn(
    pythonPath,
    ['-u', path.join(__dirname, 'transcription-service.py')],
    {
      env: {
        ...process.env,
        WHISPER_MODEL: resolvedModel,
      },
    }
  );
  pythonProcess = proc;

  proc.stdout.on('data', (data) => {
    console.log(`[Python] ${data.toString().trim()}`);
  });

  proc.stderr.on('data', (data) => {
    console.error(`[Python Err] ${data.toString().trim()}`);
  });

  proc.on('error', (err) => {
    console.error('[Python] Failed to spawn process:', err);
  });

  proc.on('close', (code) => {
    if (pythonProcess === proc) {
      pythonProcess = null;
    }
    console.log(`[Python] Exited with code ${code}`);
  });
}

function stopTranscriptionService(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!pythonProcess) {
      resolve(false);
      return;
    }

    const proc = pythonProcess;
    let done = false;
    const finish = (didStop) => {
      if (done) return;
      done = true;
      resolve(didStop);
    };

    proc.once('close', () => {
      if (pythonProcess === proc) {
        pythonProcess = null;
      }
      finish(true);
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      finish(false);
      return;
    }

    setTimeout(() => {
      if (done) return;
      try {
        proc.kill('SIGKILL');
      } catch {
        // no-op
      }
    }, timeoutMs);

    setTimeout(() => finish(false), timeoutMs + 500);
  });
}

async function restartTranscriptionService(modelName, reason = 'runtime config update') {
  const resolvedModel = normalizeSttModel(modelName);
  console.log(`[Bridge] Restarting transcription service (${reason}) with Whisper=${resolvedModel}...`);
  await stopTranscriptionService();
  if (pythonProcess) {
    const err = new Error('Failed to stop existing transcription service process');
    err.code = 'STT_RESTART_FAILED';
    throw err;
  }
  startTranscriptionService(resolvedModel);
}

// ── Face Library helpers ──
const faceLibPath = path.join(__dirname, '../data/face-library.json');

function readFaceLib() {
  try {
    if (fs.existsSync(faceLibPath)) {
      return JSON.parse(fs.readFileSync(faceLibPath, 'utf-8'));
    }
  } catch (e) {
    console.error('[Faces] Error reading face library:', e.message);
  }
  return { faces: [] };
}

function writeFaceLib(data) {
  fs.mkdirSync(path.dirname(faceLibPath), { recursive: true });
  fs.writeFileSync(faceLibPath, JSON.stringify(data, null, 2));
}

// HTTP Server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }



  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: clients.size,
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
    // Check query params for mode
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

        // Wake word check
        if (wakeWord) {
          wake = detectWakeWord(text);
          console.log(
            `[WakeWord:${WAKE_MATCHER_VERSION}] detected=${wake.detected} reason=${wake.reason} source=${wake.matchedSource || ''} normalized="${wake.normalized}" matched="${wake.matchedToken || ''}"`
          );
          if (!wake.detected) {
            console.log('[Voice] Wake word not detected, ignoring.');
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
        }

        // Broadcast the transcription
        broadcast({ type: 'incoming', text: text });
        sessionStats.messagesIn++;

        // Generate response
        const responseText = generateDemoResponse(text);

        // Simulate LLM delay
        setTimeout(() => {
          broadcast({ type: 'speak', text: responseText, ts: Date.now() });

          sessionStats.messagesOut++;
          // Token est.
          const tokensIn = text.split(' ').length;
          const tokensOut = responseText.split(' ').length;

          broadcast({
            type: 'stats',
            tokens: { in: tokensIn, out: tokensOut },
            latency: 100, // Fake latency for now
            model: runtimeConfig.model,
            cost: 0.00,
          });
        }, 500);

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

  // ── Face Library CRUD ──
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
        const { name, embedding } = JSON.parse(body);
        if (!name || !embedding || !Array.isArray(embedding)) {
          throw new Error('Missing name or embedding array');
        }
        const lib = readFaceLib();
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        lib.faces.push({ id, name, embedding, createdAt: Date.now() });
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

  // Serve static files from ../public
  const staticPath = path.join(__dirname, '../public');
  let filePath = url.pathname === '/' ? 'index.html' : url.pathname;
  // Prevent directory traversal
  const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const ext = path.extname(safePath);

  if (!ext || url.pathname === '/') {
    filePath = 'index.html';
  }

  const fullPath = path.join(staticPath, filePath);

  // Check if file exists in public dir (basic static server)
  if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isFile()) {
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

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end(`Error loading ${safePath}`);
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// WebSocket Server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);

  // Send initial config & stats
  ws.send(JSON.stringify({ type: 'config', ...runtimeConfig }));
  ws.send(JSON.stringify({ type: 'system', text: 'Connected to Tubs Bridge Server' }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Handle ping
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'ping', ts: msg.ts, serverTs: Date.now() }));
        return;
      }

      // Handle incoming user messages
      if (msg.type === 'incoming') {
        sessionStats.messagesIn++;
        sessionStats.lastActivity = Date.now();

        // Echo back as a demo response (replace with real LLM call)
        const startTime = Date.now();
        const responseText = generateDemoResponse(msg.text);
        const latency = Date.now() - startTime;

        // Send thinking state
        broadcast({ type: 'thinking' });

        // Simulate LLM delay then respond
        setTimeout(() => {
          broadcast({
            type: 'speak',
            text: responseText,
            ts: Date.now(),
          });
          broadcast({
            type: 'stats',
            tokens: { in: msg.text.split(' ').length, out: responseText.split(' ').length },
            latency: latency + 500,
            model: runtimeConfig.model,
            cost: 0.00,
          });
          sessionStats.messagesOut++;
        }, 500);
      }
    } catch (e) {
      console.error('[WS] Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (${clients.size} total)`);
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

// Demo response generator (replace with real LLM integration)
function generateDemoResponse(input) {
  const responses = [
    "Hmm, that's interesting. Tell me more!",
    "I'm just a demo bot, but I heard you loud and clear.",
    "Tubs is online and vibing. What else you got?",
    "Cool cool cool. I'm processing that with my massive brain.",
    "Beep boop. That's robot for 'I agree'.",
    "You know what, that's a great point.",
    "I'm nodding enthusiastically. Can you tell?",
    "Filing that under 'important thoughts'. Done.",
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

// Proxy function
function transcribeAudio(audioBuffer) {
  return new Promise((resolve, reject) => {
    // Manually construct multipart body because we don't have form-data pkg
    const boundary = '---BOUNDARY';

    const tryRequest = (retries = 10) => {
      const req = http.request({
        hostname: 'localhost',
        port: 3001,
        path: '/transcribe',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error('Invalid JSON from transcription service'));
            }
          } else {
            reject(new Error(`Transcription failed: ${body}`));
          }
        });
      });

      req.on('error', (err) => {
        if (retries > 0 && err.code === 'ECONNREFUSED') {
          console.log(`[Bridge] Transcription service busy/loading, retrying... (${retries})`);
          setTimeout(() => tryRequest(retries - 1), 2000);
        } else {
          reject(err);
        }
      });

      req.write(`--${boundary}\r\n`);
      req.write(`Content-Disposition: form-data; name="audio"; filename="audio.webm"\r\n`);
      req.write(`Content-Type: audio/webm\r\n\r\n`);
      req.write(audioBuffer);
      req.write(`\r\n--${boundary}--\r\n`);
      req.end();
    };

    tryRequest();
  });
}

startTranscriptionService(runtimeConfig.sttModel);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopTranscriptionService(2000).finally(() => process.exit(0));
  });
}

server.listen(PORT, () => {
  console.log(`\n  🤖 TUBS BOT Bridge Server`);
  console.log(`  ─────────────────────────`);
  console.log(`  HTTP:      http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  Health:    http://localhost:${PORT}/health\n`);
});
