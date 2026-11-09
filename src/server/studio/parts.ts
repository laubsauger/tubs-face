// GET /studio parts: what runs where, for the Studio tab's card and the
// sentient panel. Built from what the server already knows (the last health
// probes, the last LLM and vision calls, the face pages' reports): GET /studio
// is polled, so nothing here waits on the network.

import os from 'node:os';
import type { HealthParts, PartState } from '../../shared/contracts/http.js';
import { parseMicSource, type StudioPart, type StudioResponse } from '../../shared/contracts/studio.js';
import type { StudioVisionCheck } from '../../shared/contracts/studio.js';
import type { LastLlmCall } from '../llm/last-call.js';
import type { RuntimeConfig } from '../../shared/contracts/config.js';

export interface PartsSources {
  config: Pick<RuntimeConfig, 'llmModel' | 'kokoroVoice' | 'secondaryVoice' | 'dualHeadEnabled' | 'dualHeadMode' | 'visionProvider' | 'visionModel' | 'visionBaseUrl'>;
  env: NodeJS.ProcessEnv;
  studio: StudioResponse;
  /** The last finished health check (null before the first). */
  health: HealthParts | null;
  llm: LastLlmCall | null;
  /** The LLM can be asked at all (Gemini: a key). */
  llmReady: boolean;
  vision: StudioVisionCheck | null;
  /** fleet:vision resolved to this .../v1 base; null when no box was found yet. */
  fleetBase: string | null;
  speechPort: number;
  mingUrl: string;
  /** This machine's name, for work done on loopback. */
  hostname?: string;
}

const GEMINI_HOST = 'generativelanguage.googleapis.com';

function machineName(hostname: string): string {
  return hostname.replace(/\.local$/i, '');
}

/** host:port of a URL, with this machine's name for loopback. */
export function whereOf(url: string, hostname: string): string {
  try {
    const parsed = new URL(url.includes('://') ? url : `http://${url}`);
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
    const host = loopback ? machineName(hostname) : parsed.hostname;
    return parsed.port ? `${host}:${parsed.port}` : host;
  } catch {
    return url;
  }
}

const okOf = (state: PartState | undefined): boolean | null => (state === undefined || state === 'off' ? null : state === 'up');

