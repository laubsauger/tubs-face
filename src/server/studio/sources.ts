// GET /studio/sources (sentient-studio contract section 6, additive): every mic
// and vision source this server can find, for pick lists in the Studio tab and
// the sentient panel. Three places to look:
//   local     the listener page's input devices (its studio_status), plus the default
//   site      live paths on the site node, from its mediamtx API: with audio for the
//             mic, with video for vision (never our own faces or window streams)
//   snapshot  the depth cameras placed on the studio-manager floor plan (FLEET_HUB),
//             one JPEG each from depthcam-studio's /api/snapshot/color.jpg
// A place that does not answer adds nothing; the site node also adds a problem.

import type { StudioSource, StudioSourcesResponse } from '../../shared/contracts/studio.js';
import { loginHeader } from './site-auth.js';
import { listenerDevices, studioSettings, type StudioSettings } from './state.js';

const SITE_API_PORT = '9997';
const SITE_API_TIMEOUT_MS = 1500;
const HUB_TIMEOUT_MS = 2500;

// Track names as mediamtx gives them (tracks, tracks2[].codec).
const AUDIO_CODECS = new Set(['opus', 'mpeg-4 audio', 'mpeg-4 audio latm', 'mpeg-1/2 audio', 'ac-3', 'g711', 'g722', 'lpcm', 'speex', 'vorbis']);
const VIDEO_CODECS = new Set(['h264', 'h265', 'av1', 'vp8', 'vp9', 'mjpeg', 'mpeg-1/2 video', 'mpeg-4 video']);

interface SitePath {
  name: string;
  ready: boolean;
  tracks: string[];
}

export interface SourcesOptions {
  settings?: StudioSettings;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export async function listStudioSources(options: SourcesOptions = {}): Promise<StudioSourcesResponse> {
  const settings = options.settings ?? studioSettings;
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  const problems: string[] = [];
  const [paths, snapshots] = await Promise.all([
    sitePaths(siteApiBase(settings, env), doFetch, problems),
    env.FLEET_HUB?.trim() ? hubSnapshots(env.FLEET_HUB.trim().replace(/\/+$/, ''), doFetch) : Promise.resolve([]),
  ]);
  const listener = listenerDevices();
  const here = Boolean(listener?.connected);
  const devices = (labels: string[]): StudioSource[] => labels.map((label) => ({ value: `local:${label}`, label, kind: 'local', ready: here }));
  // Our own faces and the window streams (contract section 7) are not a room to hear or see.
  const ours = (name: string) => name.startsWith('tubs-') || (settings.prefix !== '' && name.startsWith(settings.prefix)) || name.startsWith('os-');
  const site = (has: Set<string>): StudioSource[] => paths
    .filter((path) => !ours(path.name) && path.tracks.some((track) => has.has(track.toLowerCase())))
    .map((path) => ({ value: `site:${path.name}`, label: path.name, kind: 'site', ready: path.ready, tracks: path.tracks }));
  const off: StudioSource = { value: 'off', label: 'Off', kind: 'off', ready: true };
  const mic: StudioSource[] = [
    off,
    { value: 'local', label: 'Default input', kind: 'local', ready: here },
    ...devices(listener?.devices.audio ?? []),
    ...site(AUDIO_CODECS),
  ];
  const vision: StudioSource[] = [
    off,
    { value: 'local', label: 'Default camera', kind: 'local', ready: here },
    ...devices(listener?.devices.video ?? []),
    ...site(VIDEO_CODECS),
    ...snapshots,
  ];
  const micPick = suggestion(mic, settings.micSource);
  const visionPick = suggestion(vision, settings.visionSource);
  return {
    micSource: settings.micSource,
    visionSource: settings.visionSource,
    mic,
    vision,
    suggested: { ...(micPick ? { mic: micPick } : {}), ...(visionPick ? { vision: visionPick } : {}) },
    problems,
  };
}

/** The only ready remote source, unless the current one is ready already (off never is). */
function suggestion(list: StudioSource[], current: string): StudioSource | undefined {
  if (list.some((source) => source.value === current && source.ready && source.kind !== 'off')) return undefined;
  const remote = list.filter((source) => (source.kind === 'site' || source.kind === 'snapshot') && source.ready);
  return remote.length === 1 ? remote[0] : undefined;
}

/** TUBS_STUDIO_SITE_API, else the site node's host on mediamtx's API port. Never with a login in it. */
function siteApiBase(settings: StudioSettings, env: NodeJS.ProcessEnv): string {
  const configured = env.TUBS_STUDIO_SITE_API?.trim();
  try {
    if (configured) {
      const url = new URL(configured);
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    }
    const url = new URL(settings.site);
    return `http://${url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname}:${SITE_API_PORT}`;
  } catch {
    return configured ?? settings.site;
  }
}

async function sitePaths(api: string, doFetch: typeof fetch, problems: string[]): Promise<SitePath[]> {
  // The API login if there is one, else the read login (the studio site may need either).
  const login = loginHeader('TUBS_STUDIO_SITE_API_AUTH') ?? loginHeader('TUBS_STUDIO_SITE_READ_AUTH');
  if (login && 'problem' in login) problems.push(login.problem);
  let response: Response;
  try {
    response = await doFetch(`${api}/v3/paths/list?itemsPerPage=1000`, {
      headers: login && 'header' in login ? { Authorization: login.header } : {},
      signal: AbortSignal.timeout(SITE_API_TIMEOUT_MS),
    });
  } catch (error) {
    problems.push(`site node API ${api} not answering (${error instanceof Error ? error.message : String(error)})`);
    return [];
  }
  if (response.status === 401 || response.status === 403) {
    problems.push(`site node API ${api} refused the login (${response.status}); set TUBS_STUDIO_SITE_API_AUTH to a file with its api login`);
    return [];
  }
  if (!response.ok) {
    problems.push(`site node API ${api} answered ${response.status}`);
    return [];
  }
  try {
    const body = (await response.json()) as { items?: unknown };
    if (!Array.isArray(body.items)) throw new Error('no items');
    return body.items.flatMap((item): SitePath[] => {
      if (typeof item !== 'object' || item === null) return [];
      const path = item as { name?: unknown; ready?: unknown; tracks?: unknown; tracks2?: unknown };
      if (typeof path.name !== 'string' || !path.name) return [];
      const tracks = Array.isArray(path.tracks2)
        ? path.tracks2.map((track: unknown) => (track as { codec?: unknown } | null)?.codec)
        : Array.isArray(path.tracks) ? path.tracks : [];
      return [{ name: path.name, ready: path.ready === true, tracks: tracks.filter((track): track is string => typeof track === 'string') }];
    }).sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name));
  } catch {
    problems.push(`site node API ${api} sent something that is not a mediamtx path list`);
    return [];
  }
}

