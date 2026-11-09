// Studio mode (sentient-studio docs/contract.md, sections 5 and 6): each face is
// rendered on its own page and published to the site node (mediamtx) over
// WHIP, the mic can come from the site node, and an external director drives
// gaze and presence over the existing /ws socket. Off by default.

export type StudioActor = 'main' | 'small';
export const STUDIO_ACTORS: readonly StudioActor[] = ['main', 'small'];

/**
 * Where the studio listener hears the room:
 *   local            the default input device of this box
 *   local:<label>    that input device, by exact label
 *   site:<path>      the audio of a site node stream, over WHEP (<site>/<path>/whep)
 *   off              no listening
 */
export type MicSourceSpec =
  | { kind: 'local'; label?: string }
  | { kind: 'site'; path: string }
  | { kind: 'off' };

// mediamtx path names: letters, digits and _ - . / (no leading or trailing slash).
const SITE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MAX_LABEL_CHARS = 200;

/** null for anything that is not a valid source; never a guess at the default mic. */
export function parseMicSource(value: unknown): MicSourceSpec | null {
  if (typeof value !== 'string') return null;
  if (value === 'local') return { kind: 'local' };
  if (value === 'off') return { kind: 'off' };
  if (value.startsWith('local:')) {
    const label = value.slice('local:'.length);
    return label.trim() && label.length <= MAX_LABEL_CHARS ? { kind: 'local', label } : null;
  }
  if (value.startsWith('site:')) {
    const path = value.slice('site:'.length);
    // "." and ".." would point the WHEP URL at another path on the site node.
    const valid = SITE_PATH.test(path) && path.split('/').every((segment) => segment !== '.' && segment !== '..');
    return valid ? { kind: 'site', path } : null;
  }
  return null;
}

export function formatMicSource(spec: MicSourceSpec): string {
  switch (spec.kind) {
    case 'local':
      return spec.label ? `local:${spec.label}` : 'local';
    case 'site':
      return `site:${spec.path}`;
    case 'off':
      return 'off';
  }
}

/**
 * Where Tubs' pictures come from (docs/vision.md), same grammar as the mic:
 *   local            the camera of the page that owns vision
 *   local:<label>    that camera, by exact label
 *   snapshot:<url>   one JPEG from this URL per picture (nothing streams in between)
 *   site:<path>      the video of a site node stream, over WHEP only while a picture is taken
 *   off              no pictures
 */
export type VisionSourceSpec =
  | { kind: 'local'; label?: string }
  | { kind: 'snapshot'; url: string }
  | { kind: 'site'; path: string }
  | { kind: 'off' };

export function parseVisionSource(value: unknown): VisionSourceSpec | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('snapshot:')) {
    const url = value.slice('snapshot:'.length);
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? { kind: 'snapshot', url } : null;
    } catch {
      return null;
    }
  }
  // local, local:<label>, site:<path> and off read as for the mic.
  const like = parseMicSource(value);
  return like;
}

export function formatVisionSource(spec: VisionSourceSpec): string {
  return spec.kind === 'snapshot' ? `snapshot:${spec.url}` : formatMicSource(spec);
}

/** GET /studio, and the reply to POST /studio. */
export interface StudioResponse {
  enabled: boolean;
  /** Site node base URL, e.g. http://127.0.0.1:8889. */
  site: string;
  micSource: string;
  visionSource: string;
  actors: StudioActorStatus[];
  /** Who opens the face pages: this server ('chrome') or something else ('external'). */
  launch: StudioLaunchMode;
  /** What the listener page reports about the mic; absent until it has. */
  mic?: StudioMicStatus;
  /** Pages for the operator: this server's dashboard and its memory view. */
  ui?: StudioUiLinks;
  /** Character presets: their names and the active one (GET /presets). */
  presets?: { names: string[]; active: string | null };
}

export interface StudioUiLinks {
  dashboard: string;
  memory: string;
}

export interface StudioActorStatus {
  id: StudioActor;
  /** Site node path the face is published to, e.g. "tubs-main". */
  stream: string;
  publishing: boolean;
  error?: string;
  /** How steadily the face page renders and publishes (its last report). */
  cadence?: StudioCadence;
}

/** A face page's frame cadence over its last report window (studio/cadence.ts, studio/publisher.ts). */
export interface StudioCadence {
  renderFps: number;
  renderMaxGapMs: number;
  /** Render gaps over 50 ms. */
  renderStalls: number;
  sourceFps?: number;
  encodedFps?: number;
  keyFrames?: number;
  limitedBy?: string;
  encoder?: string;
  encodeMsPerFrame?: number;
  frameWidth?: number;
  /** Audio packets sent per second (Opus, 20 ms each: 50). */
  audioPacketsPerSecond?: number;
  /** Holes inside a streamed reply (a piece came after the one before had played), and the largest. */
  speechHoles?: number;
  speechMaxHoleMs?: number;
  /** Time replies were held back until enough of them was here to play through. */
  speechHeldMs?: number;
  /** Audio seconds the TTS delivers per second, as last measured (below 1: slower than speech). */
  ttsRate?: number;
  visible: boolean;
  focused: boolean;
}

export interface StudioMicStatus {
  source: string;
  listening: boolean;
  error?: string;
}

export type StudioLaunchMode = 'chrome' | 'external';

/** The listener page's input devices, by label as Chrome names them (its studio_status). */
export interface StudioDevices {
  audio: string[];
  video: string[];
}

export type StudioSourceKind = 'off' | 'local' | 'site' | 'snapshot';

/** One thing micSource or visionSource can be set to (GET /studio/sources). */
export interface StudioSource {
  /** What POST /studio takes, e.g. "site:cam-flo-mac". */
  value: string;
  label: string;
  kind: StudioSourceKind;
  /**
   * Usable now: local, the listener page is connected and has the device;
   * site, the path is publishing; snapshot, the depth camera's service is healthy.
   */
  ready: boolean;
  /** site only: the stream's tracks as the site node names them, e.g. ["H264", "Opus"]. */
  tracks?: string[];
}

/**
 * GET /studio/sources (sentient-studio contract section 6, additive): everything
 * the mic and the vision source can be set to that this server can find, so
 * nobody has to remember path names. Typed values stay allowed in POST /studio.
 */
export interface StudioSourcesResponse {
  /** The current values, as in GET /studio. */
  micSource: string;
  visionSource: string;
  /** off, then this box's devices (local), then site streams with audio. */
  mic: StudioSource[];
  /** off, then this box's cameras (local), site streams with video, depth camera snapshots. */
  vision: StudioSource[];
  /** The one obvious pick, when there is exactly one ready remote source and the current one is not ready. */
  suggested: { mic?: StudioSource; vision?: StudioSource };
  /** Why something may be missing, e.g. the site node's API did not answer. Never a secret. */
  problems: string[];
}

/** POST /studio */
export interface StudioPatch {
  enabled?: boolean;
  site?: string;
  micSource?: string;
  visionSource?: string;
}

/** Face space as the director sends it: -1..1, x right, y up. */
export type StudioGaze = [number, number];

export interface StudioMood {
  pos: number;
  neg: number;
  arousal: number;
}
