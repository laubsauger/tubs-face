// Ways in for a turn: typed chat, voice clips, operator lines and beat scripts, plus the TTS proxy.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse, IncomingRequest, IncomingResponse, ManualTurnScriptRequest, ManualTurnScriptResponse, SpeakRequest, SpeakResponse, WakeWordResult, VoiceResponse, TtsRequest } from '../../shared/contracts/http.js';
import type { WsExpressionServerMessage, WsSpeakServerMessage } from '../../shared/contracts/ws.js';
import type { TurnBeat } from '../../shared/contracts/turn-script.js';
import { playManualTurnScript } from '../assistant/service.js';
import { isInConversation, startUserTurn, wakeWordMode } from '../assistant/turns.js';
import { studioSettings } from '../studio/state.js';
import { sanitizeForTts, stripFormatting, unwrapJsonSpeechText } from '../assistant/text.js';
import { readJsonBody } from '../http/body.js';
import { sendError, sendJson } from '../http/response.js';
import { runtimeConfig, sessionStats } from '../config/runtime.js';
import { broadcast } from '../ws/server.js';
import { getTtsProxyTarget, transcribeAudio } from '../processing/speech-service.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { beginRender } from '../tts/rendering.js';
import { createTurnTimer } from '../turn-timing.js';
import { WAKE_MATCHER_VERSION, detectWakeWord } from '../wake-word.js';
import { isWhisperHallucination } from '../whisper-hallucination.js';
import { badRequest } from './route-helpers.js';