interface HubPlaceable {
  kind?: unknown;
  label?: unknown;
  node?: unknown;
  service?: unknown;
  at?: unknown;
}

interface HubNode {
  name?: unknown;
  online?: unknown;
  services?: Array<{ name?: unknown; base?: unknown; healthy?: unknown }>;
}

/** The floor plan's placed depth cameras and their snapshot URLs; nothing when the hub does not answer. */
async function hubSnapshots(hub: string, doFetch: typeof fetch): Promise<StudioSource[]> {
  const get = async <T>(path: string): Promise<T> => {
    const response = await doFetch(`${hub}${path}`, { signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`hub answered ${response.status}`);
    return (await response.json()) as T;
  };
  try {
    const [plan, fleet] = await Promise.all([
      get<{ placeables?: HubPlaceable[] }>('/api/floorplan'),
      get<{ nodes?: HubNode[] }>('/api/fleet'),
    ]);
    return (plan.placeables ?? []).flatMap((cam): StudioSource[] => {
      if (cam.kind !== 'depthcam' || !cam.at || typeof cam.node !== 'string' || typeof cam.service !== 'string') return [];
      const node = (fleet.nodes ?? []).find((candidate) => candidate.name === cam.node);
      const row = node?.services?.find((candidate) => candidate.name === cam.service);
      if (typeof row?.base !== 'string' || !row.base) return [];
      const url = `${row.base.replace(/\/+$/, '')}/api/snapshot/color.jpg`;
      return [{
        value: `snapshot:${url}`,
        label: typeof cam.label === 'string' && cam.label ? cam.label : `${cam.node}/${cam.service}`,
        kind: 'snapshot',
        ready: row.healthy === true && node?.online !== false,
      }];
    });
  } catch {
    return [];
  }
}
