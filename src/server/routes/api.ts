import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type {
  ConfigResponse,
  DonationConfirmRequest,
  DonationConfirmResponse,
  ErrorResponse,
  FaceCreateRequest,
  FaceCreateResponse,
  FaceDeleteResponse,
  FaceLibraryResponse,
  GreetingsResponse,
  HealthResponse,
  IngestDoneRequest,
  IngestDoneResponse,
  IngestListResponse,
  ManualTurnScriptRequest,
  ManualTurnScriptResponse,
  PayPalCaptureRequest,
  PayPalCaptureResponse,
  PayPalOrderRequest,
  PayPalOrderResponse,
  SpeakRequest,
  SpeakResponse,
  StatsResponse,
  WakeWordResult,
  VoiceResponse,
  TtsRequest,
} from '../../shared/contracts/http.js';
import type {
  WsConversationModeServerMessage,
  WsExpressionServerMessage,
  WsIncomingServerMessage,
  WsSleepServerMessage,
  WsSpeakServerMessage,
  WsThinkingServerMessage,
  WsTurnScriptServerMessage,
  WsTurnStartServerMessage,
  WsWakeServerMessage,
} from '../../shared/contracts/ws.js';
import type { TurnBeat } from '../../shared/contracts/turn-script.js';
import { createTurnId, interruptAssistantTurns, runAssistantTurn } from '../assistant/service.js';
import { readJsonBody } from '../http/body.js';
import { applyCors, sendError, sendJson, sendNoContent } from '../http/response.js';
import { applyRuntimeConfigPatch, runtimeConfig, sessionStats, toConfigResponse, toHealthResponse, toStatsResponse } from '../config/runtime.js';
import { broadcast, broadcastConfig, getClientCount } from '../ws/server.js';
import { getTtsProxyTarget, restartTranscriptionService, transcribeAudio } from '../processing/mode-manager.js';
import { createTurnTimer } from '../turn-timing.js';
import { WAKE_MATCHER_VERSION, detectWakeWord } from '../wake-word.js';
import { addFace, deleteFace, readFaceLibrary } from '../faces/library.js';
import { captureOrder, createOrder } from '../paypal/client.js';
import { emitDonationSignal, isDonationWebhookAuthorized, normalizeCurrencyCode, normalizeDonationSignalCertainty, toDonationSignalFromPayPalCapture, toDonationSignalFromPaypalEvent, toSafeAmount } from '../donations.js';

const CONVERSATION_WINDOW_MS = 45_000;
const greetingsPath = resolve(process.cwd(), 'src/persona/greetings.json');
const shapesDir = resolve(process.cwd(), 'src/shapes');
const inputFacesDir = resolve(process.cwd(), 'input_faces');
const processedFacesDir = resolve(process.cwd(), 'processed_faces');
let lastConversationAt = 0;

