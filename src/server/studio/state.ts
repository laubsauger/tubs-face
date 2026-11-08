// Studio mode settings and what the face pages report about their streams.
// No sockets or processes here: control.ts applies changes, ws/server.ts
// feeds in the page reports.

import {
  STUDIO_ACTORS,
  parseMicSource,
  parseVisionSource,
  type StudioActor,
  type StudioLaunchMode,
  type StudioMicStatus,
  type StudioPatch,
  type StudioResponse,
} from '../../shared/contracts/studio.js';
import type { WsStudioConfigServerMessage } from '../../shared/contracts/ws.js';

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
  };
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
  };
}

/**
 * Validates a POST /studio body and applies it. Throws a BadRequestError (and
 * changes nothing) when any field is invalid. Returns which fields changed.
 */
export function applyStudioPatch(patch: unknown, settings: StudioSettings = studioSettings): Array<keyof StudioPatch> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw badRequest('Body must be a JSON object');
  const body = patch as Record<string, unknown>;
  const next: Partial<Pick<StudioSettings, 'enabled' | 'site' | 'micSource' | 'visionSource'>> = {};
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
  if (report) pages.set(actor, { publishing: false, connected: false, ...(report.mic ? { mic: { ...report.mic, listening: false } } : {}) });
}

export function notePageStatus(actor: StudioActor, status: { publishing: boolean; error?: string; mic?: StudioMicStatus }): void {
  pages.set(actor, {
    connected: true,
    publishing: status.publishing,
    ...(status.error ? { error: status.error } : {}),
    ...(status.mic ? { mic: status.mic } : (pages.get(actor)?.mic ? { mic: pages.get(actor)!.mic! } : {})),
  });
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
      : launcherErrors.get(id) ?? (report?.connected ? report.error : 'face page not connected');
    return { id, stream: streamName(id, settings), publishing, ...(error && !publishing ? { error } : {}) };
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
  };
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
