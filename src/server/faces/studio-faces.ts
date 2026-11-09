// The studio's face recognition on the server (docs/face-service.md): the
// face service this server talks to (FACE_SERVICE), the camera it reads (the
// studio's visionSource), and what its frames mean (recognition.ts). ws/server.ts
// binds the hooks that reach the pages; index.ts starts and stops it.

import type { FaceObservation, FaceRecognizer, StudioFaceMethod, StudioFaceWorkerStatus } from '../../shared/contracts/studio.js';
import { parseVisionSource } from '../../shared/contracts/studio.js';
import { runtimeConfig } from '../config/runtime.js';
import { isInConversation } from '../assistant/turns.js';
import { siteLogin } from '../studio/site-auth.js';
import { forgetObservation } from '../studio/faces.js';
import { recognizerOf, studioSettings, type StudioSettings } from '../studio/state.js';
import { addFace, faceLibraryPath, readFaceLibrary } from './library.js';
import { createRecognition, type LiveFaceFields, type ListenerEffect } from './recognition.js';
import { MATCH_MARGIN, MATCH_THRESHOLD } from '../../client/face/matching.js';
import { createFaceServiceClient, DEFAULT_FACE_SERVICE_PORT, parseFaceServiceMode, type FaceServiceStatus } from './service.js';
import { statSync } from 'node:fs';
import type { EnrolledFace } from '../../shared/contracts/faces.js';

export interface RecognitionHooks {
  apply(message: ListenerEffect): void;
  publish(observation: FaceObservation): void;
  facesChanged(): void;
}

const port = Number.parseInt(process.env.FACE_SERVICE_PORT ?? '', 10) || DEFAULT_FACE_SERVICE_PORT;
const parsedMode = parseFaceServiceMode(process.env.FACE_SERVICE, port);
if (!parsedMode) console.error(`[faces] FACE_SERVICE is not off, local, an http(s) URL or fleet:faces: ${process.env.FACE_SERVICE}; recognition stays in the browser`);
const mode = parsedMode ?? { kind: 'off' as const };
// The rule in recognizerOf follows this, so a bad FACE_SERVICE leaves recognition in the browser.
studioSettings.faceService = mode.kind !== 'off';
const FPS = Math.min(15, Math.max(0.5, Number.parseFloat(process.env.FACE_SERVICE_FPS ?? '') || 5));
const RTSP_PORT = Number.parseInt(process.env.FACE_SERVICE_RTSP_PORT ?? '', 10) || 8554;

let hooks: RecognitionHooks = { apply: () => undefined, publish: () => undefined, facesChanged: () => undefined };
let recognizing = false;

/** The library, read again only when its file changes (each frame asks). */
let libraryCache: { mtimeMs: number; faces: EnrolledFace[] } | null = null;
function library(): EnrolledFace[] {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(faceLibraryPath).mtimeMs;
  } catch {
    // no library yet
  }
  if (!libraryCache || libraryCache.mtimeMs !== mtimeMs) libraryCache = { mtimeMs, faces: readFaceLibrary().faces };
  return libraryCache.faces;
}

const client = createFaceServiceClient({
  mode,
  onLine: (line) => {
    if (recognizing) recognition.handleLine(line);
  },
  onDown: (reason) => {
    if (reason && recognizing) recognition.lost(`the face service is not answering: ${reason}`);
  },
});

/** When the service last saw a face (StudioFaceWorkerStatus.lastFaceAt). */
let lastFaceAt: number | null = null;

const recognition = createRecognition({
  apply: (message) => hooks.apply(message),
  publish: (observation) => {
    if (observation.faces.length > 0) lastFaceAt = observation.t;
    hooks.publish(observation);
  },
  library,
  addFace: (face) => {
    addFace(face);
    libraryCache = null;
  },
  facesChanged: () => hooks.facesChanged(),
  inConversation: (now) => isInConversation(now),
  config: () => ({ ...runtimeConfig, faceRecognition: studioSettings.faceRecognition }),
  frame: (maxPx) => client.frame(maxPx),
  thumbnail: (track) => client.thumbnail(track),
  capture: () => client.capture(),
  where: () => client.status().where ?? (mode.kind === 'fleet' ? 'fleet:faces' : 'face service'),
});

export function bindRecognitionHooks(next: RecognitionHooks): void {
  hooks = next;
}

