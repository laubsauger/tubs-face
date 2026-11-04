import type { IncomingMessage, ServerResponse } from 'node:http';
import { applyCors, sendNoContent } from '../http/response.js';
import { handleFaceRoute } from './face-routes.js';
import { handleRecordingRoute } from './recording-routes.js';
import { handleSystemRoute } from './system-routes.js';
import { handleTurnRoute } from './turn-routes.js';

// HTTP API entry: CORS, then each route group gets a look at the request.

export async function handleApiRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  // The Host header is client input; a malformed one made this throw.
  const url = new URL(request.url ?? '/', 'http://localhost');
  applyCors(response);

  if (request.method === 'OPTIONS') {
    sendNoContent(response);
    return true;
  }

  return await handleSystemRoute(request, response, url)
    || await handleTurnRoute(request, response, url)
    || await handleFaceRoute(request, response, url)
    || await handleRecordingRoute(request, response, url);
}
