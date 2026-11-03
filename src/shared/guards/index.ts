import type { FaceWorkerRequestMessage, FaceWorkerResponseMessage } from '../contracts/worker.js';
import type { WsClientMessage, WsServerMessage } from '../contracts/ws.js';

const WS_CLIENT_TYPES = new Set<WsClientMessage['type']>([
  'ping',
  'incoming',
  'interrupt',
  'face_motion',
  'face_blink',
  'head_speech_state',
  'presence',
  'face_greeting',
  'proactive',
  'camera_frame',
  'appearance_frame',
  'tts_request',
]);

const WS_SERVER_TYPES = new Set<WsServerMessage['type']>([
  'ping',
  'config',
  'system',
  'expression',
  'thinking',
  'speak',
  'speak_chunk',
  'speak_end',
  'audio_chunk',
  'turn_start',
  'interrupt',
  'turn_context',
  'turn_script',
  'backchannel',
  'incoming',
  'donation_signal',
  'stats',
  'stream_debug',
  'conversation_mode',
  'sleep',
  'wake',
  'error',
  'face_motion',
  'face_blink',
  'head_speech_state',
]);

const WORKER_REQUEST_TYPES = new Set<FaceWorkerRequestMessage['type']>([
  'init',
  'detect',
]);

const WORKER_RESPONSE_TYPES = new Set<FaceWorkerResponseMessage['type']>([
  'ready',
  'progress',
  'faces',
  'error',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function hasString(value: unknown, key: string): value is Record<string, string> {
  return isRecord(value) && typeof value[key] === 'string';
}

export function hasNumber(value: unknown, key: string): value is Record<string, number> {
  return isRecord(value) && typeof value[key] === 'number';
}

export function hasBoolean(value: unknown, key: string): value is Record<string, boolean> {
  return isRecord(value) && typeof value[key] === 'boolean';
}

const MAX_TEXT_CHARS = 2000;
const MAX_ID_CHARS = 64;
// Base64 JPEG data URL from the camera; a few hundred KB in practice.
const MAX_FRAME_CHARS = 4_000_000;

const isActor = (v: unknown): boolean => v === 'main' || v === 'small';
const isFiniteNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const optNumber = (v: unknown): boolean => v === undefined || isFiniteNumber(v);
const optString = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'string' && v.length <= max);
const optNullableString = (v: unknown, max: number): boolean => v === null || optString(v, max);
const text = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const frame = (v: unknown): boolean => typeof v === 'string' && v.length <= MAX_FRAME_CHARS && v.startsWith('data:image/');
const optNames = (v: unknown): boolean => v === undefined
  || (Array.isArray(v) && v.length <= 20 && v.every((name) => typeof name === 'string' && name.length <= 80));

/**
 * Checks the payload, not just the type: the server acts on these directly
 * (an `incoming` without text used to start a turn on `undefined`).
 */
export function isWsClientMessage(value: unknown): value is WsClientMessage {
  if (!hasString(value, 'type') || !WS_CLIENT_TYPES.has(value.type as WsClientMessage['type'])) {
    return false;
  }
  const m = value as Record<string, unknown>;
  switch (m.type as WsClientMessage['type']) {
    case 'ping':
      return optNumber(m.ts);
    case 'incoming':
      return text(m.text, MAX_TEXT_CHARS) && (m.frame === undefined || m.frame === null || frame(m.frame));
    case 'interrupt':
      return optString(m.turnId, MAX_ID_CHARS);
    case 'face_motion':
      return isActor(m.actor) && isFiniteNumber(m.x) && isFiniteNumber(m.y) && optNumber(m.ts);
    case 'face_blink':
      return isActor(m.actor) && optNumber(m.ts);
    case 'head_speech_state':
      return isActor(m.actor) && (m.state === 'start' || m.state === 'end')
        && optNullableString(m.turnId, MAX_ID_CHARS) && optNumber(m.ts) && optNumber(m.durationMs);
    case 'presence':
      return typeof m.present === 'boolean' && optNames(m.faces) && optNumber(m.count);
    case 'face_greeting':
      return true;
    case 'proactive':
      return optString(m.context, MAX_TEXT_CHARS) && optNames(m.faces);
    case 'camera_frame':
      return frame(m.frame);
    case 'appearance_frame':
      return frame(m.frame) && optNames(m.faces) && optNumber(m.count);
    case 'tts_request':
      return text(m.text, MAX_TEXT_CHARS) && optString(m.voice, MAX_ID_CHARS)
        && optString(m.turnId, MAX_ID_CHARS) && optString(m.requestId, MAX_ID_CHARS);
    default:
      return false;
  }
}

export function isWsServerMessage(value: unknown): value is WsServerMessage {
  return hasString(value, 'type') && WS_SERVER_TYPES.has(value.type as WsServerMessage['type']);
}

export function isFaceWorkerRequestMessage(value: unknown): value is FaceWorkerRequestMessage {
  return hasString(value, 'type') && WORKER_REQUEST_TYPES.has(value.type as FaceWorkerRequestMessage['type']);
}

export function isFaceWorkerResponseMessage(value: unknown): value is FaceWorkerResponseMessage {
  return hasString(value, 'type') && WORKER_RESPONSE_TYPES.has(value.type as FaceWorkerResponseMessage['type']);
}
