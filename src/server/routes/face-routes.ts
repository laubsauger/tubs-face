// Face library CRUD and the face-ingest/shape file endpoints.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve, sep } from 'node:path';
import type { ErrorResponse, FaceCreateRequest, FaceCreateResponse, FaceDeleteResponse, FaceLibraryResponse, FaceUpdateRequest, FaceUpdateResponse, IngestDoneRequest, IngestDoneResponse, IngestListResponse } from '../../shared/contracts/http.js';
import { readJsonBody } from '../http/body.js';
import { sendJson } from '../http/response.js';
import { addFace, deleteFace, readFaceLibrary, updateFace } from '../faces/library.js';
import { badRequest } from './route-helpers.js';
import { broadcast } from '../ws/server.js';

/** After the library changes (an onboarding saves several samples), every page reloads its copy once. */
const FACES_CHANGED_DEBOUNCE_MS = 300;
let facesChangedTimer: NodeJS.Timeout | null = null;
function facesChanged(): void {
  if (facesChangedTimer) clearTimeout(facesChangedTimer);
  // The studio listener matches faces against its own copy: a correction made
  // in a dashboard on another machine reaches it only this way.
  facesChangedTimer = setTimeout(() => {
    facesChangedTimer = null;
    broadcast({ type: 'faces_changed' });
  }, FACES_CHANGED_DEBOUNCE_MS);
  facesChangedTimer.unref();
}

const shapesDir = resolve(process.cwd(), 'src/shapes');

const inputFacesDir = resolve(process.cwd(), 'input_faces');

const processedFacesDir = resolve(process.cwd(), 'processed_faces');

export async function handleFaceRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/faces') {
    const library: FaceLibraryResponse = readFaceLibrary();
    sendJson(response, 200, library);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/faces') {
    try {
      const payload = await readJsonBody<FaceCreateRequest & { thumbnail?: string }>(request);
      if (!payload.name?.trim() || !Array.isArray(payload.embedding)) {
        throw badRequest('Missing name or embedding array');
      }
      const face = addFace({
        name: payload.name.trim(),
        embedding: payload.embedding,
        ...(payload.thumbnail ? { thumbnail: payload.thumbnail } : {}),
      });
      facesChanged();
      sendJson(response, 200, {
        ok: true,
        face,
      } satisfies FaceCreateResponse);
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Invalid face payload',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'PATCH' && url.pathname === '/faces') {
    try {
      const payload = await readJsonBody<FaceUpdateRequest>(request);
      if (!payload.id?.trim() || !payload.name?.trim()) {
        throw badRequest('Missing id or name');
      }
      const face = updateFace(payload.id.trim(), {
        name: payload.name.trim(),
      });
      if (!face) {
        sendJson(response, 404, {
          error: 'Face not found',
        } satisfies ErrorResponse);
        return true;
      }
      facesChanged();
      sendJson(response, 200, {
        ok: true,
        face,
      } satisfies FaceUpdateResponse);
    } catch (error) {
      const statusCode = error instanceof Error && error.name === 'BadRequestError' ? 400 : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Invalid face update payload',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'DELETE' && url.pathname === '/faces') {
    const id = url.searchParams.get('id')?.trim();
    if (!id) {
      sendJson(response, 400, { error: 'Missing id parameter' } satisfies ErrorResponse);
      return true;
    }
    const removed = deleteFace(id);
    if (removed) facesChanged();
    sendJson(response, 200, {
      ok: true,
      removed,
    } satisfies FaceDeleteResponse);
    return true;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/shapes/')) {
    const filename = decodeURIComponent(url.pathname.replace('/shapes/', ''));
    if (!/^[a-zA-Z0-9._-]+\.svg$/.test(filename)) {
      sendJson(response, 400, { error: 'Invalid shape filename' } satisfies ErrorResponse);
      return true;
    }

    const fullPath = resolve(shapesDir, filename);
    if (!fullPath.startsWith(shapesDir + sep)) {
      sendJson(response, 403, { error: 'Forbidden' } satisfies ErrorResponse);
      return true;
    }

    try {
      const data = readFileSync(fullPath);
      response.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',
      });
      response.end(data);
    } catch {
      sendJson(response, 404, { error: 'Shape not found' } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/ingest/list') {
    const files: IngestListResponse['files'] = [];
    if (existsSync(inputFacesDir)) {
      for (const entry of readdirSync(inputFacesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const name = entry.name;
        const personDir = resolve(inputFacesDir, name);
        for (const filename of readdirSync(personDir)) {
          if (!/\.(jpg|jpeg|png)$/i.test(filename)) {
            continue;
          }
          const fullPath = resolve(personDir, filename);
          const stats = statSync(fullPath);
          files.push({
            name,
            filename,
            url: `/raw-faces/${encodeURIComponent(name)}/${encodeURIComponent(filename)}`,
            relPath: `${name}/${filename}`,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          });
        }
      }
    }
    sendJson(response, 200, { files } satisfies IngestListResponse);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/ingest/done') {
    try {
      const payload = await readJsonBody<IngestDoneRequest>(request);
      const relPath = payload.relPath?.trim();
      if (!relPath) {
        throw badRequest('Missing relPath');
      }
      const inputPath = resolve(inputFacesDir, relPath);
      const processedPath = resolve(processedFacesDir, relPath);
      if (!inputPath.startsWith(inputFacesDir + sep) || !processedPath.startsWith(processedFacesDir + sep)) {
        sendJson(response, 403, { error: 'Forbidden' } satisfies ErrorResponse);
        return true;
      }
      if (existsSync(inputPath)) {
        ensureDir(resolve(processedPath, '..'));
        renameSync(inputPath, processedPath);
      }
      sendJson(response, 200, {
        ok: true,
        movedTo: processedPath,
      } satisfies IngestDoneResponse);
    } catch (error) {
      const statusCode = error instanceof Error && error.name === 'BadRequestError' ? 400 : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Ingest move failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/raw-faces/')) {
    const relPath = decodeURIComponent(url.pathname.replace('/raw-faces/', ''));
    const fullPath = resolve(inputFacesDir, relPath);
    if (!fullPath.startsWith(inputFacesDir + sep)) {
      sendJson(response, 403, { error: 'Forbidden' } satisfies ErrorResponse);
      return true;
    }
    try {
      const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
      const data = readFileSync(fullPath);
      response.writeHead(200, { 'Content-Type': getMimeType(ext) });
      response.end(data);
    } catch {
      sendJson(response, 404, { error: 'Not found' } satisfies ErrorResponse);
    }
    return true;
  }

  return false;
}

function ensureDir(pathname: string): void {
  mkdirSync(pathname, { recursive: true });
}

function getMimeType(extension: string): string {
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}
