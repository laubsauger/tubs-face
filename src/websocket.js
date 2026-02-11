const { WebSocketServer } = require('ws');
const { runtimeConfig, sessionStats } = require('./config');
const { generateAssistantReply, generateProactiveReply, clearAssistantContext } = require('./assistant-service');
const { logConversation } = require('./logger');

let clients = new Set();
let lastPresenceContextClearAt = 0;
let pendingPresenceContextClear = null;
const PRESENCE_CONTEXT_CLEAR_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.PRESENCE_CONTEXT_CLEAR_DELAY_MS || '60000', 10) || 60000
);
const PRESENCE_CONTEXT_CLEAR_COOLDOWN_MS = Math.max(
  0,
  Number.parseInt(process.env.PRESENCE_CONTEXT_CLEAR_COOLDOWN_MS || '15000', 10) || 15000
);

function cancelPresenceContextClear() {
  if (pendingPresenceContextClear) {
    clearTimeout(pendingPresenceContextClear);
    pendingPresenceContextClear = null;
  }
}

function schedulePresenceContextClear() {
  if (pendingPresenceContextClear) return;

  pendingPresenceContextClear = setTimeout(() => {
    pendingPresenceContextClear = null;
    const now = Date.now();
    if (now - lastPresenceContextClearAt >= PRESENCE_CONTEXT_CLEAR_COOLDOWN_MS) {
      lastPresenceContextClearAt = now;
      clearAssistantContext('presence_lost_delayed');
    }
  }, PRESENCE_CONTEXT_CLEAR_DELAY_MS);
}

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

        if (msg.type === 'presence') {
          if (msg.present === true) {
            cancelPresenceContextClear();
            return;
          }

          if (msg.present === false) {
            schedulePresenceContextClear();
          }
          return;
        }

        if (msg.type === 'proactive') {
          void (async () => {
            try {
              const reply = await generateProactiveReply(msg.context || 'Someone is nearby');
              if (!reply) return;

              sessionStats.tokensIn += reply.tokens.in || 0;
              sessionStats.tokensOut += reply.tokens.out || 0;
              sessionStats.costUsd += reply.costUsd || 0;
              sessionStats.messagesOut++;
              sessionStats.lastActivity = Date.now();
              if (reply.model) sessionStats.model = reply.model;

              broadcast({
                type: 'speak',
                text: reply.text,
                donation: reply.donation,
                emotion: reply.emotion || null,
                ts: Date.now(),
              });
              logConversation('TUBS (proactive)', reply.text);
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
            } catch (err) {
              console.error('[WS] Proactive generation failed:', err);
            }
          })();
          return;
        }

        if (msg.type === 'incoming') {
          sessionStats.messagesIn++;
          sessionStats.lastActivity = Date.now();

          broadcast({ type: 'incoming', text: msg.text });
          logConversation('USER', msg.text);
          broadcast({ type: 'thinking' });

          void (async () => {
            try {
              const reply = await generateAssistantReply(msg.text);

              sessionStats.tokensIn += reply.tokens.in || 0;
              sessionStats.tokensOut += reply.tokens.out || 0;
              sessionStats.costUsd += reply.costUsd || 0;
              sessionStats.messagesOut++;
              sessionStats.lastActivity = Date.now();
              if (reply.model) {
                sessionStats.model = reply.model;
              }

              broadcast({
                type: 'speak',
                text: reply.text,
                donation: reply.donation,
                emotion: reply.emotion || null,
                ts: Date.now(),
              });
              logConversation('TUBS', reply.text);
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
            } catch (err) {
              console.error('[WS] Assistant generation failed:', err);
              broadcast({ type: 'error', text: 'Response generation failed' });
            }
          })();
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
    } else if (client.readyState > 1) {
      clients.delete(client);
    }
  }
}

function getClients() {
  return clients;
}

module.exports = { initWebSocket, broadcast, getClients };