export async function handleApiRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  applyCors(response);

  if (request.method === 'OPTIONS') {
    sendNoContent(response);
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    const payload: HealthResponse = toHealthResponse(getClientCount());
    sendJson(response, 200, payload);
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/stats') {
    const payload: StatsResponse = toStatsResponse();
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
      const patch = await readJsonBody<Partial<ConfigResponse>>(request);
      const shouldRestartStt = patch.sttModel !== undefined && patch.sttModel !== toConfigResponse().sttModel;
      const payload = applyRuntimeConfigPatch(patch);
      if (shouldRestartStt && patch.sttModel) {
        await restartTranscriptionService(patch.sttModel, 'config patch');
      }
      broadcastConfig();
      sendJson(response, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid config payload';
      const statusCode = error instanceof Error && error.name === 'BadRequestError' ? 400 : 500;
      const payload: ErrorResponse = { error: message };
      sendJson(response, statusCode, payload);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/speak') {
    try {
      const body = await readJsonBody<SpeakRequest>(request);
      if (!body.text?.trim()) {
        throw badRequest('text is required');
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

      const wakeWord = url.searchParams.get('wakeWord') === 'true';
      const audioBuffer = await readRawBody(request);
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
      const inConversation = (Date.now() - lastConversationAt) < CONVERSATION_WINDOW_MS;

      if (wakeWord) {
        wake = detectWakeWord(text);
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

      sessionStats.messagesIn += 1;
      sessionStats.lastActivity = Date.now();
      lastConversationAt = Date.now();

      const interruptedTurnId = interruptAssistantTurns();
      broadcast({
        type: 'interrupt',
        ...(interruptedTurnId ? { turnId: interruptedTurnId } : {}),
        source: 'voice_barge_in',
      });

      broadcast({
        type: 'incoming',
        text,
      } satisfies WsIncomingServerMessage);
      broadcast({
        type: 'conversation_mode',
        active: true,
        expiresIn: CONVERSATION_WINDOW_MS,
      } satisfies WsConversationModeServerMessage);
      broadcast({
        type: 'thinking',
      } satisfies WsThinkingServerMessage);

      const endAssistantSpan = turnTimer.span('LLM Generation');
      const result = await runAssistantTurn(text, broadcast, turnTimer);
      endAssistantSpan();
      if (result.superseded) {
        turnTimer.mark('Assistant turn superseded');
      }

      sendJson(response, 200, {
        ok: true,
        text,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(result.superseded ? { ignored: true, reason: 'superseded' } : {}),
        ...(wake ? { wake } : {}),
      } satisfies VoiceResponse & { turnId?: string });
      turnTimer.mark('HTTP response sent');
      turnTimer.log({ title: '[Turn Timing]' });
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
      const proxied = await proxyTts(rawBody.toString('utf8'));
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

  if (request.method === 'POST' && url.pathname === '/checkout/paypal/order') {
    try {
      const payload = await readJsonBody<PayPalOrderRequest>(request);
      const createOrderArgs = {
        amount: payload.amount ?? process.env.PAYPAL_DEFAULT_DONATION_AMOUNT ?? '5.00',
        currency: payload.currency ?? 'USD',
        description: payload.description ?? 'Wheels for Tubs',
        ...(payload.referenceId ? { referenceId: payload.referenceId } : {}),
      };
      const order = await createOrder(createOrderArgs);
      const approveUrl = Array.isArray(order.links)
        ? order.links.find((link) => link.rel === 'approve')?.href
        : undefined;
      sendJson(response, 200, {
        ok: true,
        ...(order.id ? { id: order.id, orderId: order.id } : {}),
        ...(order.status ? { status: order.status } : {}),
        ...(approveUrl ? { approveUrl } : {}),
        order,
      } satisfies PayPalOrderResponse);
    } catch (error) {
      sendJson(response, getPayPalErrorStatus(error), {
        error: error instanceof Error ? error.message : 'PayPal order creation failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/checkout/paypal/capture') {
    try {
      const payload = await readJsonBody<PayPalCaptureRequest>(request);
      const capture = await captureOrder(payload.orderId);
      const donationSignal = toDonationSignalFromPayPalCapture(capture);
      if (donationSignal) {
        emitDonationSignal(donationSignal);
      }
      sendJson(response, 200, {
        ok: true,
        ...(capture.id ? { id: capture.id } : {}),
        ...(capture.status ? { status: capture.status } : {}),
        capture,
        donationSignal: donationSignal ?? null,
      } satisfies PayPalCaptureResponse);
    } catch (error) {
      sendJson(response, getPayPalErrorStatus(error), {
        error: error instanceof Error ? error.message : 'PayPal capture failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/donations/confirm') {
    if (!isDonationWebhookAuthorized(request)) {
      sendJson(response, 401, { error: 'Unauthorized donation confirmation' } satisfies ErrorResponse);
      return true;
    }

    try {
      const payload = await readJsonBody<DonationConfirmRequest>(request);
      const amount = toSafeAmount(payload.amount);
      const currency = normalizeCurrencyCode(payload.currency);
      const signal = {
        certainty: normalizeDonationSignalCertainty(payload.certainty),
        source: String(payload.source || 'manual-confirm'),
        ...(amount ? { amount } : {}),
        ...(currency ? { currency } : {}),
        ...(payload.note ? { note: String(payload.note).slice(0, 180) } : {}),
        ...(payload.donor ? { donor: String(payload.donor).slice(0, 64) } : {}),
        ...(payload.reference ? { reference: String(payload.reference).slice(0, 120) } : {}),
      };
      emitDonationSignal(signal);
      sendJson(response, 200, {
        ok: true,
        signal,
      } satisfies DonationConfirmResponse);
    } catch (error) {
      const statusCode = error instanceof Error && error.name === 'BadRequestError' ? 400 : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Donation confirmation failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/paypal') {
    if (!isDonationWebhookAuthorized(request)) {
      sendJson(response, 401, { error: 'Unauthorized webhook' } satisfies ErrorResponse);
      return true;
    }

    try {
      const event = await readJsonBody<Record<string, unknown>>(request);
      const eventType = String(event.event_type || '').trim();
      const signal = toDonationSignalFromPaypalEvent(eventType, event);
      if (signal) {
        emitDonationSignal(signal);
        sendJson(response, 200, {
          ok: true,
          processed: true,
          eventType,
          signal,
        });
        return true;
      }

      sendJson(response, 200, {
        ok: true,
        processed: false,
        eventType,
      });
    } catch (error) {
      const statusCode = error instanceof SyntaxError ? 400 : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Webhook processing failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

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

  if (request.method === 'DELETE' && url.pathname === '/faces') {
    const id = url.searchParams.get('id')?.trim();
    if (!id) {
      sendJson(response, 400, { error: 'Missing id parameter' } satisfies ErrorResponse);
      return true;
    }
    const removed = deleteFace(id);
    sendJson(response, 200, {
      ok: true,
      removed,
    } satisfies FaceDeleteResponse);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/turn-script/manual') {
    try {
      const payload = await readJsonBody<ManualTurnScriptRequest>(request);
      const beats = normalizeManualTurnBeats(payload.beats);
      const turnId = createTurnId();
      broadcast({
        type: 'turn_start',
        turnId,
      } satisfies WsTurnStartServerMessage);
      broadcast({
        type: 'turn_script',
        turnId,
        beats,
        ...(payload.donation ? { donation: payload.donation } : {}),
        ts: Date.now(),
      } satisfies WsTurnScriptServerMessage);
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

  if (request.method === 'GET' && url.pathname === '/api/greetings') {
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

  if (request.method === 'GET' && url.pathname.startsWith('/shapes/')) {
    const filename = decodeURIComponent(url.pathname.replace('/shapes/', ''));
    if (!/^[a-zA-Z0-9._-]+\.svg$/.test(filename)) {
      sendJson(response, 400, { error: 'Invalid shape filename' } satisfies ErrorResponse);
      return true;
    }

    const fullPath = resolve(shapesDir, filename);
    if (!fullPath.startsWith(shapesDir)) {
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
      if (!inputPath.startsWith(inputFacesDir) || !processedPath.startsWith(processedFacesDir)) {
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
    if (!fullPath.startsWith(inputFacesDir)) {
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

  if (request.method === 'POST' && url.pathname === '/wake') {
    broadcast({ type: 'wake' } satisfies WsWakeServerMessage);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/sleep') {
    broadcast({ type: 'sleep' } satisfies WsSleepServerMessage);
    sendJson(response, 200, { ok: true });
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

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = 'BadRequestError';
  return error;
}

function getPayPalErrorStatus(error: unknown): number {
  const code = error && typeof error === 'object' ? String((error as { code?: string }).code || '') : '';
  if (code === 'BAD_PAYPAL_AMOUNT' || code === 'BAD_PAYPAL_CURRENCY' || code === 'BAD_PAYPAL_ORDER_ID') {
    return 400;
  }
  if (code === 'MISSING_PAYPAL_CREDENTIALS') {
    return 503;
  }
  return 500;
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

/**
 * Detect common Whisper hallucinations — short phantom phrases the model
 * produces when fed silence or background noise.
 */
const WHISPER_HALLUCINATIONS = new Set([
  'thank you.',
  'thank you',
  'thanks.',
  'thanks',
  'thanks for watching.',
  'thanks for watching',
  'thank you for watching.',
  'thank you for watching',
  'bye.',
  'bye',
  'goodbye.',
  'goodbye',
  'you',
  'the end.',
  'the end',
  'subscribe.',
  'subscribe',
  'like and subscribe.',
  '.',
  '...',
  'you.',
  'hmm.',
  'hmm',
  'hm.',
  'huh.',
  'uh.',
  'um.',
  'oh.',
  'ah.',
  'i\'m sorry.',
]);

function isWhisperHallucination(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (WHISPER_HALLUCINATIONS.has(lower)) {
    return true;
  }
  // Pure punctuation / whitespace
  if (/^[\s.,!?…\-–—]+$/.test(lower)) {
    return true;
  }
  return false;
}