export async function handleTurnRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (request.method === 'POST' && url.pathname === '/speak') {
    try {
      const body = await readJsonBody<SpeakRequest>(request);
      if (!body.text?.trim()) {
        throw badRequest('text is required');
      }
      if (runtimeConfig.muted) {
        sendJson(response, 200, { ok: true, ignored: true, reason: 'muted' } satisfies SpeakResponse);
        return true;
      }

      broadcast({
        type: 'speak',
        text: body.text.trim(),
        ts: Date.now(),
      } satisfies WsSpeakServerMessage);

      sendJson(response, 200, {
        ok: true,
      } satisfies SpeakResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid speak payload';
      sendJson(response, 400, { error: message } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/incoming') {
    try {
      const body = await readJsonBody<IncomingRequest>(request);
      const text = body.text?.trim();
      if (!text) {
        throw badRequest('text is required');
      }
      const turn = startUserTurn({ text, source: 'text', broadcast });
      sendJson(response, 200, (turn ? { ok: true } : { ok: true, ignored: true, reason: 'muted' }) satisfies IncomingResponse);
      void turn?.catch(() => {
        // Already logged and broadcast as an error by startUserTurn.
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Text request failed';
      const statusCode = error instanceof Error && error.name === 'BadRequestError' ? 400 : 500;
      sendJson(response, statusCode, { error: message } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/voice') {
    try {
      const startedAtStr = url.searchParams.get('startedAt');
      const stoppedAtStr = url.searchParams.get('stoppedAt');
      const requestReceivedAt = Date.now();

      const turnTimer = createTurnTimer({
        side: 'backend',
        source: 'voice',
        startedAt: requestReceivedAt,
      });

      if (startedAtStr && stoppedAtStr) {
        const spokenMs = Number(stoppedAtStr) - Number(startedAtStr);
        if (spokenMs > 0) {
          turnTimer.setMeta('Spoke', spokenMs < 1000 ? `${Math.round(spokenMs)} ms` : `${(spokenMs / 1000).toFixed(2)} s`);
        }
      }
      if (runtimeConfig.muted) {
        turnTimer.mark('Ignored (muted)');
        sendJson(response, 200, {
          ok: true,
          ignored: true,
          reason: 'muted',
        } satisfies VoiceResponse);
        turnTimer.mark('HTTP response sent');
        turnTimer.log({ title: '[Turn Timing]' });
        return true;
      }

      // the page asks for it (its Voice panel), or the studio waits for "hey Tubs" (its switch, set by the scene or the dashboard)
      const wakeWord = url.searchParams.get('wakeWord') === 'true' || wakeWordMode();
      const audioBuffer = await readRawBody(request);
      // The reply's LLM request follows the transcript; its connection opens meanwhile.
      if (!wakeWord) resolveLlmProvider().warmUp?.();
      const endSttSpan = turnTimer.span('STT');
      const transcription = await transcribeAudio(audioBuffer, request.headers['content-type']);
      endSttSpan();
      const text = String((transcription as { text?: string }).text ?? '').trim();
      if (text) {
        turnTimer.setMeta('User', text);
      }

      if (!text || isWhisperHallucination(text)) {
        turnTimer.mark(`Ignored (${!text ? 'empty' : 'hallucination'}: "${text}")`);
        sendJson(response, 200, {
          ok: true,
          ignored: true,
          reason: !text ? 'empty' : 'hallucination',
        } satisfies VoiceResponse);
        turnTimer.log({ title: '[Turn Timing]' });
        return true;
      }

      let wake: WakeWordResult | undefined;
      const inConversation = isInConversation();

      if (wakeWord) {
        wake = detectWakeWord(text, studioSettings.enabled ? studioSettings.wakeNames : []);
        const skipWake = !wake.detected && inConversation;
        console.log(
          `[WakeWord:${WAKE_MATCHER_VERSION}] detected=${wake.detected} convo=${inConversation} skip=${skipWake} reason=${wake.reason} source=${wake.matchedSource || ''} normalized="${wake.normalized || ''}" matched="${wake.matchedToken || ''}"`,
        );
        if (!wake.detected && !inConversation) {
          turnTimer.mark('Ignored (wake word missing)');
          broadcast({
            type: 'expression',
            expression: 'idle',
          } satisfies WsExpressionServerMessage);
          sendJson(response, 200, {
            ok: true,
            ignored: true,
            text,
            wake,
          } satisfies VoiceResponse);
          turnTimer.mark('HTTP response sent');
          turnTimer.log({ title: '[Turn Timing]' });
          return true;
        }
      }

      // Answer as soon as the clip is accepted. The reply arrives over the
      // WebSocket; holding the request until it finished left the client on
      // "Thinking..." and re-showed the transcript after the reply.
      const turn = startUserTurn({ text, source: 'voice', broadcast, turnTimer });
      sendJson(response, 200, {
        ok: true,
        text,
        ...(turn ? {} : { ignored: true, reason: 'muted' }),
        ...(wake ? { wake } : {}),
      } satisfies VoiceResponse);
      turnTimer.mark('HTTP response sent');
      void turn?.catch(() => {
        // Already logged and broadcast as an error by startUserTurn.
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice request failed';
      sendJson(response, 500, { error: message } satisfies ErrorResponse);
      broadcast({
        type: 'error',
        text: message,
      });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/tts') {
    let turnTimer = createTurnTimer({ side: 'backend', source: 'tts' });
    try {
      const rawBody = await readRawBody(request);
      turnTimer.mark('TTS request received');
      const ttsRequest = parseTtsRequest(rawBody);
      turnTimer = createTurnTimer({
        side: 'backend',
        source: 'tts',
        ...(ttsRequest.turnId ? { turnId: ttsRequest.turnId } : {}),
      });
      turnTimer.mark('TTS request received');
      const endTtsSpan = turnTimer.span('Kokoro TTS');
      const renderDone = beginRender();
      const proxied = await proxyTts(buildNormalizedTtsRequestBody(rawBody)).finally(renderDone);
      endTtsSpan();
      if (proxied.statusCode >= 400) {
        turnTimer.mark('Python TTS failed');
      }
      response.writeHead(proxied.statusCode, proxied.headers);
      response.end(proxied.body);
      turnTimer.mark('HTTP response sent');
      turnTimer.log({ title: '[Turn Timing]' });
    } catch (error) {
      turnTimer.mark('TTS proxy failed');
      turnTimer.log({ title: '[Turn Timing]' });
      const message = error instanceof Error ? error.message : 'TTS proxy failed';
      sendError(response, 502, message);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/turn-script/manual') {
    try {
      const payload = await readJsonBody<ManualTurnScriptRequest>(request);
      const beats = normalizeManualTurnBeats(payload.beats);
      const { turnId } = playManualTurnScript(beats, broadcast);
      sessionStats.messagesOut += 1;
      sessionStats.lastActivity = Date.now();
      sendJson(response, 200, {
        ok: true,
        turnId,
        beatCount: beats.length,
      } satisfies ManualTurnScriptResponse);
    } catch (error) {
      const statusCode = error instanceof Error && error.name === 'BadRequestError' ? 400 : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Manual turn dispatch failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

  return false;
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function proxyTts(body: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const target = getTtsProxyTarget();
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
    }, (proxyResponse) => {
      const chunks: Buffer[] = [];
      proxyResponse.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      proxyResponse.on('end', () => {
        resolve({
          statusCode: proxyResponse.statusCode ?? 502,
          headers: proxyResponse.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function parseTtsRequest(rawBody: Buffer): Partial<TtsRequest> {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as Partial<TtsRequest>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function buildNormalizedTtsRequestBody(rawBody: Buffer): string {
  const parsed = parseTtsRequest(rawBody);
  if (typeof parsed.text !== 'string') {
    return rawBody.toString('utf8');
  }

  const normalizedText = sanitizeForTts(stripFormatting(unwrapJsonSpeechText(parsed.text)));
  if (!normalizedText) {
    return rawBody.toString('utf8');
  }

  return JSON.stringify({
    ...parsed,
    text: normalizedText,
  } satisfies Partial<TtsRequest>);
}

function normalizeManualTurnBeats(beats: TurnBeat[] | undefined): TurnBeat[] {
  if (!Array.isArray(beats) || beats.length === 0) {
    throw badRequest('beats[] is required');
  }

  return beats.map((beat, index) => {
    if (!beat || typeof beat !== 'object') {
      throw badRequest(`Beat ${index + 1} is invalid`);
    }

    const actor = beat.actor === 'small' ? 'small' : 'main';
    const action = beat.action === 'react' || beat.action === 'wait' ? beat.action : 'speak';
    const text = typeof beat.text === 'string' ? beat.text.trim() : '';

    if (action === 'speak' && !text) {
      throw badRequest(`Beat ${index + 1} text is required for speak`);
    }

    const normalized: TurnBeat = {
      actor,
      action,
      ...(text ? { text } : {}),
    };

    if (typeof beat.delayMs === 'number' && Number.isFinite(beat.delayMs)) {
      normalized.delayMs = Math.max(120, Math.min(8000, Math.round(beat.delayMs)));
    }

    if (beat.emotion && typeof beat.emotion === 'object') {
      normalized.emotion = {
        ...(beat.emotion.expression ? { expression: beat.emotion.expression } : {}),
        ...(beat.emotion.emoji ? { emoji: beat.emotion.emoji } : {}),
        ...(beat.emotion.impulse ? { impulse: beat.emotion.impulse } : {}),
      };
    }

    return normalized;
  });
}