export function studioParts(sources: PartsSources): StudioPart[] {
  const hostname = sources.hostname ?? os.hostname();
  const here = machineName(hostname);
  const { config, env, studio } = sources;
  const parts: StudioPart[] = [];

  // The brain: Gemini, or Ollama / an OpenAI-compatible server through the speech service.
  const provider = (env.LLM_PROVIDER || '').trim().toLowerCase();
  const local = provider === 'ollama' || provider === 'realtime';
  const llmTarget = local
    ? (env.REALTIME_LLM_PROVIDER?.trim().toLowerCase() === 'openai'
      ? env.REALTIME_OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'
      : env.REALTIME_LLM_BASE_URL?.trim() || env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434')
    : GEMINI_HOST;
  const llmModel = sources.llm?.model || (local ? env.REALTIME_LLM_MODEL?.trim() || '' : config.llmModel);
  parts.push({
    id: 'brain',
    label: 'Brain',
    where: whereOf(llmTarget, hostname),
    ok: !sources.llmReady ? false : sources.llm ? sources.llm.ok : null,
    detail: [llmModel, !sources.llmReady ? 'no GEMINI_API_KEY' : sources.llm ? (sources.llm.ok ? `${sources.llm.ms} ms` : sources.llm.error ?? 'failed') : ''].filter(Boolean).join(' · '),
  });

  // The voices: Ming for ming: voices, else Kokoro in the speech service.
  const voices = [config.kokoroVoice, ...(config.dualHeadEnabled && config.dualHeadMode !== 'off' ? [config.secondaryVoice] : [])];
  const ming = voices.some((voice) => voice.startsWith('ming:'));
  parts.push({
    id: 'voices',
    label: 'Voices',
    where: ming ? whereOf(sources.mingUrl, hostname) : `${here}:${sources.speechPort}`,
    ok: okOf(ming ? sources.health?.ming.state : sources.health?.speech.state),
    detail: voices.join(', '),
  });

  // Speech in and out: the Python speech service (Whisper, Kokoro).
  parts.push({
    id: 'realtime',
    label: 'Speech service',
    where: `${here}:${sources.speechPort}`,
    ok: okOf(sources.health?.speech.state),
    ...(sources.health && sources.health.speech.state !== 'up' ? { detail: sources.health.speech.state } : {}),
  });

  // Vision: who looks at the pictures, fleet:vision resolved to its box.
  const visionModel = config.visionModel || (config.visionProvider === 'gemini' ? config.llmModel : '');
  const fleet = config.visionProvider === 'openai' && config.visionBaseUrl === 'fleet:vision';
  const visionWhere = config.visionProvider === 'off'
    ? 'off'
    : config.visionProvider === 'gemini'
      ? GEMINI_HOST
      : fleet
        ? (sources.fleetBase ? whereOf(sources.fleetBase, hostname) : 'fleet:vision (no box found yet)')
        : config.visionBaseUrl ? whereOf(config.visionBaseUrl, hostname) : 'no base URL';
  const check = sources.vision;
  parts.push({
    id: 'vision',
    label: 'Vision',
    where: visionWhere,
    // Asked to use a box nobody has found, or a server with no URL: not working, whatever the last call did.
    ok: config.visionProvider === 'off' ? null
      : (fleet && !sources.fleetBase && check?.ok !== true) || (config.visionProvider === 'openai' && !fleet && !config.visionBaseUrl) ? false
        : check && check.ok !== null ? check.ok : null,
    detail: config.visionProvider === 'off'
      ? 'no picture leaves this machine'
      : [visionModel, check?.ok ? `${check.ms} ms` : check?.ok === false ? check.error ?? 'failed' : ''].filter(Boolean).join(' · '),
  });

  // The mic: its device or site stream, and whether the listener hears through it.
  const mic = parseMicSource(studio.micSource);
  const siteHost = whereOf(studio.site, hostname);
  parts.push({
    id: 'mic',
    label: 'Mic',
    where: !studio.enabled || mic?.kind === 'off' ? 'off'
      : mic?.kind === 'site' ? `${mic.path} @ ${siteHost}`
        : mic?.kind === 'local' && mic.label ? `${mic.label} @ ${here}` : `default input @ ${here}`,
    ok: !studio.enabled || mic?.kind === 'off' ? null : studio.mic ? studio.mic.listening : false,
    ...(studio.enabled && studio.mic?.error ? { detail: studio.mic.error } : {}),
  });

  // The face pages, and how steadily they render and publish.
  const fps = studio.actors.map((actor) => `${actor.id} ${actor.cadence ? `${Math.round(actor.cadence.encodedFps ?? actor.cadence.renderFps)} fps` : actor.publishing ? 'publishing' : 'not publishing'}`);
  parts.push({
    id: 'faces',
    label: 'Face pages',
    where: !studio.enabled ? 'off' : studio.launch === 'chrome' ? `Chrome @ ${here}` : 'external pages',
    ok: !studio.enabled ? null : studio.actors.every((actor) => actor.publishing),
    ...(studio.enabled ? { detail: fps.join(' · ') } : {}),
  });

  // The site node the faces publish to.
  const errors = [...new Set(studio.actors.map((actor) => actor.error).filter((error): error is string => Boolean(error)))];
  parts.push({
    id: 'site',
    label: 'Site node',
    where: siteHost,
    ok: !studio.enabled ? null : errors.length === 0 && studio.actors.some((actor) => actor.publishing),
    ...(studio.enabled ? { detail: errors[0] ?? `${studio.actors.filter((actor) => actor.publishing).length}/${studio.actors.length} publishing` } : {}),
  });

  return parts;
}
