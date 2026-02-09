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

  // Routes
  if (req.method === 'GET' && url.pathname === '/') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
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

  if (req.method === 'POST' && url.pathname === '/sleep') {
    broadcast({ type: 'sleep' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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

server.listen(PORT, () => {
  console.log(`\n  🤖 TUBS BOT Bridge Server`);
  console.log(`  ─────────────────────────`);
  console.log(`  HTTP:      http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  Health:    http://localhost:${PORT}/health\n`);
});
