// The face service (src/face-service.py, docs/face-service.md): where it is
// (FACE_SERVICE), keeping the local one running, telling it which camera to
// read, and its stream of observations. What the faces mean (the library, who
// is in view, onboarding) is recognition.ts.

import http from 'node:http';
import os from 'node:os';
import { createPythonServiceController, type PythonServiceController } from '../processing/process-service.js';
import { createFleetResolver, type FleetResolver } from '../vision/fleet.js';

export type FaceServiceMode =
  | { kind: 'off' }
  | { kind: 'local'; port: number }
  | { kind: 'url'; base: string }
  | { kind: 'fleet' };

export const DEFAULT_FACE_SERVICE_PORT = 3004;

/** FACE_SERVICE: off, local, http(s)://host:port, fleet:faces. null for anything else. */
export function parseFaceServiceMode(value: string | undefined, port = DEFAULT_FACE_SERVICE_PORT): FaceServiceMode | null {
  const text = value?.trim() || 'off';
  if (text === 'off') return { kind: 'off' };
  if (text === 'local') return { kind: 'local', port };
  if (text === 'fleet:faces') return { kind: 'fleet' };
  try {
    const url = new URL(text);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.search && !url.hash) return { kind: 'url', base: text.replace(/\/+$/, '') };
  } catch {
    // not a URL
  }
  return null;
}

/** One face in a frame, as the service reports it: box x1, y1, x2, y2 in the frame's pixels. */
export interface ServiceFace {
  track: number;
  box: [number, number, number, number];
  score: number;
  landmarks?: Array<[number, number]> | null;
  embedding: number[] | null;
}

/** The service's own state (its GET /health, and every line of its stream). */
export interface ServiceHealth {
  state: 'loading' | 'ready' | 'error';
  backend: string;
  fps: number;
  inferMs: number;
  frames: number;
  source: string | null;
  /** null: no camera set; "ok", or "no frames". */
  camera: string | null;
  where: string;
  threads?: number;
  error?: string;
  download?: { file: string; pct: number | null; mb: number; totalMb: number | null };
}

/** One line of GET /observations: a frame checked (frame set), or a status line while idle. */
export interface ServiceLine {
  t: number;
  source: string | null;
  frame: { w: number; h: number } | null;
  faces: ServiceFace[];
  status: ServiceHealth;
}

export interface ServiceCapture {
  frame: { w: number; h: number };
  faces: Array<ServiceFace & { thumbnail: string | null }>;
}

/** What the server knows about the service now; never waits on the network. */
export interface FaceServiceStatus {
  mode: FaceServiceMode['kind'];
  /** host:port of the service (this machine's name for loopback); null while fleet:faces found no box. */
  where: string | null;
  /** Its last word, while the stream is up; null when it is not answering. */
  health: ServiceHealth | null;
  /** Why the server cannot reach it, when it cannot. */
  error: string | null;
}

export interface FaceServiceClient {
  readonly mode: FaceServiceMode;
  start(): void;
  stop(): Promise<void>;
  /** The camera to read (null: none). Sent again whenever the service comes back. */
  setSource(source: { url: string; label: string; fps: number } | null): void;
  status(): FaceServiceStatus;
  capture(): Promise<ServiceCapture>;
  /** The newest frame as a JPEG data URL, longest side at most maxPx. */
  frame(maxPx: number): Promise<string | null>;
  thumbnail(track: number): Promise<string | null>;
}

export interface FaceServiceOptions {
  mode: FaceServiceMode;
  onLine: (line: ServiceLine) => void;
  /** The stream went down (or came back: null). */
  onDown?: (error: string | null) => void;
  /** Tests: no Python process. */
  controller?: PythonServiceController | null;
  fleet?: FleetResolver;
  hostname?: string;
  log?: (message: string) => void;
}

const RECONNECT_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;
/** No line for this long (the service sends one a second at least): the stream is dead. */
const STALE_MS = 6000;

function machineName(hostname: string): string {
  return hostname.replace(/\.local$/i, '');
}

function whereOf(base: string, hostname: string): string {
  try {
    const url = new URL(base);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    const host = loopback ? machineName(hostname) : url.hostname;
    return url.port ? `${host}:${url.port}` : host;
  } catch {
    return base;
  }
}

