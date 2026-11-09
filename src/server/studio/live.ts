// The studio listener's live state for the dashboards, which have no mic or
// camera of their own in studio mode: what it hears and sees (studio_live,
// ~10 Hz), its camera (studio_frame, a few small JPEGs a second) and the pulse
// (studio/pulse.ts). It costs nothing while nobody watches: a dashboard says
// what it shows (studio_watch), a GET /studio/pulse counts for a few seconds,
// and the listener sends only what someone wants.

import type { StudioFaceWorkerStatus, StudioLiveFace, StudioLiveStatus } from '../../shared/contracts/studio.js';
import type { WsStudioLiveClientMessage, WsStudioLiveServerMessage, WsStudioWatchServerMessage } from '../../shared/contracts/ws.js';
import type { LiveFaceFields } from '../faces/recognition.js';

/** Reports closer together than this are dropped (the page sends ~10 Hz). */
export const RELAY_MIN_MS = 50;
/** Frames closer together than this are dropped (the page sends a few a second). */
export const FRAME_MIN_MS = 100;
/** How long one GET /studio/pulse keeps the listener reporting. */
export const PULSE_LEASE_MS = 3000;

export interface Watch {
  live: boolean;
  video: boolean;
}

let last: StudioLiveStatus | null = null;
let lastSpeaking = false;
let lastRelayAt = 0;
/**
 * While the face service recognises (docs/face-service.md), the faces come
 * from the server, not from the listener page: they replace the page's face
 * fields, with or without a report from the page.
 */
let serverFaces: (() => LiveFaceFields | null) | null = null;
let serverFaceWorker: (() => StudioFaceWorkerStatus | null) | null = null;
/** The listener as it is before it reports anything: no mic, no camera. */
const SILENT_LISTENER: StudioLiveStatus = {
  micReady: false,
  micDenied: false,
  micLevel: 0,
  recording: false,
  listenState: '',
  voiceLastTranscript: '',
  audioPlaying: false,
  faceCameraActive: false,
  faceWorkerReady: false,
  faceWorkerBusy: false,
  faceStatus: '',
  faceLastInferenceMs: null,
  faceLastEmbeddingsExtracted: 0,
  faceLastEmbeddingsReused: 0,
  faceLastDetectedCount: 0,
  faceFrameWidth: null,
  faceFrameHeight: null,
  faceLastFaces: [],
};

function withServerFaces(status: StudioLiveStatus | null): StudioLiveStatus | null {
  const faces = serverFaces?.() ?? null;
  return faces ? { ...(status ?? SILENT_LISTENER), ...faces } : status;
}

/** Where the faces (and the face worker's status) come from while the face service recognises; null: from the listener page. */
export function useServerFaces(source: (() => LiveFaceFields | null) | null, worker: (() => StudioFaceWorkerStatus | null) | null = null): void {
  serverFaces = source;
  serverFaceWorker = worker;
}
let lastFrameAt = 0;
const watchers = new Map<unknown, Watch>();
let pulseLeaseUntil = 0;

function liveFace(face: StudioLiveFace): StudioLiveFace {
  const match = (entry: { name?: string; score: number }) => ({ ...(entry.name !== undefined ? { name: entry.name } : {}), score: entry.score });
  return {
    box: [face.box[0], face.box[1], face.box[2], face.box[3]],
    score: face.score,
    ...(face.confidence !== undefined ? { confidence: face.confidence } : {}),
    ...(face.name !== undefined ? { name: face.name } : {}),
    ...(face.match ? { match: match(face.match) } : face.match === null ? { match: null } : {}),
    ...(face.matches ? { matches: face.matches.map(match) } : {}),
    ...(face.decision ? { decision: face.decision } : {}),
  };
}

