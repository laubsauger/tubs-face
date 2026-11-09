// Whether this tubs-face can do its job right now, part by part, for
// studio-manager: its health check is "HTTP 200 or not" (GET /healthz), and
// GET /health shows the parts. Needed: the Python speech service (speech in and
// out), Ming when a head speaks with a ming: voice, and in studio mode both
// face pages publishing.

import type { HealthParts, PartState } from '../../shared/contracts/http.js';

/** Probes are cached this long: studio-manager and dashboards may poll often. */
export const READINESS_CACHE_MS = 1000;
const PROBE_TIMEOUT_MS = 800;

export interface ReadinessSources {
  /** GET {url}: status and JSON body, or null when nothing answers. */
  probe: (url: string, timeoutMs: number) => Promise<{ status: number; body: Record<string, unknown> | null } | null>;
  speechUrl: string;
  mingUrl: string;
  /** Our own speech service process is running (it may still be loading). */
  speechRunning: () => boolean;
  /** Voices in use, to tell whether Ming is needed. */
  voices: () => string[];
  studio: () => { enabled: boolean; actors: Array<{ id: string; publishing: boolean; error?: string }> };
  now?: () => number;
}

export interface Readiness {
  check(): Promise<{ ready: boolean; parts: HealthParts }>;
}

export function createReadiness(sources: ReadinessSources): Readiness {
  const now = sources.now ?? Date.now;
  let cached: { at: number; result: Promise<{ ready: boolean; parts: HealthParts }> } | null = null;

  async function compute(): Promise<{ ready: boolean; parts: HealthParts }> {
    const mingNeeded = sources.voices().some((voice) => voice.startsWith('ming:'));
    const [speechAnswer, mingAnswer] = await Promise.all([
      sources.probe(`${sources.speechUrl}/health`, PROBE_TIMEOUT_MS),
      mingNeeded ? sources.probe(`${sources.mingUrl}/health`, PROBE_TIMEOUT_MS) : Promise.resolve(null),
    ]);
    const speech: PartState = speechAnswer?.status === 200 && speechAnswer.body?.status === 'ok'
      ? 'up'
      : sources.speechRunning() ? 'starting' : 'down';
    const ming: PartState = !mingNeeded
      ? 'off'
      : mingAnswer?.status === 200 && mingAnswer.body?.ready === true ? 'up'
        : mingAnswer?.status === 200 ? 'starting' : 'down';
    const studioState = sources.studio();
    const notPublishing = studioState.actors.filter((actor) => !actor.publishing);
    const studio: PartState = !studioState.enabled ? 'off' : notPublishing.length === 0 ? 'up' : 'down';
    const parts: HealthParts = {
      node: { state: 'up' },
      speech: { state: speech },
      ming: { state: ming, needed: mingNeeded },
      studio: {
        state: studio,
        ...(studioState.enabled ? { actors: studioState.actors.map((actor) => ({ id: actor.id, publishing: actor.publishing, ...(actor.error ? { error: actor.error } : {}) })) } : {}),
      },
    };
    const ready = speech === 'up' && (ming === 'up' || ming === 'off') && (studio === 'up' || studio === 'off');
    return { ready, parts };
  }

  return {
    check() {
      if (cached && now() - cached.at < READINESS_CACHE_MS) return cached.result;
      const result = compute();
      cached = { at: now(), result };
      return result;
    },
  };
}

/** A plain GET with a timeout; null when nothing answers. */
export async function probeJson(url: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> | null } | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
}
