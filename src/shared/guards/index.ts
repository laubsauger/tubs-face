import type { WsClientMessage, WsServerMessage, WsStudioServerMessage } from '../contracts/ws.js';
import { STUDIO_FACE_METHODS } from '../contracts/studio.js';

const WS_CLIENT_TYPES = new Set<WsClientMessage['type']>([
  'ping',
  'incoming',
  'interrupt',
  'face_motion',
  'face_blink',
  'head_speech_state',
  'presence',
  'people',
  'proactive',
  'camera_frame',
  'appearance_frame',
  'tts_request',
  'studio_look',
  'studio_presence',
  'studio_state',
  'studio_status',
  'studio_caption',
  'studio_context',
  'studio_stage',
  'studio_live',
  'studio_watch',
  'studio_frame',
  'studio_face_call',
  'studio_face_result',
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
  'incoming',
  'stats',
  'conversation_mode',
  'field_notes',
  'enroll_request',
  'faces_changed',
  'sleep',
  'wake',
  'error',
  'face_motion',
  'face_blink',
  'head_speech_state',
  'studio_config',
  'studio_look',
  'studio_presence',
  'studio_state',
  'studio_caption',
  'studio_stage',
  'tts_rendering',
  'studio_live',
  'studio_watch',
  'studio_frame',
  'studio_pulse',
  'studio_face_call',
  'studio_face_result',
]);

const WS_STUDIO_SERVER_TYPES = new Set<WsStudioServerMessage['type']>(['studio_config', 'studio_look', 'studio_presence', 'studio_state', 'studio_caption', 'studio_stage', 'studio_watch', 'studio_face_call']);


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
/** A face thumbnail as the face page captures it (about 80 px, a few KB). */
const MAX_THUMBNAIL_CHARS = 60_000;
const optString = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'string' && v.length <= max);
const optNullableString = (v: unknown, max: number): boolean => v === null || optString(v, max);
const text = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const frame = (v: unknown): boolean => typeof v === 'string' && v.length <= MAX_FRAME_CHARS && v.startsWith('data:image/');
const unitRange = (v: unknown): boolean => isFiniteNumber(v) && Math.abs(v as number) <= 1;
const gaze = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(isFiniteNumber);
const mood = (v: unknown): boolean => isRecord(v) && unitRange(v.pos) && unitRange(v.neg) && unitRange(v.arousal);
const optMic = (v: unknown): boolean => v === undefined
  || (isRecord(v) && text(v.source, 300) && typeof v.listening === 'boolean' && optString(v.error, 300));
const labels = (v: unknown): boolean => Array.isArray(v) && v.length <= 32 && v.every((label) => typeof label === 'string' && label.length > 0 && label.length <= 200);
const optDevices = (v: unknown): boolean => v === undefined || (isRecord(v) && labels(v.audio) && labels(v.video));
const MAX_LIVE_FACES = 16;
/** A preview JPEG (studio_frame): a few hundred pixels wide. */
const MAX_PREVIEW_CHARS = 200_000;
const liveFace = (v: unknown): boolean => isRecord(v)
  && Array.isArray(v.box) && v.box.length === 4 && v.box.every(isFiniteNumber)
  && isFiniteNumber(v.score) && (v.confidence === undefined || isFiniteNumber(v.confidence))
  && (v.matches === undefined || (Array.isArray(v.matches) && v.matches.length <= 3 && v.matches.every((match) => isRecord(match) && isFiniteNumber(match.score)
    && (match.name === undefined || (typeof match.name === 'string' && match.name.length <= 80)))))
  && (v.name === undefined || v.name === null || (typeof v.name === 'string' && v.name.length <= 80))
  && (v.match === undefined || v.match === null || (isRecord(v.match) && isFiniteNumber(v.match.score)
    && (v.match.name === undefined || (typeof v.match.name === 'string' && v.match.name.length <= 80))));
