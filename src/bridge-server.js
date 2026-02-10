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
const { handleRequest } = require('./routes');
const { initWebSocket } = require('./websocket');
const { startTranscriptionService, stopTranscriptionService } = require('./python-service');
const { runtimeConfig } = require('./config');

const PORT = process.env.PORT || 3000;

const server = http.createServer(handleRequest);

initWebSocket(server);

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
