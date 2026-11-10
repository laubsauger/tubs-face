// Studio mode (sentient-studio contract section 6): GET /studio, POST /studio,
// GET /studio/sources (what the mic and vision source can be set to) and
// GET /studio/pulse (the studio at a glance, studio/pulse.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '../../shared/contracts/http.js';
import { readJsonBody } from '../http/body.js';
import { sendJson } from '../http/response.js';
import { updateStudio } from '../studio/control.js';
import { listStudioSources } from '../studio/sources.js';
import { notePulsePoll } from '../studio/live.js';
import { studioPulse } from '../studio/pulse.js';
import { isLocalNetworkAddress } from '../memory/view.js';
import { broadcast, syncStudioWatch } from '../ws/server.js';
import { poke, reasonOf } from '../studio/poke.js';
import { startProactiveTurn } from '../assistant/turns.js';
import { listenerFaceWorker, studioSettings, toStudioResponse } from '../studio/state.js';
import { libraryPeopleCount } from '../faces/library.js';
import { lastObservation } from '../studio/faces.js';
import { relationshipsInEffect } from '../assistant/relationships.js';
import { listPresets } from '../presets/presets.js';
import { persistState } from '../state-file.js';
import { parseVisionSource, type StudioPart, type StudioResponse, type StudioUiLinks } from '../../shared/contracts/studio.js';
import { studioParts, type RecognitionSource } from '../studio/parts.js';
import { readiness } from './system-routes.js';
import { lastLlmCall } from '../llm/last-call.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { visionService } from '../assistant/vision.js';
import { runtimeConfig } from '../config/runtime.js';
import { MING_PORT, SPEECH_SERVICE_PORT } from '../processing/speech-service.js';
import { faceServiceStatus, recognizer, serviceFaceWorker } from '../faces/studio-faces.js';

const SNAPSHOT_TIMEOUT_MS = 4000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export async function handleStudioRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  // POST /studio/poke {reason?}: a physical cue (the lever) wakes both heads and has them react.
  if (request.method === 'POST' && url.pathname === '/studio/poke') {
    if (!isLocalNetworkAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: 'Poking Tubs is for the local network only' } satisfies ErrorResponse);
      return true;
    }
    const body = await readJsonBody<unknown>(request).catch(() => ({}));
    poke(reasonOf(body), { broadcast, noteAwake: () => visionService.noteSleeping(false), startProactiveTurn });
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/studio/snapshot' && request.method === 'GET') {
    await sendSnapshot(response);
    return true;
  }
  if (url.pathname === '/studio/pulse' && request.method === 'GET') {
    // Who is in view, by name: the local network only (the sentient panel reads it from its origin).
    if (!isLocalNetworkAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: 'The pulse is for the local network only' } satisfies ErrorResponse);
      return true;
    }
    // A poll keeps the listener reporting for a few seconds; nobody polling, it sends nothing.
    notePulsePoll();
    syncStudioWatch();
    sendJson(response, 200, studioPulse());
    return true;
  }
  if (url.pathname === '/studio/sources' && request.method === 'GET') {
    sendJson(response, 200, await listStudioSources());
    return true;
  }
  if (url.pathname !== '/studio') return false;
  if (request.method === 'GET') {
    const studio = toStudioResponse();
    sendJson(response, 200, { ...studio, ui: uiLinks(request), presets: presetNames(), parts: partsOf(studio) });
    return true;
  }
  if (request.method !== 'POST') return false;
  try {
    const updated = await updateStudio(await readJsonBody<unknown>(request));
    persistState();
    sendJson(response, 200, { ...updated, ui: uiLinks(request), presets: presetNames(), parts: partsOf(updated) });
  } catch (error) {
    const badRequest = error instanceof SyntaxError || (error instanceof Error && error.name === 'BadRequestError');
    sendJson(response, badRequest ? 400 : 500, { error: error instanceof Error ? error.message : String(error) } satisfies ErrorResponse);
  }
  return true;
}

/** fleet:vision with no box known yet: ask the hub now and then, never on every poll. */
const FLEET_LOOKUP_EVERY_MS = 30_000;
let lastFleetLookup = 0;

function partsOf(studio: StudioResponse): StudioPart[] {
  if (runtimeConfig.visionProvider === 'openai' && runtimeConfig.visionBaseUrl === 'fleet:vision' && !visionService.fleetBase()
    && Date.now() - lastFleetLookup > FLEET_LOOKUP_EVERY_MS) {
    lastFleetLookup = Date.now();
    void visionService.resolveFleet().catch(() => null);
  }
  return studioParts({
    config: runtimeConfig,
    env: process.env,
    studio,
    health: readiness.peek()?.parts ?? null,
    llm: lastLlmCall(),
    llmReady: resolveLlmProvider().getAuthState().ready,
    vision: visionService.lastCheck(),
    fleetBase: visionService.fleetBase(),
    speechPort: SPEECH_SERVICE_PORT,
    mingUrl: process.env.MING_TTS_URL?.trim() || `http://127.0.0.1:${MING_PORT}`,
    // While the face service recognises, its view stands in for the listener page's worker.
    faceWorker: serviceFaceWorker() ?? listenerFaceWorker(),
    observation: lastObservation(),
    libraryPeople: libraryPeopleCount(),
    relationshipsInEffect: relationshipsInEffect(runtimeConfig.relationshipsEnabled).length,
    recognition: recognitionSource(),
  });
}

function recognitionSource(): RecognitionSource {
  const service = faceServiceStatus();
  return { recognizer: recognizer(), service: service.mode === 'off' ? null : service };
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
