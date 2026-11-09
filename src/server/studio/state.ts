// Studio mode settings and what the face pages report about their streams.
// No sockets or processes here: control.ts applies changes, ws/server.ts
// feeds in the page reports.

import {
  STUDIO_ACTORS,
  parseMicSource,
  parseVisionSource,
  type FaceRecognizer,
  type StudioActor,
  type StudioCadence,
  type StudioDevices,
  type StudioFaceWorkerStatus,
  type StudioLaunchMode,
  type StudioMicStatus,
  type StudioResponse,
  type StudioSwitches,
  type StudioWindowsMode,
} from '../../shared/contracts/studio.js';
import type { WsStudioConfigServerMessage } from '../../shared/contracts/ws.js';
import { siteLoginProblem } from './site-auth.js';
import { runtimeConfig } from '../config/runtime.js';

export const DEFAULT_STUDIO_SITE = 'http://127.0.0.1:8889';

export interface StudioSettings {
  enabled: boolean;
  /** Site node base URL, no trailing slash. */
  site: string;
  micSource: string;
  visionSource: string;
  /** Stream path prefix: "tubs-" gives tubs-main and tubs-small. */
  prefix: string;
  launch: StudioLaunchMode;
  /** FACE_SERVICE is set (not off): the face service recognises what the server can read (docs/face-service.md). */
  faceService?: boolean;
  /** Switches (StudioSwitches) kept here; descriptions and relationships are runtime config. */
  cameraOn: boolean;
  micOn: boolean;
  faceRecognition: boolean;
  /** TUBS_STUDIO_WINDOWS: the launched face pages' windows off screen (default) or on screen. */
  windows: StudioWindowsMode;
}

/** Env defaults. Studio mode is off unless TUBS_STUDIO says otherwise. */
export function studioSettingsFromEnv(env: NodeJS.ProcessEnv): StudioSettings {
  const site = normalizeSite(env.TUBS_STUDIO_SITE?.trim() || DEFAULT_STUDIO_SITE);
  const micSource = env.TUBS_MIC_SOURCE?.trim() || 'local';
  // Off unless asked for: a studio camera is a choice, not a default.
  const visionSource = env.TUBS_VISION_SOURCE?.trim() || 'off';
  const prefix = env.TUBS_STUDIO_PREFIX?.trim() || 'tubs-';
  if (!site) throw new Error(`TUBS_STUDIO_SITE is not an http(s) URL: ${env.TUBS_STUDIO_SITE}`);
  if (!parseMicSource(micSource)) throw new Error(`TUBS_MIC_SOURCE is not local, local:<label>, site:<path> or off: ${micSource}`);
  if (!parseVisionSource(visionSource)) throw new Error(`TUBS_VISION_SOURCE is not local, local:<label>, snapshot:<url>, site:<path> or off: ${visionSource}`);
  if (!/^[A-Za-z0-9_.-]*$/.test(prefix)) throw new Error(`TUBS_STUDIO_PREFIX may only hold letters, digits and _ . -: ${prefix}`);
  return {
    enabled: /^(1|true|yes|on)$/i.test(env.TUBS_STUDIO?.trim() ?? ''),
    site,
    micSource,
    visionSource,
    prefix,
    launch: env.TUBS_STUDIO_LAUNCH?.trim() === 'external' ? 'external' : 'chrome',
    faceService: Boolean(env.FACE_SERVICE?.trim()) && env.FACE_SERVICE?.trim() !== 'off',
    cameraOn: true,
    micOn: true,
    faceRecognition: !/^(0|false|no|off)$/i.test(env.TUBS_FACE_RECOGNITION?.trim() ?? ''),
    windows: env.TUBS_STUDIO_WINDOWS?.trim() === 'visible' ? 'visible' : 'offscreen',
  };
}

/**
 * Who recognises the studio camera's faces: the face service for a camera the
 * server can read (a site stream, a snapshot URL), the listener page's browser
 * worker for a local camera or without FACE_SERVICE, nobody without a camera.
 */
