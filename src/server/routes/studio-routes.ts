// Studio mode (sentient-studio contract section 6): GET /studio, POST /studio.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '../../shared/contracts/http.js';
import { readJsonBody } from '../http/body.js';
import { sendJson } from '../http/response.js';
import { updateStudio } from '../studio/control.js';
import { studioSettings, toStudioResponse } from '../studio/state.js';
import { listPresets } from '../presets/presets.js';
import { parseVisionSource, type StudioUiLinks } from '../../shared/contracts/studio.js';

const SNAPSHOT_TIMEOUT_MS = 4000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export async function handleStudioRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/studio/snapshot' && request.method === 'GET') {
    await sendSnapshot(response);
    return true;
  }
  if (url.pathname !== '/studio') return false;
  if (request.method === 'GET') {
    sendJson(response, 200, { ...toStudioResponse(), ui: uiLinks(request), presets: presetNames() });
    return true;
  }
  if (request.method !== 'POST') return false;
  try {
    sendJson(response, 200, { ...await updateStudio(await readJsonBody<unknown>(request)), ui: uiLinks(request), presets: presetNames() });
  } catch (error) {
    const badRequest = error instanceof SyntaxError || (error instanceof Error && error.name === 'BadRequestError');
    sendJson(response, badRequest ? 400 : 500, { error: error instanceof Error ? error.message : String(error) } satisfies ErrorResponse);
  }
  return true;
}

function presetNames(): { names: string[]; active: string | null } {
  const { presets, active } = listPresets();
  return { names: presets.map((preset) => preset.name), active };
}

/** The dashboard and memory view, as the caller reaches this server (the sentient panel links to them). */
function uiLinks(request: IncomingMessage): StudioUiLinks {
  const base = `http://${request.headers.host ?? `localhost:${process.env.PORT ?? '3000'}`}`;
  return { dashboard: `${base}/?view=dashboard`, memory: `${base}/?view=memory` };
}

/**
 * visionSource=snapshot:<url>: one JPEG from the camera's snapshot URL (e.g.
 * depthcam-studio's /api/snapshot/color.jpg), fetched when the face page takes
 * a picture. Same origin for the page, so the camera needs no CORS.
 */
async function sendSnapshot(response: ServerResponse): Promise<void> {
  const source = parseVisionSource(studioSettings.visionSource);
  if (!studioSettings.enabled || source?.kind !== 'snapshot') {
    sendJson(response, 404, { error: 'visionSource is not a snapshot URL' } satisfies ErrorResponse);
    return;
  }
  try {
    const upstream = await fetch(source.url, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
    if (!upstream.ok) throw new Error(`${source.url} answered ${upstream.status}`);
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > MAX_SNAPSHOT_BYTES) throw new Error('snapshot too large');
    response.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) } satisfies ErrorResponse);
  }
}
