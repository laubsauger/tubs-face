const { WebSocketServer } = require('ws');
const { runtimeConfig, sessionStats } = require('./config');
const { generateDemoResponse } = require('./demo-response');

let clients = new Set();

function initWebSocket(server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)`);

    ws.send(JSON.stringify({ type: 'config', ...runtimeConfig }));
    ws.send(JSON.stringify({ type: 'system', text: 'Connected to Tubs Bridge Server' }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'ping', ts: msg.ts, serverTs: Date.now() }));
          return;
        }

        if (msg.type === 'incoming') {
          sessionStats.messagesIn++;
          sessionStats.lastActivity = Date.now();

          const startTime = Date.now();
          const responseText = generateDemoResponse(msg.text);
          const latency = Date.now() - startTime;

          broadcast({ type: 'thinking' });

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

  return wss;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

function getClients() {
  return clients;
}

module.exports = { initWebSocket, broadcast, getClients };
