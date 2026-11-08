// The dashboard's relationships list: GET /relationships, POST /relationships [entries].

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '../../shared/contracts/http.js';
import { readJsonBody } from '../http/body.js';
import { sendJson } from '../http/response.js';
import { loadRelationships, saveRelationships } from '../assistant/relationships.js';

export async function handleRelationshipRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/relationships') return false;
  if (request.method === 'GET') {
    sendJson(response, 200, { relationships: loadRelationships() });
    return true;
  }
  if (request.method !== 'POST') return false;
  try {
    const body = await readJsonBody<{ relationships?: unknown }>(request);
    sendJson(response, 200, { relationships: saveRelationships(body.relationships) });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) } satisfies ErrorResponse);
  }
  return true;
}
