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
 *   POST /config    — Update runtime config: { sleepTimeout, model, prompt }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

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
  sleepTimeout: 300000, // 5 minutes
  model: 'Tubs Bot v1',
  prompt: 'Default personality',
};

// HTTP Server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

        // Wake word check
        if (wakeWord) {
          const trigger = text.toLowerCase();
          if (!trigger.includes("hey tubs") &&
            !trigger.includes("hey tabs") &&
            !trigger.includes("hey tub") &&
            !trigger.includes("okay dub") &&
            !trigger.includes("okay das") &&
            !trigger.includes("okay dabs") &&
            !trigger.includes("hi tubs") &&
            !trigger.includes("yo tubs") &&
            !trigger.includes("yo tobs") &&
            !trigger.includes("okay tops") &&
            !trigger.includes("okay top") &&
            !trigger.includes("hey top") &&
            !trigger.includes("yo top") &&
            !trigger.includes("yo tab") &&
            !trigger.includes("yo tub") &&
            !trigger.includes("okay tubs") &&
            !trigger.includes("tubs") &&
            !trigger.includes("tabs") &&
            !trigger.includes("toobs") &&
            !trigger.includes("tap") &&
            !trigger.includes("tup") &&
            !trigger.includes("ey tab") &&
            !trigger.includes("ey tub") &&
            !trigger.includes("ey toobs")) {
            console.log('[Voice] Wake word not detected, ignoring.');
            broadcast({ type: 'expression', expression: 'idle' });
            // Maybe send a "ignored" signal or just nothing
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ignored: true, text: text }));
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
        res.end(JSON.stringify({ ok: true, text: text }));

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

  if (req.method === 'POST' && url.pathname === '/config') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const config = JSON.parse(body);
        Object.assign(runtimeConfig, config);
        broadcast({ type: 'config', ...runtimeConfig });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config: runtimeConfig }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
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
      '.wasm': 'application/wasm'
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

// ── Python Transcription Service ──
const { spawn } = require('child_process');

console.log('[Bridge] Spawning Python service...');
// Use venv python for self-contained environment
const pythonPath = path.join(__dirname, '../venv/bin/python');
const pythonProcess = spawn(pythonPath, [
  '-u', // Unbuffered output
  path.join(__dirname, 'transcription-service.py')
]);

pythonProcess.stdout.on('data', (data) => {
  console.log(`[Python] ${data.toString().trim()}`);
});

pythonProcess.stderr.on('data', (data) => {
  console.error(`[Python Err] ${data.toString().trim()}`);
});

pythonProcess.on('error', (err) => {
  console.error('[Python] Failed to spawn process:', err);
});

pythonProcess.on('close', (code) => {
  console.log(`[Python] Exited with code ${code}`);
});

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


server.listen(PORT, () => {
  console.log(`\n  🤖 TUBS BOT Bridge Server`);
  console.log(`  ─────────────────────────`);
  console.log(`  HTTP:      http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  Health:    http://localhost:${PORT}/health\n`);
});
