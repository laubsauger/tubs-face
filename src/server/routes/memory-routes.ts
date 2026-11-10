// The memory view's data and admin actions (shared/contracts/memory.ts).
// Local network only. Reads are GET; every change is a POST from the
// dashboard's own origin (a JSON body, which needs a CORS preflight that these
// routes never grant), so another site open in the operator's browser cannot
// change anything, and no link can.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '../../shared/contracts/http.js';
import type {
  MemoryForgetRequest,
  MemoryLibraryChangeResponse,
  MemoryLibraryRemoveRequest,
  MemoryLibraryUndoRequest,
  MemoryResponse,
  MemorySamplesMoveRequest,
  MemorySamplesRemoveRequest,
} from '../../shared/contracts/memory.js';
import { readJsonBody } from '../http/body.js';
import { applyCors, sendJson } from '../http/response.js';
import { clearTonight, forgetPeople, tonightsPeople } from '../assistant/field-notes.js';
import { loadRelationships } from '../assistant/relationships.js';
import { runtimeConfig } from '../config/runtime.js';
import { backupDiff, listBackups, moveFaces, readFaceLibrary, removeFaces, removePerson, restoreBackup, undoLibraryChange } from '../faces/library.js';
import { currentAudit, UNLIKE_OWN_BELOW } from '../faces/audit.js';
import { MATCH_THRESHOLD } from '../../client/face/matching.js';
import { originOf } from './face-routes.js';
import { buildMemory, isLocalNetworkAddress } from '../memory/view.js';
import { broadcast } from '../ws/server.js';
import { fromThisOrigin } from './route-helpers.js';

export function currentMemory(now = Date.now()): MemoryResponse {
  return buildMemory({
    ...tonightsPeople(now),
    faces: readFaceLibrary().faces,
    audit: new Map(currentAudit().map((sample) => [sample.id, sample])),
    relationships: loadRelationships(),
    relationshipsEnabled: runtimeConfig.relationshipsEnabled,
  });
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
    if (path === '/memory/library/audit') {
      // Similarities and names only: the embeddings stay on the server.
      sendJson(response, 200, { threshold: MATCH_THRESHOLD, unlikeOwnBelow: UNLIKE_OWN_BELOW, samples: currentAudit() });
      return true;
    }
    if (path === '/memory/library/backups') {
      sendJson(response, 200, { backups: listBackups().map((backup) => ({ ...backup, restores: backupDiff(backup.id) })) });
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
      const change = typeof name === 'string' && name.trim() ? removePerson(name, Date.now(), originOf(request, `POST ${path}`)) : null;
      if (!change || change.removed.length === 0) {
        sendJson(response, 404, { error: 'No face library samples by that name' } satisfies ErrorResponse);
        return true;
      }
      libraryChanged();
      const who = change.removed[0]!.name;
      sendJson(response, 200, { ok: true, removed: change.removed.length, summary: `Removed ${who} from the face library (${photos(change.removed.length)}).`, undo: change.undo, until: change.until } satisfies MemoryLibraryChangeResponse);
      return true;
    }
    if (path === '/memory/library/samples/remove') {
      const { ids } = await readJsonBody<Partial<MemorySamplesRemoveRequest>>(request);
      const change = removeFaces(idList(ids), Date.now(), originOf(request, `POST ${path}`));
      if (change.removed.length === 0) {
        sendJson(response, 404, { error: 'None of those samples is in the face library' } satisfies ErrorResponse);
        return true;
      }
      libraryChanged();
      const owners = [...new Set(change.removed.map((face) => face.name))];
      sendJson(response, 200, { ok: true, removed: change.removed.length, summary: `Removed ${photos(change.removed.length)} of ${owners.join(', ')}.`, undo: change.undo, until: change.until } satisfies MemoryLibraryChangeResponse);
      return true;
    }
    if (path === '/memory/library/samples/move') {
      const { ids, to } = await readJsonBody<Partial<MemorySamplesMoveRequest>>(request);
      const person = typeof to === 'string' ? readFaceLibrary().faces.find((face) => face.name.trim().toLowerCase() === to.trim().toLowerCase())?.name : undefined;
      if (!person) {
        sendJson(response, 400, { error: 'Move to someone in the face library' } satisfies ErrorResponse);
        return true;
      }
      const change = moveFaces(idList(ids), person, Date.now(), originOf(request, `POST ${path}`));
      if (change.moved.length === 0) {
        sendJson(response, 404, { error: 'None of those samples can move there' } satisfies ErrorResponse);
        return true;
      }
      libraryChanged();
      const owners = [...new Set(change.moved.map((entry) => entry.from))];
      sendJson(response, 200, { ok: true, moved: change.moved.length, summary: `Moved ${photos(change.moved.length)} from ${owners.join(', ')} to ${change.to}.`, undo: change.undo, until: change.until } satisfies MemoryLibraryChangeResponse);
      return true;
    }
    if (path === '/memory/library/undo') {
      const { undo } = await readJsonBody<Partial<MemoryLibraryUndoRequest>>(request);
      if (!undoLibraryChange(typeof undo === 'string' ? undo : '', Date.now(), originOf(request, `POST ${path}`))) {
        sendJson(response, 409, { error: 'Too late to undo (a minute), or something changed since: restore a backup instead' } satisfies ErrorResponse);
        return true;
      }
      libraryChanged();
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (path === '/memory/library/restore') {
      const { backup } = await readJsonBody<{ backup?: unknown }>(request);
      if (typeof backup !== 'string' || !restoreBackup(backup, originOf(request, `POST ${path}`))) {
        sendJson(response, 404, { error: 'No such backup' } satisfies ErrorResponse);
        return true;
      }
      libraryChanged();
      sendJson(response, 200, { ok: true });
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

/** Every page matching faces reloads the library (and drops names settled against the old one). */
function libraryChanged(): void {
  broadcast({ type: 'faces_changed' });
}

const MAX_IDS = 500;
function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64).slice(0, MAX_IDS) : [];
}

const photos = (count: number) => `${count} photo${count === 1 ? '' : 's'}`;

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
