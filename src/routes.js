const http = require('http');
const fs = require('fs');
const path = require('path');
const { runtimeConfig, sessionStats, normalizeSttModel } = require('./config');
const { broadcast, getClients } = require('./websocket');
const { detectWakeWord, WAKE_MATCHER_VERSION } = require('./wake-word');
const { transcribeAudio, restartTranscriptionService } = require('./python-service');
const { readFaceLib, writeFaceLib } = require('./face-library');
const { generateDemoResponse } = require('./demo-response');

const staticPath = path.join(__dirname, '../public');

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

        broadcast({ type: 'incoming', text: text });
        sessionStats.messagesIn++;

        const responseText = generateDemoResponse(text);

        setTimeout(() => {
          broadcast({ type: 'speak', text: responseText, ts: Date.now() });

          sessionStats.messagesOut++;
          const tokensIn = text.split(' ').length;
          const tokensOut = responseText.split(' ').length;

          broadcast({
            type: 'stats',
            tokens: { in: tokensIn, out: tokensOut },
            latency: 100,
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

  // Static files
  let filePath = url.pathname === '/' ? 'index.html' : url.pathname;
  const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const ext = path.extname(safePath);

  if (!ext || url.pathname === '/') {
    filePath = 'index.html';
  }

  const fullPath = path.join(staticPath, filePath);

  if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isFile()) {
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
}

module.exports = { handleRequest };
