const { WebSocketServer } = require('ws');
const { runtimeConfig, sessionStats } = require('./config');
const { generateStreamingAssistantReply, generateProactiveReply, clearAssistantContext } = require('./assistant-service');
const crypto = require('crypto');
const { logConversation, logTubsReply } = require('./logger');

let clients = new Set();
let latestFrame = null; // { data: base64String, ts: number }
let appearanceFrame = null; // { data, ts, faces, count } — consumed once on next interaction
let activeWsTurn = null; // { turnId, abortController } — for aborting stale generations
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

        if (msg.type === 'face_motion') {
          const rawX = Number(msg.x);
          const rawY = Number(msg.y);
          if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return;
          const x = Math.max(-1, Math.min(1, rawX));
          const y = Math.max(-1, Math.min(1, rawY));
          broadcast({ type: 'face_motion', x, y, ts: Date.now() });
          return;
        }

        if (msg.type === 'face_blink') {
          broadcast({ type: 'face_blink', ts: Date.now() });
          return;
        }

        if (msg.type === 'head_speech_state') {
          const actor = String(msg.actor || '').toLowerCase() === 'small' ? 'small' : 'main';
          const state = String(msg.state || '').toLowerCase() === 'end' ? 'end' : 'start';
          const turnId = msg.turnId ? String(msg.turnId) : null;
          console.log(`[WS:speech] actor=${actor} state=${state} turn=${turnId || 'n/a'}`);
          broadcast({
            type: 'head_speech_state',
            actor,
            state,
            turnId,
            ts: Date.now(),
          });
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
          if (runtimeConfig.muted === true) {
            broadcast({ type: 'expression', expression: 'idle' });
            return;
          }
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
              logConversation('TUBS:main (proactive)', reply.text);

              // Enter conversation mode so user can respond without wake word
              const { touchConversation } = require('./routes');
              touchConversation();
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

        if (msg.type === 'camera_frame') {
          if (msg.frame && typeof msg.frame === 'string') {
            latestFrame = { data: msg.frame, ts: Date.now() };
          }
          return;
        }

        if (msg.type === 'appearance_frame') {
          if (msg.frame && typeof msg.frame === 'string') {
            appearanceFrame = {
              data: msg.frame,
              ts: Date.now(),
              faces: msg.faces || [],
              count: msg.count || 0,
            };
            console.log(`[WS] Appearance frame stored (faces: ${(msg.faces || []).join(', ') || 'unknown'}, count: ${msg.count || 0})`);
          }
          return;
        }

        if (msg.type === 'incoming') {
          if (runtimeConfig.muted === true) {
            broadcast({ type: 'expression', expression: 'idle' });
            return;
          }
          sessionStats.messagesIn++;
          sessionStats.lastActivity = Date.now();

          // Abort any in-flight generation from previous turn
          if (activeWsTurn) {
            console.log(`[WS] Aborting previous turn ${activeWsTurn.turnId} — new message arrived`);
            activeWsTurn.abortController.abort();
            activeWsTurn = null;
          }

          broadcast({ type: 'incoming', text: msg.text });
          logConversation('USER', msg.text);
          broadcast({ type: 'thinking' });

          const turnId = crypto.randomBytes(6).toString('hex');
          const abortController = new AbortController();
          activeWsTurn = { turnId, abortController };
          broadcast({ type: 'turn_start', turnId });

          void (async () => {
            try {
              const reply = await generateStreamingAssistantReply(msg.text, {
                broadcast,
                turnId,
                abortController,
                frame: msg.frame || getLatestFrame(),
                appearanceFrame: consumeAppearanceFrame(),
              });

              sessionStats.tokensIn += reply.tokens.in || 0;
              sessionStats.tokensOut += reply.tokens.out || 0;
              sessionStats.costUsd += reply.costUsd || 0;
              sessionStats.messagesOut++;
              sessionStats.lastActivity = Date.now();
              if (reply.model) {
                sessionStats.model = reply.model;
              }

              logTubsReply(reply);
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
            } finally {
              if (activeWsTurn && activeWsTurn.turnId === turnId) {
                activeWsTurn = null;
              }
            }
          })();
        }

        if (msg.type === 'interrupt') {
          const { abortActiveTurn } = require('./routes');
          if (msg.turnId) {
            abortActiveTurn(msg.turnId);
          }
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

function abortActiveWsTurn(reason = 'manual') {
  if (!activeWsTurn) return false;
  console.log(`[WS] Aborting active turn ${activeWsTurn.turnId} (${reason})`);
  activeWsTurn.abortController.abort();
  activeWsTurn = null;
  return true;
}

function getLatestFrame(maxAgeMs = 5000) {
  if (!latestFrame) return null;
  if (Date.now() - latestFrame.ts > maxAgeMs) return null;
  return latestFrame.data;
}

/**
 * Returns and clears the appearance frame (one-shot).
 * Only fresh frames (< maxAgeMs) are returned.
 */
function consumeAppearanceFrame(maxAgeMs = 30000) {
  if (!appearanceFrame) return null;
  if (Date.now() - appearanceFrame.ts > maxAgeMs) {
    appearanceFrame = null;
    return null;
  }
  const frame = appearanceFrame;
  appearanceFrame = null;
  return frame;
}

module.exports = {
  initWebSocket,
  broadcast,
  getClients,
  getLatestFrame,
  consumeAppearanceFrame,
  abortActiveWsTurn,
};
