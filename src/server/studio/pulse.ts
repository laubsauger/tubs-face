// GET /studio/pulse: the studio at a glance (contract: StudioPulse), from what
// the server already holds: the listener's last live report, which head is
// talking (studio_state), the last line heard and the last vision check.

import type { FaceObservationFace, StudioFaceWorkerStatus, StudioListenState, StudioLiveFace, StudioLiveStatus, StudioPulse } from '../../shared/contracts/studio.js';
import { visionService } from '../assistant/vision.js';
import { runtimeConfig } from '../config/runtime.js';
import { lastLiveStatus } from './live.js';
import { listenerFaceWorker, studioSettings } from './state.js';
import { OBSERVATION_FRESH_MS, lastObservation } from './faces.js';

const speakingHeads = new Map<'main' | 'small', boolean>();
let heard: { text: string; t: number } | null = null;

/** A head's page said whether it is talking (studio_state). */
export function noteHeadSpeaking(actor: 'main' | 'small', speaking: boolean): void {
  speakingHeads.set(actor, speaking);
}

/** The mic heard a line (a voice turn). */
export function noteHeard(text: string, now = Date.now()): void {
  const clean = text.trim();
  if (clean) heard = { text: clean.slice(0, 500), t: now };
}

export function resetPulse(): void {
  speakingHeads.clear();
  heard = null;
}

export function listenStateOf(status: StudioLiveStatus | null, speaking: boolean): StudioListenState {
  if (!status?.micReady) return 'off';
  if (speaking || status.audioPlaying) return 'speaking';
  if (status.recording) return 'hearing';
  if (status.listenState === 'Uploading...' || status.listenState === 'Thinking...') return 'thinking';
  return 'listening';
}

const unit = (value: number) => Math.min(1, Math.max(0, value));
const round = (value: number) => Math.round(value * 1000) / 1000;

/** A face in the pulse: its best match (null: unknown), how sure, its box in 0..1 of the picture. */
export function seenOf(face: StudioLiveFace, width: number, height: number): StudioPulse['seen'][number] {
  const [x1, y1, x2, y2] = face.box;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const left = unit(x1 / w);
  const top = unit(y1 / h);
  return {
    name: face.name ?? face.match?.name ?? null,
    prob: round(unit(face.match?.score ?? face.matches?.[0]?.score ?? 0)),
    box: [round(left), round(top), round(unit(x2 / w) - left), round(unit(y2 / h) - top)],
  };
}

/** A face as the pulse shows it, from a FaceObservation (docs/face-service.md). */
export function seenOfObserved(face: FaceObservationFace): StudioPulse['seen'][number] {
  const named = face.name ? face.candidates.find((candidate) => candidate.name === face.name) : undefined;
  return {
    name: face.name ?? null,
    prob: round(unit(named?.sim ?? face.candidates[0]?.sim ?? 0)),
    box: [round(face.box[0]), round(face.box[1]), round(face.box[2]), round(face.box[3])],
  };
}

export function studioPulse(now = Date.now()): StudioPulse {
  const status = lastLiveStatus();
  // Whichever producer runs (docs/face-service.md); an old observation says nothing about now.
  const observed = lastObservation();
  const observation = observed && now - observed.at <= OBSERVATION_FRESH_MS ? observed.observation : null;
  const speaking = speakingHeads.get('main') ? 'main' : speakingHeads.get('small') ? 'small' : null;
  const check = visionService.lastCheck();
  return {
    t: now,
    mic: {
      source: studioSettings.micSource,
      level: status ? round(unit(status.micLevel)) : 0,
      state: listenStateOf(status, speaking !== null),
    },
    speaking,
    heard,
    seen: observation
      ? observation.faces.map(seenOfObserved)
      : status?.faceCameraActive
        ? status.faceLastFaces.map((face) => seenOf(face, status.faceFrameWidth ?? 0, status.faceFrameHeight ?? 0))
        : [],
    vision: { provider: runtimeConfig.visionProvider, lastMs: check?.ms ?? null, at: check?.at ?? null },
    faceWorker: observation
      ? { state: observation.worker.state, checksPerSecond: observation.worker.fps, lastCheckAt: observation.t }
      : faceWorkerOf(listenerFaceWorker()),
  };
}

function faceWorkerOf(worker: StudioFaceWorkerStatus | null): StudioPulse['faceWorker'] {
  return worker
    ? { state: worker.state, checksPerSecond: worker.checksPerSecond, lastCheckAt: worker.lastCheckAt }
    : { state: 'gone', checksPerSecond: 0, lastCheckAt: null };
}