/** Who recognises now (studio settings plus FACE_SERVICE). */
export function recognizer(): FaceRecognizer {
  return recognizerOf(studioSettings);
}

/**
 * What the service should open for a vision source: the site node's RTSP for
 * site:<path> (with its read login, if it needs one), the URL for snapshot:.
 * The label is what the pages see; it never holds a login.
 */
export function cameraFor(settings: Pick<StudioSettings, 'site' | 'visionSource'>, readLogin: string | undefined, rtspPort = RTSP_PORT): { url: string; label: string } | null {
  const source = parseVisionSource(settings.visionSource);
  if (source?.kind === 'snapshot') return { url: source.url, label: settings.visionSource };
  if (source?.kind !== 'site') return null;
  const site = new URL(settings.site);
  let login = '';
  if (readLogin?.startsWith('Basic ')) {
    const [user, ...rest] = Buffer.from(readLogin.slice('Basic '.length), 'base64').toString('utf8').split(':');
    if (user && rest.length > 0) login = `${encodeURIComponent(user)}:${encodeURIComponent(rest.join(':'))}@`;
  }
  return { url: `rtsp://${login}${site.hostname}:${rtspPort}/${source.path}`, label: settings.visionSource };
}

/** Brings the service in line with the studio settings: startup and every change. */
export function syncFaceService(): void {
  if (mode.kind === 'off') return;
  const owns = recognizer() === 'service';
  if (recognizing && !owns) {
    // Switched off (camera, nothing to detect for, another source): nobody is in view, now.
    recognition.reset();
    forgetObservation();
  }
  recognizing = owns;
  const camera = owns ? cameraFor(studioSettings, siteLogin().read) : null;
  client.setSource(camera ? { ...camera, fps: FPS } : null);
}

export function startFaceService(): void {
  if (mode.kind === 'off') return;
  console.log(`[faces] face service: ${mode.kind === 'local' ? `local, port ${mode.port}` : mode.kind === 'url' ? mode.base : 'fleet:faces'}`);
  client.start();
  syncFaceService();
}

export async function stopFaceService(): Promise<void> {
  await client.stop();
}

export function faceServiceStatus(): FaceServiceStatus {
  return client.status();
}

/**
 * The face service as the listener page's face worker would report itself
 * (StudioFaceWorkerStatus), for the camera and recognition parts, the pulse and
 * /studio/vision while the service recognises; null otherwise.
 */
export function serviceFaceWorker(): StudioFaceWorkerStatus | null {
  if (!recognizing) return null;
  const { health, error } = client.status();
  const observation = recognition.observation();
  const best = observation?.faces.find((face) => face.decision === 'match') ?? observation?.faces[0] ?? null;
  const problem = !health ? `the face service is not answering${error ? `: ${error}` : ''}` : health.error;
  return {
    state: !health || health.error ? 'error' : health.state,
    ...(health?.state === 'loading' ? { detail: health.download ? `downloading ${health.download.file} ${health.download.pct ?? '?'}%` : 'loading models' } : {}),
    camera: health?.camera === 'ok',
    checksPerSecond: health?.fps ?? 0,
    lastCheckAt: observation?.t ?? null,
    lastFaceAt,
    faces: observation?.faces.length ?? 0,
    best: best ? { name: best.name ?? null, prob: best.candidates.find((c) => c.name === best.name)?.sim ?? best.candidates[0]?.sim ?? 0 } : null,
    ...(problem ? { error: problem.slice(0, 300) } : {}),
    ...(health?.backend ? { backend: health.backend } : {}),
    ...(health?.threads ? { threads: health.threads } : {}),
    source: studioSettings.visionSource,
    frameWidth: observation?.frame.w || null,
    frameHeight: observation?.frame.h || null,
    lastFrameAt: observation?.t ?? null,
    inferenceMs: health ? Math.round(health.inferMs) : null,
    threshold: MATCH_THRESHOLD,
    margin: MATCH_MARGIN,
  };
}

export function serviceLiveFaces(): LiveFaceFields | null {
  return recognizing ? recognition.liveFaces() : null;
}

export function serviceFaceCall(method: StudioFaceMethod, args: Record<string, unknown>): Promise<unknown> {
  return recognition.faceCall(method, args);
}

export function serviceAutoEnroll(personId: string, name: string): Promise<void> {
  return recognition.autoEnroll(personId, name);
}
