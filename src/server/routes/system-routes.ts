// Health, stats, live config, sleep/wake and the spectator link.

import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { ConfigResponse, ErrorResponse, GreetingsResponse, HealthResponse, StatsResponse } from '../../shared/contracts/http.js';
import type { WsSleepServerMessage, WsWakeServerMessage } from '../../shared/contracts/ws.js';
import { interruptAssistantTurns } from '../assistant/service.js';
import { endConversation } from '../assistant/turns.js';
import { readJsonBody } from '../http/body.js';
import { sendJson } from '../http/response.js';
import { applyRuntimeConfigPatch, runtimeConfig, toConfigResponse, toHealthResponse, toStatsResponse } from '../config/runtime.js';
import { broadcast, broadcastConfig, getClientCount, getSpectatorCount } from '../ws/server.js';
import { MING_PORT, SPEECH_SERVICE_PORT, restartSpeechService, speechServiceRunning } from '../processing/speech-service.js';
import { createReadiness, probeJson } from '../health/readiness.js';
import { toStudioResponse } from '../studio/state.js';
import { visionService } from '../assistant/vision.js';
import { personaOverride } from '../persona/index.js';

const greetingsPath = resolve(process.cwd(), 'src/persona/greetings.json');

const readiness = createReadiness({
  probe: probeJson,
  speechUrl: `http://127.0.0.1:${SPEECH_SERVICE_PORT}`,
  mingUrl: (process.env.MING_TTS_URL?.trim() || `http://127.0.0.1:${MING_PORT}`).replace(/\/+$/, ''),
  speechRunning: speechServiceRunning,
  voices: () => [runtimeConfig.kokoroVoice, ...(runtimeConfig.dualHeadEnabled && runtimeConfig.dualHeadMode !== 'off' ? [runtimeConfig.secondaryVoice] : [])],
  studio: () => toStudioResponse(),
});

export async function handleSystemRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
    const { ready, parts } = await readiness.check();
    const payload: HealthResponse = { ...toHealthResponse(getClientCount()), ready, parts };
    // /health always answers (it is for people); /healthz is "ready or not" for studio-manager.
    sendJson(response, url.pathname === '/healthz' && !ready ? 503 : 200, payload);
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/stats') {
    const payload: StatsResponse = { ...toStatsResponse(), vision: visionService.stats() };
    sendJson(response, 200, payload);
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/config') {
    const payload: ConfigResponse = toConfigResponse();
    sendJson(response, 200, payload);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/config') {
    try {
      const { visionApiKey, ...patch } = await readJsonBody<Partial<ConfigResponse> & { visionApiKey?: unknown }>(request);
      // Write-only: the key is never part of the config anyone can read.
      if (visionApiKey !== undefined) {
        if (typeof visionApiKey !== 'string') throw Object.assign(new Error('visionApiKey must be a string'), { name: 'BadRequestError' });
        visionService.setApiKey(visionApiKey);
      }
      const shouldRestartStt = patch.sttModel !== undefined && patch.sttModel !== toConfigResponse().sttModel;
      const wasMuted = runtimeConfig.muted;
      const payload = applyRuntimeConfigPatch(patch);
      if (shouldRestartStt && patch.sttModel) {
        await restartSpeechService(patch.sttModel, 'config patch');
      }
      broadcastConfig();
      if (!wasMuted && runtimeConfig.muted) {
        // Mute means silence now: drop the turn in flight and stop client audio.
        interruptAssistantTurns();
        broadcast({ type: 'interrupt', turnId: null, source: 'system' });
      }
      sendJson(response, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid config payload';
      const statusCode = error instanceof Error && error.name === 'BadRequestError' ? 400 : 500;
      const payload: ErrorResponse = { error: message };
      sendJson(response, statusCode, payload);
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/greetings') {
    // An applied character preset may bring its own lines.
    const override = personaOverride().greetings;
    if (override) {
      sendJson(response, 200, override);
      return true;
    }
    try {
      if (!existsSync(greetingsPath)) {
        sendJson(response, 404, { error: 'Greetings not found' } satisfies ErrorResponse);
        return true;
      }
      const greetings = JSON.parse(readFileSync(greetingsPath, 'utf8')) as GreetingsResponse;
      sendJson(response, 200, greetings);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Failed to read greetings',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/wake') {
    visionService.noteSleeping(false);
    broadcast({ type: 'wake' } satisfies WsWakeServerMessage);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/sleep') {
    // Whoever comes next after a nap is a new visitor: wake word again.
    endConversation();
    visionService.noteSleeping(true);
    broadcast({ type: 'sleep' } satisfies WsSleepServerMessage);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/spectator-url') {
    const localIp = getLocalNetworkIp();
    const serverPort = Number.parseInt(process.env.PORT ?? '3000', 10);
    const actor = url.searchParams.get('actor') || undefined;
    const baseUrl = `http://${localIp}:${serverPort}/spectator.html`;
    const isDualHead = runtimeConfig.dualHeadEnabled === true && runtimeConfig.dualHeadMode !== 'off';
    // When dual-head is active and no specific actor requested, return URLs for both faces
    if (isDualHead && !actor) {
      sendJson(response, 200, {
        urls: {
          main: `${baseUrl}?actor=main`,
          small: `${baseUrl}?actor=small`,
        },
        dualHead: true,
        ip: localIp,
        port: serverPort,
        spectators: getSpectatorCount(),
      });
    } else {
      const effectiveActor = actor ?? 'main';
      const spectatorUrl = `${baseUrl}?actor=${effectiveActor}`;
      sendJson(response, 200, {
        url: spectatorUrl,
        actor: effectiveActor,
        dualHead: isDualHead,
        ip: localIp,
        port: serverPort,
        spectators: getSpectatorCount(),
      });
    }
    return true;
  }

  return false;
}

function getLocalNetworkIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
