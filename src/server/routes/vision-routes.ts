// What Tubs last made of a picture, for the Studio tab: GET /studio/vision.
// It names the people in front of him: local network only, no CORS (like the
// memory view's photos).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '../../shared/contracts/http.js';
import type { StudioVisionResponse } from '../../shared/contracts/studio.js';
import { relationshipsInEffect } from '../assistant/relationships.js';
import { visionService } from '../assistant/vision.js';
import { runtimeConfig } from '../config/runtime.js';
import { sendJson } from '../http/response.js';
import { isLocalNetworkAddress } from '../memory/view.js';
import { lastLiveStatus } from '../studio/live.js';
import { studioSettings } from '../studio/state.js';

export async function handleVisionRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/studio/vision') return false;
  if (!isLocalNetworkAddress(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: 'What Tubs sees is for the local network only' } satisfies ErrorResponse);
    return true;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'GET only' } satisfies ErrorResponse);
    return true;
  }
  sendJson(response, 200, studioVision());
  return true;
}

export function studioVision(): StudioVisionResponse {
  const config = runtimeConfig;
  return {
    camera: {
      on: studioSettings.enabled ? Boolean(lastLiveStatus()?.faceCameraActive) : null,
      source: studioSettings.visionSource,
    },
    vision: {
      provider: config.visionProvider,
      model: config.visionModel || (config.visionProvider === 'gemini' ? config.llmModel : ''),
      on: config.visionProvider !== 'off',
    },
    last: visionService.lastCheck(),
    relationships: relationshipsInEffect(config.relationshipsEnabled).map(({ name, attitude }) => ({ name, attitude })),
  };
}
