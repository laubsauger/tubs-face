import './env/load.js';
import http from 'node:http';
import { startProcessingStack, stopProcessingStack } from './processing/mode-manager.js';
import { handleApiRequest } from './routes/api.js';
import { sendError } from './http/response.js';
import { initWebSocketServer } from './ws/server.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const server = http.createServer(async (request, response) => {
  const handled = await handleApiRequest(request, response);
  if (handled) {
    return;
  }

  sendError(response, 404, 'Not found');
});

initWebSocketServer(server);
void startProcessingStack();

server.listen(port, () => {
  console.log(`[tubs-face] TS server listening on http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stopProcessingStack().finally(() => {
      server.close(() => {
        process.exit(0);
      });
    });
  });
}
