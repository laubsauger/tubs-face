// GET /studio parts: what runs where, for the Studio tab's card and the
// sentient panel. Built from what the server already knows (the last health
// probes, the last LLM and vision calls, the face pages' reports): GET /studio
// is polled, so nothing here waits on the network.

import os from 'node:os';
import type { HealthParts, PartState } from '../../shared/contracts/http.js';
import { parseMicSource, type FaceObservation, type StudioFaceWorkerStatus, type StudioPart, type StudioResponse } from '../../shared/contracts/studio.js';
import type { StudioVisionCheck } from '../../shared/contracts/studio.js';
import type { LastLlmCall } from '../llm/last-call.js';
import type { RuntimeConfig } from '../../shared/contracts/config.js';

export interface PartsSources {
  config: Pick<RuntimeConfig, 'llmModel' | 'kokoroVoice' | 'secondaryVoice' | 'dualHeadEnabled' | 'dualHeadMode' | 'visionProvider' | 'visionModel' | 'visionBaseUrl' | 'visionDescriptions' | 'relationshipsEnabled'>;
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
  /** The listener page's face worker (null: page not connected), and how many people the face library knows. */
  faceWorker?: StudioFaceWorkerStatus | null;
  /** The last face observation from whichever producer runs, and when it came (docs/face-service.md). */
  observation?: { observation: FaceObservation; at: number } | null;
  libraryPeople?: number;
  /** Listed people recognised in view now (relationships in effect). */
  relationshipsInEffect?: number;
  now?: number;
}

/** A check this recent means the face worker is looking. */
const CHECKING_MS = 15_000;

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
  const descriptionsOff = config.visionProvider === 'off' || !config.visionDescriptions;
  parts.push({
    id: 'vision',
    label: 'Vision',
    where: config.visionDescriptions ? visionWhere : 'off',
    // Asked to use a box nobody has found, or a server with no URL: not working, whatever the last call did.
    ok: descriptionsOff ? null
      : (fleet && !sources.fleetBase && check?.ok !== true) || (config.visionProvider === 'openai' && !fleet && !config.visionBaseUrl) ? false
        : check && check.ok !== null ? check.ok : null,
    detail: !config.visionDescriptions
      ? 'descriptions switched off: no picture leaves this machine'
      : config.visionProvider === 'off'
      ? 'no picture leaves this machine'
      : [visionModel, check?.ok ? `${check.ms} ms` : check?.ok === false ? check.error ?? 'failed' : '', 'when a face is detected'].filter(Boolean).join(' · '),
  });

  // The mic: its device or site stream, and whether the listener hears through it.
  const mic = parseMicSource(studio.micSource);
  const siteHost = whereOf(studio.site, hostname);
  parts.push({
    id: 'mic',
    label: 'Mic',
    where: !studio.enabled || mic?.kind === 'off' || studio.switches?.mic === false ? 'off'
      : mic?.kind === 'site' ? `${mic.path} @ ${siteHost}`
        : mic?.kind === 'local' && mic.label ? `${mic.label} @ ${here}` : `default input @ ${here}`,
    ok: !studio.enabled || mic?.kind === 'off' || studio.switches?.mic === false ? null : studio.mic ? studio.mic.listening : false,
    ...(studio.switches?.mic === false ? { detail: 'switched off' } : studio.enabled && studio.mic?.error ? { detail: studio.mic.error } : {}),
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

  // Added after the first seven, so a reader that knows those finds them where they were.
  const now = sources.now ?? Date.now();
  const worker = sources.faceWorker ?? null;
  const cameraOff = !studio.enabled || studio.switches?.camera === false || studio.visionSource === 'off';
  parts.push({
    id: 'camera',
    label: 'Camera',
    where: cameraOff ? 'off' : studio.visionSource.startsWith('site:') ? `${studio.visionSource.slice(5)} @ ${siteHost}` : studio.visionSource.startsWith('local') ? `${studio.visionSource === 'local' ? 'default camera' : studio.visionSource.slice(6)} @ ${here}` : studio.visionSource.slice(9),
    ok: cameraOff ? null : worker ? worker.camera && !(worker.error && worker.lastFrameAt === null) : false,
    ...(studio.switches?.camera === false ? { detail: 'switched off' } : worker?.frameWidth ? { detail: `${worker.frameWidth}×${worker.frameHeight}${worker.lastFrameAt ? ` · last picture ${Math.round((now - worker.lastFrameAt) / 1000)} s ago` : ''}` } : worker?.error ? { detail: worker.error } : {}),
  });
  const recognitionOff = !studio.enabled || studio.switches?.faceRecognition === false || cameraOff;
  // The producer's own report (docs/face-service.md) when there is one, else the listener page's status.
  const observed = sources.observation?.observation.worker ?? null;
  const view = observed
    ? {
      service: observed.kind === 'service',
      state: observed.state,
      threads: observed.threads,
      inferMs: observed.inferMs,
      fps: observed.fps,
      lastCheckAt: sources.observation!.observation.t,
      problem: observed.error,
      checkSkip: worker?.checkSkip ?? null,
      where: observed.kind === 'service' ? observed.where : null,
    }
    : worker
      ? {
        service: false,
        state: worker.state,
        threads: worker.threads,
        inferMs: worker.inferenceMs ?? null,
        fps: worker.checksPerSecond,
        lastCheckAt: worker.lastCheckAt,
        problem: worker.state === 'loading' ? worker.detail : worker.error ?? worker.detail,
        checkSkip: worker.checkSkip ?? null,
        where: null,
      }
      : null;
  const checking = view?.state === 'ready' && view.lastCheckAt !== null && now - view.lastCheckAt < CHECKING_MS;
  parts.push({
    id: 'recognition',
    label: 'Face recognition',
    where: recognitionOff ? 'off' : view?.where ?? (studio.launch === 'chrome' ? `Chrome @ ${here}` : 'the listener page'),
    ok: recognitionOff ? null : checking,
    detail: recognitionOff
      ? (studio.switches?.faceRecognition === false
        ? (config.visionDescriptions ? 'switched off (faces are still detected, for descriptions)' : 'switched off')
        : 'no camera')
      : !view ? 'the listener page is not connected'
        : view.state === 'ready'
          ? [
            'SCRFD+ArcFace',
            view.threads !== undefined ? `${view.threads} thread${view.threads === 1 ? '' : 's'}` : '',
            view.inferMs != null ? `${Math.round(view.inferMs)} ms` : '',
            `${view.fps} fps`,
            sources.libraryPeople !== undefined ? `${sources.libraryPeople} people` : '',
            checking ? '' : `no check for ${view.lastCheckAt ? `${Math.round((now - view.lastCheckAt) / 1000)} s` : 'a while'}${view.checkSkip ? ` (${view.checkSkip})` : ''}`,
          ].filter(Boolean).join(' · ')
          : view.state === 'loading' ? `loading: ${view.problem ?? 'models'}` : view.problem ?? view.state,
  });
  parts.push({
    id: 'relationships',
    label: 'Relationships',
    where: config.relationshipsEnabled ? 'config/relationships.json' : 'off',
    ok: config.relationshipsEnabled ? true : null,
    detail: config.relationshipsEnabled ? `${sources.relationshipsInEffect ?? 0} in effect` : 'switched off',
  });

  return parts;
}