export function recognizerOf(settings: StudioSettings = studioSettings, descriptions = runtimeConfig.visionDescriptions): FaceRecognizer {
  const source = parseVisionSource(settings.visionSource);
  if (!settings.enabled || !settings.cameraOn || !source || source.kind === 'off') return 'off';
  // Faces are detected while recognition or descriptions (which need a face in view) is on.
  if (!settings.faceRecognition && !descriptions) return 'off';
  return settings.faceService && (source.kind === 'site' || source.kind === 'snapshot') ? 'service' : 'browser';
}

export const studioSettings: StudioSettings = studioSettingsFromEnv(process.env);

export function streamName(actor: StudioActor, settings: Pick<StudioSettings, 'prefix'> = studioSettings): string {
  return `${settings.prefix}${actor}`;
}

/** What the face pages are told: on connect and after every change. */
export function studioConfigMessage(settings: StudioSettings = studioSettings): WsStudioConfigServerMessage {
  return {
    type: 'studio_config',
    enabled: settings.enabled,
    site: settings.site,
    micSource: settings.micSource,
    visionSource: settings.visionSource,
    streams: { main: streamName('main', settings), small: streamName('small', settings) },
    // Absent: the browser worker, as before.
    ...(recognizerOf(settings) === 'service' ? { faces: 'service' as const } : {}),
    switches: { camera: settings.cameraOn, faceRecognition: settings.faceRecognition, mic: settings.micOn },
  };
}

/**
 * Validates a POST /studio body and applies it. Throws a BadRequestError (and
 * changes nothing) when any field is invalid. Returns which fields changed.
 */
export function applyStudioPatch(patch: unknown, settings: StudioSettings = studioSettings): Array<keyof StudioSettings> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw badRequest('Body must be a JSON object');
  const body = patch as Record<string, unknown>;
  const next: Partial<Pick<StudioSettings, 'enabled' | 'site' | 'micSource' | 'visionSource' | 'cameraOn' | 'micOn' | 'faceRecognition' | 'windows'>> = {};
  if (body.switches !== undefined) {
    const switches = studioSwitchesPatch(body.switches);
    if (switches.camera !== undefined) next.cameraOn = switches.camera;
    if (switches.mic !== undefined) next.micOn = switches.mic;
    if (switches.faceRecognition !== undefined) next.faceRecognition = switches.faceRecognition;
  }
  if (body.windows !== undefined) {
    if (body.windows !== 'offscreen' && body.windows !== 'visible') throw badRequest('windows must be offscreen or visible');
    next.windows = body.windows;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be true or false');
    next.enabled = body.enabled;
  }
  if (body.site !== undefined) {
    const site = typeof body.site === 'string' ? normalizeSite(body.site) : null;
    if (!site) throw badRequest('site must be an http(s) URL, e.g. http://127.0.0.1:8889');
    next.site = site;
  }
  if (body.micSource !== undefined) {
    if (!parseMicSource(body.micSource)) throw badRequest('micSource must be local, local:<device label>, site:<path> or off');
    next.micSource = body.micSource as string;
  }
  if (body.visionSource !== undefined) {
    if (!parseVisionSource(body.visionSource)) throw badRequest('visionSource must be local, local:<device label>, snapshot:<url>, site:<path> or off');
    next.visionSource = body.visionSource as string;
  }
  const changed = (Object.keys(next) as Array<keyof typeof next>).filter((key) => next[key] !== settings[key]);
  Object.assign(settings, next);
  return changed;
}

interface PageReport {
  publishing: boolean;
  error?: string;
  mic?: StudioMicStatus;
  cadence?: StudioCadence;
  devices?: StudioDevices;
  faceWorker?: StudioFaceWorkerStatus;
  /** Set while the page's socket is open. */
  connected: boolean;
}

const pages = new Map<StudioActor, PageReport>();
const launcherErrors = new Map<StudioActor, string>();

/** A studio page's socket opened or closed. A closed page publishes nothing. */
export function notePageConnection(actor: StudioActor, connected: boolean): void {
  const report = pages.get(actor);
  if (connected) {
    pages.set(actor, { ...(report ?? { publishing: false }), connected: true });
    return;
  }
  if (report) {
    pages.set(actor, {
      publishing: false,
      connected: false,
      ...(report.mic ? { mic: { ...report.mic, listening: false } } : {}),
      ...(report.devices ? { devices: report.devices } : {}),
    });
  }
}