const liveFaces = (v: unknown): boolean => Array.isArray(v) && v.length <= MAX_LIVE_FACES && v.every(liveFace);
const optFrameSide = (v: unknown): boolean => v === null || (isFiniteNumber(v) && (v as number) >= 0 && (v as number) <= 10_000);
/** Shown as is in the dashboards: the fields it names and nothing large. */
function isLiveStatus(v: unknown): boolean {
  return isRecord(v)
    && typeof v.micReady === 'boolean' && typeof v.micDenied === 'boolean' && isFiniteNumber(v.micLevel) && (v.micLevel as number) >= 0 && (v.micLevel as number) <= 1
    && typeof v.recording === 'boolean' && shortText(v.listenState) && typeof v.voiceLastTranscript === 'string' && v.voiceLastTranscript.length <= MAX_TEXT_CHARS
    && typeof v.audioPlaying === 'boolean' && typeof v.faceCameraActive === 'boolean' && typeof v.faceWorkerReady === 'boolean' && shortText(v.faceStatus)
    && isFiniteNumber(v.faceLastDetectedCount) && optFrameSide(v.faceFrameWidth) && optFrameSide(v.faceFrameHeight)
    && liveFaces(v.faceLastFaces);
}
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
    case 'people':
      return Array.isArray(m.people) && m.people.length <= 12 && m.people.every((person) => {
        if (!person || typeof person !== 'object') return false;
        const p = person as Record<string, unknown>;
        return text(p.id, MAX_ID_CHARS) && Array.isArray(p.names) && optNames(p.names)
          && (p.position === 'left' || p.position === 'center' || p.position === 'right') && optNumber(p.awayMs) && optNumber(p.snapshots)
          && (p.thumbnail === undefined || (typeof p.thumbnail === 'string' && p.thumbnail.length <= MAX_THUMBNAIL_CHARS && p.thumbnail.startsWith('data:image/jpeg;base64,')));
      });
    case 'proactive':
      return optString(m.context, MAX_TEXT_CHARS) && optNames(m.faces);
    case 'camera_frame':
      return frame(m.frame);
    case 'appearance_frame':
      return frame(m.frame) && optNames(m.faces) && optNumber(m.count) && optBoolean(m.returning) && optNumber(m.awayMs);
    case 'tts_request':
      return text(m.text, MAX_TEXT_CHARS) && optString(m.voice, MAX_ID_CHARS)
        && optString(m.turnId, MAX_ID_CHARS) && optString(m.requestId, MAX_ID_CHARS);
    case 'studio_look':
      return isActor(m.actor) && gaze(m.gaze);
    case 'studio_presence':
      return isActor(m.actor) && typeof m.present === 'boolean'
        && (m.people === undefined || (isFiniteNumber(m.people) && (m.people as number) >= 0));
    case 'studio_state':
      return isActor(m.actor) && typeof m.speaking === 'boolean' && text(m.expr, MAX_ID_CHARS) && mood(m.mood) && isFiniteNumber(m.ts);
    case 'studio_status':
      return isActor(m.actor) && typeof m.publishing === 'boolean' && optString(m.error, 300) && optMic(m.mic) && optCadence(m.cadence)
        && optDevices(m.devices);
    case 'studio_live':
      return isActor(m.actor) && typeof m.speaking === 'boolean' && (m.status === null || isLiveStatus(m.status));
    case 'studio_watch':
      return typeof m.live === 'boolean' && typeof m.video === 'boolean';
    case 'studio_frame':
      return isActor(m.actor) && typeof m.frame === 'string' && m.frame.length <= MAX_PREVIEW_CHARS && /^data:image\/jpeg;base64,/.test(m.frame)
        && isFiniteNumber(m.width) && isFiniteNumber(m.height) && (m.width as number) > 0 && (m.height as number) > 0;
    case 'studio_face_call':
      return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= MAX_ID_CHARS
        && (STUDIO_FACE_METHODS as readonly unknown[]).includes(m.method)
        && (m.args === undefined || isRecord(m.args));
    case 'studio_face_result':
      return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= MAX_ID_CHARS && typeof m.ok === 'boolean' && optString(m.error, 300);
    case 'studio_context':
      return isStudioContext(m);
    case 'studio_stage':
      return isActor(m.actor) && typeof m.ready === 'boolean';
    case 'studio_caption':
      return isActor(m.actor) && typeof m.turnId === 'string' && m.turnId.length <= MAX_ID_CHARS
        && typeof m.text === 'string' && m.text.length <= MAX_TEXT_CHARS
        && Number.isInteger(m.spoken) && (m.spoken as number) >= 0 && (m.spoken as number) <= m.text.length
        && typeof m.done === 'boolean' && isFiniteNumber(m.ts);
    default:
      return false;
  }
}

const shortText = (v: unknown): boolean => typeof v === 'string' && v.length <= 300;
/** Numbers, booleans and short strings only: it is shown as is in GET /studio. */
const optCadence = (v: unknown): boolean => v === undefined || (isRecord(v) && Object.keys(v).length <= 20
  && Object.values(v).every((value) => isFiniteNumber(value) || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 80)));
const optShortText = (v: unknown): boolean => v === null || shortText(v);

/** Loose on purpose (unknown fields are ignored, contract rule), strict on what is used. */
function isStudioContext(m: Record<string, unknown>): boolean {
  if (typeof m.reason !== 'string' || !isFiniteNumber(m.ts) || !isRecord(m.heads) || !Array.isArray(m.people)) return false;
  if (JSON.stringify(m).length > 200_000) return false;
  const heads = Object.values(m.heads);
  if (heads.length > 8 || !heads.every((h) => isRecord(h) && optShortText(h.zone ?? null) && optShortText(h.window ?? null) && typeof h.mode === 'string' && typeof h.speaking === 'boolean')) return false;
  if (m.people.length > 64 || !m.people.every((p) => isRecord(p) && shortText(p.id) && optShortText(p.zone ?? null) && optShortText(p.window ?? null)
    && isFiniteNumber(p.dwell) && typeof p.engaged === 'boolean'
    && (p.distance === null || p.distance === undefined || isFiniteNumber(p.distance))
    && (p.relation === null || p.relation === undefined || shortText(p.relation)))) return false;
  if (m.reference !== null && m.reference !== undefined && !(isRecord(m.reference) && shortText(m.reference.head) && shortText(m.reference.window))) return false;
  if (m.venue !== undefined) {
    const v = m.venue;
    if (!isRecord(v) || !Array.isArray(v.zones) || !Array.isArray(v.windows) || v.zones.length > 64 || v.windows.length > 128) return false;
    if (!v.zones.every((z) => isRecord(z) && shortText(z.id) && shortText(z.name) && typeof z.about === 'string')) return false;
    if (!v.windows.every((w) => isRecord(w) && shortText(w.id) && shortText(w.name) && typeof w.about === 'string')) return false;
  }
  return true;
}

export function isWsServerMessage(value: unknown): value is WsServerMessage {
  return hasString(value, 'type') && WS_SERVER_TYPES.has(value.type as WsServerMessage['type']);
}

/** The studio_* messages; only studio face pages act on them, every other page drops them. */
export function isWsStudioServerMessage(value: WsServerMessage): value is WsStudioServerMessage {
  return WS_STUDIO_SERVER_TYPES.has(value.type as WsStudioServerMessage['type']);
}
