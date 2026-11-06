import './env/load.js';
import http from 'node:http';
import { startProcessingStack, stopProcessingStack } from './processing/speech-service.js';
import { prepareFillersAtStartup } from './assistant/fillers.js';
import { runtimeConfig } from './config/runtime.js';
import { handleApiRequest } from './routes/api.js';
import { sendError } from './http/response.js';
import { serveStatic } from './http/static.js';
import { initWebSocketServer } from './ws/server.js';
import { shutdownLangfuse } from './observability/langfuse.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const server = http.createServer(async (request, response) => {
  // A malformed URL (GET /shapes/%) used to throw here unhandled and take the
  // whole server down; anyone on the studio network could do it.
  try {
    const handled = await handleApiRequest(request, response);
    if (handled) {
      return;
    }

    if (await serveStatic(request, response)) {
      return;
    }

    sendError(response, 404, 'Not found');
  } catch (error) {
    console.error('[http] request failed', request.method, request.url, error);
    if (!response.headersSent) {
      sendError(response, error instanceof URIError ? 400 : 500, error instanceof URIError ? 'Bad request' : 'Internal error');
    } else {
      response.end();
    }
  }
});

initWebSocketServer(server);
void startProcessingStack();
void prepareFillersAtStartup(runtimeConfig.kokoroVoice ?? 'af_heart');

server.listen(port, () => {
  console.log(`[tubs-face] TS server listening on http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.allSettled([stopProcessingStack(), shutdownLangfuse()]).finally(() => {
      server.close(() => {
        process.exit(0);
      });
    });
  });
}
