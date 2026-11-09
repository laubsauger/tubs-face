// Character presets: GET /presets, POST /presets {name} (save the current
// state), POST /presets/apply {name}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '../../shared/contracts/http.js';
import { readJsonBody } from '../http/body.js';
import { sendJson } from '../http/response.js';
import { PresetError, applyPreset, listPresets, savePreset } from '../presets/presets.js';
import { broadcastConfig } from '../ws/server.js';

export async function handlePresetRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/presets' && request.method === 'GET') {
    sendJson(response, 200, listPresets());
    return true;
  }
  if (request.method !== 'POST' || (url.pathname !== '/presets' && url.pathname !== '/presets/apply')) return false;
  try {
    const { name } = await readJsonBody<{ name?: unknown }>(request);
    if (typeof name !== 'string') throw new PresetError('Missing name', 400);
    if (url.pathname === '/presets') {
      savePreset(name);
    } else {
      applyPreset(name);
      // The face pages and the dashboard take the new look and voices from here.
      broadcastConfig();
    }
    sendJson(response, 200, listPresets());
  } catch (error) {
    const status = error instanceof PresetError ? error.status : error instanceof SyntaxError ? 400 : 500;
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) } satisfies ErrorResponse);
  }
  return true;
}
