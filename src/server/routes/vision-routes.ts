// What Tubs sees, for the Studio tab:
//   GET  /studio/vision            the last vision check, camera and vision on or off, relationships in effect
//   GET  /vision/servers           servers to pick: Ollama here, the fleet, each fleet vision box by name
//   GET  /vision/models?base=...   the models a server has (thinking variants flagged)
//   POST /vision/test              one picture to a provider, model and server; latency and answer
// Names of people and camera pictures, and requests to other machines: local
// network only, no CORS; the test is a same-origin JSON POST from the dashboard.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '../../shared/contracts/http.js';
import type { StudioVisionResponse } from '../../shared/contracts/studio.js';
import { relationshipsInEffect } from '../assistant/relationships.js';
import { visionService } from '../assistant/vision.js';
import { runtimeConfig } from '../config/runtime.js';
import { readJsonBody } from '../http/body.js';
import { sendJson } from '../http/response.js';
import { isLocalNetworkAddress } from '../memory/view.js';
import { lastLiveStatus } from '../studio/live.js';
import { listenerFaceWorker, studioSettings } from '../studio/state.js';
import { visionModels, visionServers } from '../vision/servers.js';
import { lastObservation } from '../studio/faces.js';
import { fromThisOrigin } from './route-helpers.js';

const MAX_TEST_PICTURE_CHARS = 4 * 1024 * 1024;

const PATHS = new Set(['/studio/vision', '/studio/faces', '/vision/servers', '/vision/models', '/vision/test']);

export async function handleVisionRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!PATHS.has(url.pathname)) return false;
  if (!isLocalNetworkAddress(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: 'Vision settings and what Tubs sees are for the local network only' } satisfies ErrorResponse);
    return true;
  }
  if (url.pathname === '/vision/test') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'POST only' } satisfies ErrorResponse);
      return true;
    }
    if (!fromThisOrigin(request) || !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      sendJson(response, 403, { error: 'Tests come from the dashboard, as JSON' } satisfies ErrorResponse);
      return true;
    }
    await sendTest(request, response);
    return true;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'GET only' } satisfies ErrorResponse);
    return true;
  }
  if (url.pathname === '/studio/faces') {
    // The last face observation (docs/face-service.md), or 404 before the first.
    const last = lastObservation();
    if (last) sendJson(response, 200, last.observation);
    else sendJson(response, 404, { error: 'No face observation yet' } satisfies ErrorResponse);
  } else if (url.pathname === '/studio/vision') {
    sendJson(response, 200, studioVision());
  } else if (url.pathname === '/vision/servers') {
    sendJson(response, 200, await visionServers(fleetHub()));
  } else {
    await sendModels(url.searchParams.get('base') ?? '', response);
  }
  return true;
}

function fleetHub(): string {
  return process.env.FLEET_HUB?.trim() || 'http://127.0.0.1:4310';
}

/** An http(s) base URL without a login in it, or null. */
function httpBase(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return value.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function sendModels(base: string, response: ServerResponse): Promise<void> {
  if (base === 'fleet:vision') {
    // The box the hub picks; a hub that does not answer is an answer too.
    const resolved = await visionService.resolveFleet().catch(() => null);
    if (!resolved) {
      sendJson(response, 200, { base, models: [], error: 'fleet:vision: the hub lists no vision box, or does not answer' });
      return;
    }
    sendJson(response, 200, { ...(await visionModels(resolved)), base });
    return;
  }
  const clean = httpBase(base);
  if (!clean) {
    sendJson(response, 400, { error: 'base must be an http(s) URL (e.g. http://127.0.0.1:11434/v1) or fleet:vision' } satisfies ErrorResponse);
    return;
  }
  sendJson(response, 200, await visionModels(clean));
}

async function sendTest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request);
  } catch {
    sendJson(response, 400, { error: 'Send JSON' } satisfies ErrorResponse);
    return;
  }
  const provider = body.provider === 'gemini' || body.provider === 'openai' ? body.provider : null;
  const frame = typeof body.frame === 'string' && body.frame.length <= MAX_TEST_PICTURE_CHARS ? body.frame : null;
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (!provider || !frame) {
    sendJson(response, 400, { error: 'provider (gemini or openai) and frame (a JPEG or PNG data URL) are needed' } satisfies ErrorResponse);
    return;
  }
  if (provider === 'openai' && baseUrl !== 'fleet:vision' && !httpBase(baseUrl)) {
    sendJson(response, 400, { error: 'baseUrl must be an http(s) URL or fleet:vision' } satisfies ErrorResponse);
    return;
  }
  sendJson(response, 200, await visionService.test({ provider, model, baseUrl, dataUrl: frame }));
}

export function studioVision(): StudioVisionResponse {
  const config = runtimeConfig;
  const faces = studioSettings.enabled ? listenerFaceWorker() : null;
  return {
    camera: {
      // What the listener page says, whether or not anyone watches its live state.
      on: faces ? faces.camera : studioSettings.enabled && lastLiveStatus() ? Boolean(lastLiveStatus()?.faceCameraActive) : null,
      source: studioSettings.visionSource,
    },
    vision: {
      provider: config.visionProvider,
      model: config.visionModel || (config.visionProvider === 'gemini' ? config.llmModel : ''),
      on: config.visionProvider !== 'off',
    },
    last: visionService.lastCheck(),
    faces,
    observation: lastObservation()?.observation ?? null,
    relationships: relationshipsInEffect(config.relationshipsEnabled).map(({ name, attitude }) => ({ name, attitude })),
  };
}
