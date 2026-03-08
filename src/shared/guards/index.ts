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

export function isWsClientMessage(value: unknown): value is WsClientMessage {
  return hasString(value, 'type') && WS_CLIENT_TYPES.has(value.type as WsClientMessage['type']);
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
