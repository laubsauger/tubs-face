import type { WsClientMessage, WsServerMessage } from '../contracts/ws.js';

const WS_CLIENT_TYPES = new Set<WsClientMessage['type']>([
  'ping',
  'incoming',
  'interrupt',
  'face_motion',
  'face_blink',
  'head_speech_state',
  'presence',
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


export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function hasString(value: unknown, key: string): value is Record<string, string> {
  return isRecord(value) && typeof value[key] === 'string';
}

const MAX_TEXT_CHARS = 2000;
const MAX_ID_CHARS = 64;
// Base64 JPEG data URL from the camera; a few hundred KB in practice.
const MAX_FRAME_CHARS = 4_000_000;

const isActor = (v: unknown): boolean => v === 'main' || v === 'small';
const isFiniteNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const optNumber = (v: unknown): boolean => v === undefined || isFiniteNumber(v);
const optBoolean = (v: unknown): boolean => v === undefined || typeof v === 'boolean';
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
      return text(m.text, MAX_TEXT_CHARS);
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
      return typeof m.present === 'boolean' && optBoolean(m.newVisitor) && optNames(m.faces) && optNumber(m.count);
    case 'proactive':
      return optString(m.context, MAX_TEXT_CHARS) && optNames(m.faces);
    case 'camera_frame':
      return frame(m.frame);
    case 'appearance_frame':
      return frame(m.frame) && optNames(m.faces) && optNumber(m.count) && optBoolean(m.returning) && optNumber(m.awayMs);
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