export function notePageStatus(actor: StudioActor, status: { publishing: boolean; error?: string; mic?: StudioMicStatus; cadence?: StudioCadence; devices?: StudioDevices; faceWorker?: StudioFaceWorkerStatus }): void {
  const before = pages.get(actor);
  pages.set(actor, {
    connected: true,
    publishing: status.publishing,
    ...(status.error ? { error: status.error } : {}),
    ...(status.mic ? { mic: status.mic } : (before?.mic ? { mic: before.mic } : {})),
    ...(status.cadence ? { cadence: status.cadence } : (before?.cadence ? { cadence: before.cadence } : {})),
    ...(status.devices ? { devices: status.devices } : (before?.devices ? { devices: before.devices } : {})),
    ...(status.faceWorker ? { faceWorker: status.faceWorker } : (before?.faceWorker ? { faceWorker: before.faceWorker } : {})),
  });
}

/** The listener page's face worker as it last reported it; null while that page is not connected. */
export function listenerFaceWorker(): StudioFaceWorkerStatus | null {
  const report = pages.get('main');
  return report?.connected && report.faceWorker ? report.faceWorker : null;
}

/** The input devices the listener page (main) last reported, and whether it is still connected. */
export function listenerDevices(): { devices: StudioDevices; connected: boolean } | null {
  const report = pages.get('main');
  return report?.devices ? { devices: report.devices, connected: report.connected } : null;
}

/** Any face page still says its stream is up. */
export function anyPagePublishing(): boolean {
  return [...pages.values()].some((report) => report.connected && report.publishing);
}

/** The launcher could not run this actor's page (Chrome missing, exited); undefined clears it. */
export function noteLauncherError(actor: StudioActor, error: string | undefined): void {
  if (error) launcherErrors.set(actor, error);
  else launcherErrors.delete(actor);
}

export function resetStudioReports(): void {
  pages.clear();
  launcherErrors.clear();
}

export function toStudioResponse(settings: StudioSettings = studioSettings): StudioResponse {
  const actors = STUDIO_ACTORS.map((id) => {
    const report = pages.get(id);
    const publishing = settings.enabled && Boolean(report?.connected && report.publishing);
    const error = !settings.enabled
      ? undefined
      : launcherErrors.get(id) ?? siteLoginProblem() ?? (report?.connected ? report.error : 'face page not connected');
    return { id, stream: streamName(id, settings), publishing, ...(error && !publishing ? { error } : {}), ...(settings.enabled && report?.connected && report.cadence ? { cadence: report.cadence } : {}) };
  });
  // The main page is the listener (see client/studio/runtime.ts).
  const mic = pages.get('main')?.mic;
  return {
    enabled: settings.enabled,
    site: settings.site,
    micSource: settings.micSource,
    visionSource: settings.visionSource,
    actors,
    launch: settings.launch,
    ...(settings.enabled && mic ? { mic } : {}),
    switches: {
      camera: settings.cameraOn,
      faceRecognition: settings.faceRecognition,
      visionDescriptions: runtimeConfig.visionDescriptions,
      relationships: runtimeConfig.relationshipsEnabled,
      mic: settings.micOn,
    },
    windows: settings.windows,
  };
}

const SWITCHES = ['camera', 'faceRecognition', 'visionDescriptions', 'relationships', 'mic'] as const;

/** A switches patch: known names, true or false; anything else is a BadRequestError. */
export function studioSwitchesPatch(value: unknown): Partial<StudioSwitches> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('switches must be an object');
  const out: Partial<StudioSwitches> = {};
  for (const [key, on] of Object.entries(value)) {
    if (!(SWITCHES as readonly string[]).includes(key)) throw badRequest(`unknown switch ${key} (there are: ${SWITCHES.join(', ')})`);
    if (typeof on !== 'boolean') throw badRequest(`switches.${key} must be true or false`);
    out[key as keyof StudioSwitches] = on;
  }
  return out;
}

function normalizeSite(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = 'BadRequestError';
  return error;
}
