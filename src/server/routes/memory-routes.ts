// The memory view's data and admin actions (shared/contracts/memory.ts).
// Local network only. Reads are GET; every change is a POST from the
// dashboard's own origin (a JSON body, which needs a CORS preflight that these
// routes never grant), so another site open in the operator's browser cannot
// change anything, and no link can.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '../../shared/contracts/http.js';
import type { MemoryForgetRequest, MemoryLibraryRemoveRequest, MemoryResponse } from '../../shared/contracts/memory.js';
import { readJsonBody } from '../http/body.js';
import { applyCors, sendJson } from '../http/response.js';
import { clearTonight, forgetPeople, tonightsPeople } from '../assistant/field-notes.js';
import { loadRelationships } from '../assistant/relationships.js';
import { runtimeConfig } from '../config/runtime.js';
import { deleteFacesByName, readFaceLibrary } from '../faces/library.js';
import { buildMemory, isLocalNetworkAddress } from '../memory/view.js';
import { broadcast } from '../ws/server.js';

export function currentMemory(now = Date.now()): MemoryResponse {
  return buildMemory({
    ...tonightsPeople(now),
    faces: readFaceLibrary().faces,
    relationships: loadRelationships(),
    relationshipsEnabled: runtimeConfig.relationshipsEnabled,
  });
}

/** Same origin, or not a browser at all (curl on the venue network). */
function fromThisOrigin(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function sendImage(response: ServerResponse, dataUrl: string | null | undefined): void {
  const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(dataUrl ?? '');
  if (!match) {
    sendJson(response, 404, { error: 'No photo' } satisfies ErrorResponse);
    return;
  }
  // Not cached: a photo removed for privacy must not linger in a browser.
  response.writeHead(200, { 'Content-Type': match[1]!, 'Cache-Control': 'no-store' });
  response.end(Buffer.from(match[2]!, 'base64'));
}

export async function handleMemoryRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/memory' && !path.startsWith('/memory/')) return false;
  if (!isLocalNetworkAddress(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: 'The memory view is for the local network only' } satisfies ErrorResponse);
    return true;
  }

  if (request.method === 'GET') {
    if (path === '/memory') {
      // The counts and names may be read by the sentient panel from its own origin.
      applyCors(response);
      sendJson(response, 200, currentMemory());
      return true;
    }
    const photo = /^\/memory\/photo\/([^/]+)$/.exec(path);
    if (photo) {
      const id = decodeURIComponent(photo[1]!);
      sendImage(response, readFaceLibrary().faces.find((face) => face.id === id)?.thumbnail);
      return true;
    }
    const snapshot = /^\/memory\/snapshot\/([^/]+)$/.exec(path);
    if (snapshot) {
      const id = decodeURIComponent(snapshot[1]!);
      sendImage(response, tonightsPeople().people.find((person) => person.id === id)?.thumbnail);
      return true;
    }
    sendJson(response, 404, { error: 'Not found' } satisfies ErrorResponse);
    return true;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Changes are POST requests from the dashboard' } satisfies ErrorResponse);
    return true;
  }
  if (!fromThisOrigin(request)) {
    sendJson(response, 403, { error: 'Changes come from the dashboard only' } satisfies ErrorResponse);
    return true;
  }
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    sendJson(response, 415, { error: 'Send JSON' } satisfies ErrorResponse);
    return true;
  }

  try {
    if (path === '/memory/forget') {
      const { key } = await readJsonBody<Partial<MemoryForgetRequest>>(request);
      const ids = idsFor(typeof key === 'string' ? key : '');
      if (ids.length === 0) {
        sendJson(response, 404, { error: 'Nobody by that key tonight' } satisfies ErrorResponse);
        return true;
      }
      sendJson(response, 200, { ok: true, forgotten: forgetPeople(ids) });
      return true;
    }
    if (path === '/memory/library/remove') {
      const { name } = await readJsonBody<Partial<MemoryLibraryRemoveRequest>>(request);
      const removed = typeof name === 'string' && name.trim() ? deleteFacesByName(name) : 0;
      if (removed === 0) {
        sendJson(response, 404, { error: 'No face library samples by that name' } satisfies ErrorResponse);
        return true;
      }
      console.log(`[memory] removed ${removed} face library sample(s) of ${name}`);
      // The face pages match visitors against their own copy: they reload it.
      broadcast({ type: 'faces_changed' });
      sendJson(response, 200, { ok: true, removed });
      return true;
    }
    if (path === '/memory/clear') {
      clearTonight();
      sendJson(response, 200, { ok: true });
      return true;
    }
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) } satisfies ErrorResponse);
    return true;
  }
  sendJson(response, 404, { error: 'Not found' } satisfies ErrorResponse);
  return true;
}

/** The field-notes ids behind a card: everyone noted under that name, or the one visitor. */
function idsFor(key: string): string[] {
  const { people } = tonightsPeople();
  if (key.startsWith('visitor:')) {
    const id = key.slice('visitor:'.length);
    return people.some((person) => person.id === id) ? [id] : [];
  }
  if (key.startsWith('name:')) {
    const name = key.slice('name:'.length).trim().toLowerCase();
    return people.filter((person) => person.names.some((each) => each.trim().toLowerCase() === name)).map((person) => person.id);
  }
  return [];
}
