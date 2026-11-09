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
  /** What runs where (the Studio tab's card, the sentient panel). Keep this shape. */
  parts?: StudioPart[];
}

/**
 * One part of the studio's Tubs: where the work happens (host or host:port,
 * fleet:vision resolved to its box, the mic's device or site path, the face
 * pages' machine), whether it works (null: not in use, or not known yet) and a
 * short detail (model, latency, voices, fps).
 */
export interface StudioPart {
  id: 'brain' | 'voices' | 'realtime' | 'vision' | 'mic' | 'faces' | 'site';
  label: string;
  where: string;
  ok: boolean | null;
  detail?: string;
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

/** A face the listener page sees, as its detector reports it, without the embedding. */
export interface StudioLiveFace {
  /** x1, y1, x2, y2 in the picture's pixels (faceFrameWidth x faceFrameHeight). */
  box: [number, number, number, number];
  score: number;
  confidence?: number;
  name?: string | null;
  /** The face library's best match and how sure it is (0..1). */
  match?: { name?: string; score: number } | null;
  /** The top candidates, best first (at most 3). */
  matches?: Array<{ name?: string; score: number }>;
}

/**
 * What the studio listener page hears and sees, for the dashboards (the
 * studio_live relay, about 10 Hz): the same app state fields the face window
 * shares with a dashboard in the same browser, so the dashboard's own meters
 * and detection lists show it. null: the listener stopped (studio mode off).
 */
export interface StudioLiveStatus {
  micReady: boolean;
  micDenied: boolean;
  /** 0..1 */
  micLevel: number;
  recording: boolean;
  listenState: string;
  voiceLastTranscript: string;
  /** Main's voice is playing on the listener page. */
  audioPlaying: boolean;
  faceCameraActive: boolean;
  faceWorkerReady: boolean;
  faceStatus: string;
  faceLastDetectedCount: number;
  faceFrameWidth: number | null;
  faceFrameHeight: number | null;
  faceLastFaces: StudioLiveFace[];
}

/** What the mic is doing: off, waiting for speech, taking someone's speech, waiting for the reply, a head talking. */
export type StudioListenState = 'off' | 'listening' | 'hearing' | 'thinking' | 'speaking';

/**
 * GET /studio/pulse (and the studio_pulse push): the studio at a glance, for
 * the dashboard and the sentient panel's pulse bar; poll about 4 Hz. Keep
 * this shape: the panel builds on it.
 */
export interface StudioPulse {
  /** When this was put together (ms since epoch). */
  t: number;
  /** level 0..1; source as micSource. */
  mic: { source: string; level: number; state: StudioListenState };
  speaking: 'main' | 'small' | null;
  /** The last line the mic heard. */
  heard: { text: string; t: number } | null;
  /** Who is in view now: the library's best match (null: unknown), how sure (0..1), box [x, y, w, h] in 0..1 of the picture. */
  seen: Array<{ name: string | null; prob: number; box: [number, number, number, number] }>;
  /** The last vision check: how long the provider took and when. */
  vision: { provider: string; lastMs: number | null; at: number | null };
}

/**
 * What a dashboard may ask the studio listener's face runtime to do
 * (studio_face_call): onboarding with its camera. A wrong match is fixed by
 * onboarding more of the right person, or renaming or removing samples in the
 * library (the server tells every page to reload it: faces_changed).
 */
export const STUDIO_FACE_METHODS = ['beginEnrollment', 'endEnrollment', 'captureEnrollmentSample', 'saveEnrollment'] as const;
export type StudioFaceMethod = (typeof STUDIO_FACE_METHODS)[number];

/** The last picture sent to the vision provider, and what came back. */
export interface StudioVisionCheck {
  at: number;
  kind: 'appearance' | 'refresh';
  /** null while the provider is still answering. */
  ok: boolean | null;
  ms: number | null;
  provider: 'gemini' | 'openai';
  model: string;
  /** host or host:port that answered (fleet:vision resolved to the box); "Gemini API" for gemini. */
  where: string | null;
  text: string | null;
  error?: string;
}

/** GET /studio/vision (local network only): what Tubs last made of a picture, for the Studio tab. */
export interface StudioVisionResponse {
  /** The studio camera: on while the listener page has a picture source; null when studio mode is off. */
  camera: { on: boolean | null; source: string };
  vision: { provider: string; model: string; on: boolean };
  last: StudioVisionCheck | null;
  /** Listed people recognised in view now, whose attitude the next turn carries. */
  relationships: Array<{ name: string; attitude: string }>;
}

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
