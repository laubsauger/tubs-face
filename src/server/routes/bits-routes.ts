// The Mind tab's running bits: GET /bits (each bit's uses tonight, cooldown,
// on/off, and what the next turn is told to stay off), POST /bits {id, enabled}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BitsResponse } from '../../shared/contracts/bits.js';
import type { ErrorResponse } from '../../shared/contracts/http.js';
import { readJsonBody } from '../http/body.js';
import { sendJson } from '../http/response.js';
import { bitsStatus, setBitEnabled } from '../assistant/bits.js';
import { stayOffMotifs } from '../assistant/variety.js';

function bitsResponse(now = Date.now()): BitsResponse {
  return { now, bits: bitsStatus(now), stayOff: stayOffMotifs(now) };
}

export async function handleBitsRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/bits') return false;
  if (request.method === 'GET') {
    sendJson(response, 200, bitsResponse());
    return true;
  }
  if (request.method !== 'POST') return false;
  try {
    const { id, enabled } = await readJsonBody<{ id?: unknown; enabled?: unknown }>(request);
    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
      sendJson(response, 400, { error: 'Send {id, enabled}' } satisfies ErrorResponse);
    } else if (!setBitEnabled(id, enabled)) {
      sendJson(response, 404, { error: `No bit called ${id}` } satisfies ErrorResponse);
    } else {
      sendJson(response, 200, bitsResponse());
    }
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) } satisfies ErrorResponse);
  }
  return true;
}
