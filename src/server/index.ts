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
import { startStudio, stopStudio } from './studio/control.js';
import { restoreState } from './state-file.js';
import { startFaceService, stopFaceService } from './faces/studio-faces.js';
import { flushTonight, restoreTonight } from './memory/tonight-file.js';

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

// TUBS_STATE_FILE: the studio choices as they were before a restart.
restoreState();
// TUBS_TONIGHT_FILE: tonight's field notes, quotes and who was seen.
restoreTonight();
const wss = initWebSocketServer(server);
void startProcessingStack();
// FACE_SERVICE: recognition on the server (docs/face-service.md); after restoreState, for the vision source.
startFaceService();
void prepareFillersAtStartup(runtimeConfig.kokoroVoice ?? 'af_heart');

server.listen(port, () => {
  console.log(`[tubs-face] TS server listening on http://localhost:${port}`);
  // After listen: the face pages connect back to this server.
  void startStudio().catch((error: unknown) => console.error('[studio] could not start', error));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    flushTonight();
    void Promise.allSettled([stopProcessingStack(), shutdownLangfuse(), stopStudio(), stopFaceService()]).finally(() => {
      server.close(() => {
        process.exit(0);
      });
      // Open sockets (the director, face pages, a dashboard) would keep this
      // process alive after it stopped listening, talking to a server that is
      // gone while a new one has the port: close them so they reconnect.
      for (const client of wss.clients) client.close(1001, 'server restarting');
      server.closeAllConnections();
      setTimeout(() => process.exit(0), 3000).unref();
    });
  });
}