export function createFaceServiceClient(options: FaceServiceOptions): FaceServiceClient {
  const { mode } = options;
  const hostname = options.hostname ?? os.hostname();
  const log = options.log ?? ((message: string) => console.log(`[faces] ${message}`));
  const controller = options.controller !== undefined
    ? options.controller
    : mode.kind === 'local'
      ? createPythonServiceController({
        scriptName: 'face-service.py',
        port: mode.port,
        envFactory: () => ({ ...process.env, FACE_SERVICE_PORT: String(mode.port) }),
        logPrefix: '[face-service]',
      })
      : null;
  const fleet = options.fleet ?? (mode.kind === 'fleet'
    ? createFleetResolver({ hub: process.env.FLEET_HUB?.trim() || 'http://127.0.0.1:4310', kind: 'faces', suffix: '', log })
    : null);

  let running = false;
  let base: string | null = mode.kind === 'local' ? `http://127.0.0.1:${mode.port}` : mode.kind === 'url' ? mode.base : null;
  let health: ServiceHealth | null = null;
  let error: string | null = mode.kind === 'off' ? null : 'not connected yet';
  let wanted: { url: string; label: string; fps: number } | null = null;
  let request: http.ClientRequest | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let staleTimer: NodeJS.Timeout | null = null;
  let lastLineAt = 0;
  let wasDown = false;

  async function resolveBase(): Promise<string | null> {
    if (mode.kind !== 'fleet' || !fleet) return base;
    const found = await fleet.resolve();
    base = found;
    return found;
  }

  function goDown(reason: string): void {
    health = null;
    error = reason;
    if (!wasDown) {
      wasDown = true;
      log(`face service ${base ? whereOf(base, hostname) : ''} not answering: ${reason}`);
      options.onDown?.(reason);
    }
  }

  function scheduleReconnect(): void {
    if (!running || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, RECONNECT_MS);
    reconnectTimer.unref();
  }

  async function connect(): Promise<void> {
    if (!running) return;
    const target = await resolveBase().catch(() => null);
    if (!target) {
      goDown(mode.kind === 'fleet' ? 'fleet:faces: the hub lists no face service box (or does not answer)' : 'no address');
      scheduleReconnect();
      return;
    }
    // The service forgets its camera when it restarts: say it again on every connection.
    try {
      await postJson(`${target}/source`, wanted ? { url: wanted.url, label: wanted.label, fps: wanted.fps } : { url: null });
    } catch (cause) {
      goDown(reasonOf(cause));
      if (mode.kind === 'fleet' && base) fleet?.fail(base);
      scheduleReconnect();
      return;
    }
    let buffer = '';
    let over = false;
    // However the stream ends (the service closed it, the socket broke, it went stale): once.
    const ended = (reason: string) => {
      if (over) return;
      over = true;
      if (request === req) request = null;
      if (!running) return; // stopped on purpose
      goDown(reason);
      scheduleReconnect();
    };
    const req = http.get(`${target}/observations`, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        ended(`GET /observations answered ${response.statusCode}`);
        return;
      }
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const text = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!text.trim()) continue;
          try {
            const line = JSON.parse(text) as ServiceLine;
            lastLineAt = Date.now();
            health = line.status;
            error = null;
            if (wasDown) {
              wasDown = false;
              log(`face service at ${whereOf(target, hostname)}: ${line.status.state}${line.status.backend ? ` (${line.status.backend})` : ''}`);
              options.onDown?.(null);
            }
            options.onLine(line);
          } catch (cause) {
            log(`bad line from the face service: ${reasonOf(cause)}`);
          }
        }
      });
      response.on('error', (cause) => ended(reasonOf(cause)));
      response.on('close', () => ended('the stream ended'));
    });
    request = req;
    req.on('error', (cause) => ended(reasonOf(cause)));
  }

  function watchStale(): void {
    staleTimer = setInterval(() => {
      if (request && lastLineAt && Date.now() - lastLineAt > STALE_MS) {
        request.destroy(new Error(`no word for ${Math.round((Date.now() - lastLineAt) / 1000)} s`));
      }
    }, 1000);
    staleTimer.unref();
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
    const target = base;
    if (!target) throw new Error('face service not found');
    const response = await fetch(`${target}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { status: response.status, body: await response.json() as T };
  }

  return {
    mode,
    start() {
      if (mode.kind === 'off' || running) return;
      running = true;
      if (controller) {
        void portAnswers(mode.kind === 'local' ? mode.port : 0).then((busy) => {
          if (busy) log(`port ${mode.kind === 'local' ? mode.port : ''} already serves; using the face service running there`);
          else controller.start();
        });
      }
      watchStale();
      void connect();
    },
    async stop() {
      running = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (staleTimer) clearInterval(staleTimer);
      staleTimer = null;
      request?.destroy();
      request = null;
      await controller?.stop();
    },
    setSource(source) {
      const same = JSON.stringify(source) === JSON.stringify(wanted);
      wanted = source;
      if (same || !running || !base || health === null) return;
      void postJson(`${base}/source`, source ? { url: source.url, label: source.label, fps: source.fps } : { url: null }).catch((cause: unknown) => {
        log(`could not set the camera: ${reasonOf(cause)}`);
      });
    },
    status() {
      return { mode: mode.kind, where: base ? whereOf(base, hostname) : null, health, error: health ? null : error };
    },
    async capture() {
      if (!base) throw new Error('face service not found');
      const response = await fetch(`${base}/capture`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = await response.json() as ServiceCapture & { error?: string };
      if (!response.ok) throw new Error(body.error || `the face service answered ${response.status}`);
      return body;
    },
    async frame(maxPx) {
      if (!base) return null;
      const response = await fetch(`${base}/frame.jpg?max=${Math.round(maxPx)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) return null;
      return `data:image/jpeg;base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
    },
    async thumbnail(track) {
      const { status, body } = await getJson<{ thumbnail?: string }>(`/thumbnail?track=${track}`);
      return status === 200 && body.thumbnail ? body.thumbnail : null;
    },
  };
}

function postJson(url: string, body: unknown): Promise<unknown> {
  return fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    .then(async (response) => {
      if (!response.ok) throw new Error(`${new URL(url).pathname} answered ${response.status}`);
      return response.json();
    });
}

function reasonOf(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code ?? ((cause as { cause?: NodeJS.ErrnoException }).cause?.code);
    if (code === 'ECONNREFUSED') return 'connection refused (not running?)';
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') return 'timed out';
    // fetch says only "fetch failed"; the reason is underneath.
    const inner = (cause as { cause?: Error }).cause;
    return cause.message === 'fetch failed' && inner ? `${inner.message}` : cause.message;
  }
  return String(cause);
}

function portAnswers(port: number): Promise<boolean> {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}
