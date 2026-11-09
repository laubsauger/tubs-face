import type { IncomingMessage, ServerResponse } from 'node:http';
import { applyCors, sendNoContent } from '../http/response.js';
import { handleBitsRoute } from './bits-routes.js';
import { handleFaceRoute } from './face-routes.js';
import { handleMemoryRoute } from './memory-routes.js';
import { handlePresetRoute } from './preset-routes.js';
import { handleRecordingRoute } from './recording-routes.js';
import { handleStudioRoute } from './studio-routes.js';
import { handleRelationshipRoute } from './relationship-routes.js';
import { handleSystemRoute } from './system-routes.js';
import { handleTurnRoute } from './turn-routes.js';
import { handleVisionRoute } from './vision-routes.js';

// HTTP API entry: CORS, then each route group gets a look at the request.

export async function handleApiRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  // The Host header is client input; a malformed one made this throw.
  const url = new URL(request.url ?? '/', 'http://localhost');
  // Before the open CORS below: the memory view's changes are same-origin only,
  // and what Tubs sees is for this origin on the local network.
  if (await handleMemoryRoute(request, response, url)) return true;
  if (await handleVisionRoute(request, response, url)) return true;
  applyCors(response);

  if (request.method === 'OPTIONS') {
    sendNoContent(response);
    return true;
  }

  return await handleSystemRoute(request, response, url)
    || await handleTurnRoute(request, response, url)
    || await handleFaceRoute(request, response, url)
    || await handleRecordingRoute(request, response, url)
    || await handleStudioRoute(request, response, url)
    || await handleRelationshipRoute(request, response, url)
    || await handlePresetRoute(request, response, url)
    || await handleBitsRoute(request, response, url);
}