/** Only the fields the dashboard shows, whatever else the page sent. */
function copyStatus(status: StudioLiveStatus): StudioLiveStatus {
  return {
    micReady: status.micReady,
    micDenied: status.micDenied,
    micLevel: status.micLevel,
    recording: status.recording,
    listenState: status.listenState,
    voiceLastTranscript: status.voiceLastTranscript,
    audioPlaying: status.audioPlaying,
    faceCameraActive: status.faceCameraActive,
    faceWorkerReady: status.faceWorkerReady,
    faceWorkerBusy: status.faceWorkerBusy,
    faceStatus: status.faceStatus,
    faceLastInferenceMs: status.faceLastInferenceMs,
    faceLastEmbeddingsExtracted: status.faceLastEmbeddingsExtracted,
    faceLastEmbeddingsReused: status.faceLastEmbeddingsReused,
    faceLastDetectedCount: status.faceLastDetectedCount,
    faceFrameWidth: status.faceFrameWidth,
    faceFrameHeight: status.faceFrameHeight,
    faceLastFaces: status.faceLastFaces.map(liveFace),
  };
}

/** The message to relay for this report, or null to drop it (too soon after the last). A stop always goes. */
export function liveRelay(message: WsStudioLiveClientMessage, now = Date.now()): WsStudioLiveServerMessage | null {
  if (message.status && now - lastRelayAt < RELAY_MIN_MS) return null;
  lastRelayAt = now;
  last = message.status ? copyStatus(message.status) : null;
  lastSpeaking = message.status ? message.speaking : false;
  const faceWorker = message.status ? serverFaceWorker?.() ?? message.faceWorker : undefined;
  return {
    type: 'studio_live',
    actor: message.actor,
    status: last ? withServerFaces(last) : null,
    speaking: lastSpeaking,
    ...(faceWorker ? { faceWorker } : {}),
  };
}

/** A relay for the server's own faces (each face service frame), or null when the last went out too recently. */
export function serverFacesRelay(now = Date.now()): WsStudioLiveServerMessage | null {
  const status = withServerFaces(last);
  if (!status || !serverFaces?.() || now - lastRelayAt < RELAY_MIN_MS) return null;
  lastRelayAt = now;
  const faceWorker = serverFaceWorker?.() ?? null;
  return { type: 'studio_live', actor: 'main', status, speaking: lastSpeaking, ...(faceWorker ? { faceWorker } : {}) };
}

/** Whether this frame goes out (at most one per FRAME_MIN_MS). */
export function frameDue(now = Date.now()): boolean {
  if (now - lastFrameAt < FRAME_MIN_MS) return false;
  lastFrameAt = now;
  return true;
}

/** The listener's last report (with the server's faces while the face service recognises); null once it stopped or went away. */
export function lastLiveStatus(): StudioLiveStatus | null {
  return withServerFaces(last);
}

/** The listener page is gone: what it last said no longer holds. */
export function liveGone(): WsStudioLiveServerMessage {
  last = null;
  lastSpeaking = false;
  lastRelayAt = 0;
  // The server's faces stay: they never came from the page.
  return { type: 'studio_live', actor: 'main', status: withServerFaces(null), speaking: false };
}

/** A dashboard shows (or stopped showing) the live state and the camera. */
export function noteWatch(viewer: unknown, watch: Watch): void {
  if (watch.live || watch.video) watchers.set(viewer, { live: watch.live || watch.video, video: watch.video });
  else watchers.delete(viewer);
}

export function forgetViewer(viewer: unknown): void {
  watchers.delete(viewer);
}

export function watchOf(viewer: unknown): Watch | null {
  return watchers.get(viewer) ?? null;
}

/** Someone polls GET /studio/pulse: keep the listener reporting for PULSE_LEASE_MS. */
export function notePulsePoll(now = Date.now()): void {
  pulseLeaseUntil = now + PULSE_LEASE_MS;
}

export function pulseLeaseEndsAt(): number {
  return pulseLeaseUntil;
}

/** What the listener should send now. */
export function wantedWatch(now = Date.now()): WsStudioWatchServerMessage {
  const all = [...watchers.values()];
  return {
    type: 'studio_watch',
    live: now < pulseLeaseUntil || all.some((watch) => watch.live),
    video: all.some((watch) => watch.video),
  };
}

/** Tests: forget every watcher, lease and report. */
export function resetLive(): void {
  watchers.clear();
  pulseLeaseUntil = 0;
  last = null;
  lastSpeaking = false;
  lastRelayAt = 0;
  lastFrameAt = 0;
  serverFaces = null;
  serverFaceWorker = null;
}
