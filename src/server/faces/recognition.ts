// What the face service's frames mean (docs/face-service.md): the server does
// for them what the studio listener page does for its browser worker's
// (client/face/runtime.ts onFaces), with the same code where it is pure:
// matching against the face library (client/face/matching.ts: same thresholds,
// same decisions), who is in view (people-tracker.ts), visits (visitor-tracker.ts)
// and auto onboarding (auto-onboarding.ts). Its results go into the same entry
// points the listener page's messages reach (people, presence, proactive,
// appearance_frame, camera_frame), as one FaceObservation per frame for the
// pages, and as the face fields of the studio_live relay and the pulse.

import { annotateDetectedFaces, chosenFace, cosineSimilarity } from '../../client/face/matching.js';
import { uploadVerdict } from '../../client/face/person-match.js';
import { createPeopleTracker, type TrackedPerson } from '../../client/face/people-tracker.js';
import { RETURN_GREETING_MIN_AWAY_MS, createVisitorTracker, type VisitorEvent } from '../../client/face/visitor-tracker.js';
import { type Snapshot, wantsSnapshot } from '../../client/face/auto-onboarding.js';
import type { DetectedFace, EnrolledFace } from '../../shared/contracts/faces.js';
import { NOT_A_STUDIO_PICTURE, isStudioPicture, studioFaceBoxOf, type FaceObservation, type FaceObservationFace, type FaceWorkerStatus, type StudioFaceMethod, type StudioLiveFace, type StudioLiveStatus } from '../../shared/contracts/studio.js';
import type { WsClientMessage } from '../../shared/contracts/ws.js';
import type { ServiceCapture, ServiceHealth, ServiceLine } from './service.js';

/** The listener page's messages the server acts on for recognition; the server now sends them itself. */
export type ListenerEffect = Extract<WsClientMessage, { type: 'people' | 'presence' | 'proactive' | 'appearance_frame' | 'camera_frame' }>;

/** The face fields of the studio listener's live state (StudioLiveStatus). */
export type LiveFaceFields = Pick<StudioLiveStatus, 'faceCameraActive' | 'faceWorkerReady' | 'faceStatus' | 'faceLastDetectedCount' | 'faceFrameWidth' | 'faceFrameHeight' | 'faceLastFaces'>;

export interface RecognitionConfig {
  autoEnrollEnabled: boolean;
  visionProvider: string;
  visionMaxPx: number;
  visionRefreshMs: number;
  /** The studio's switches: names and onboarding (faceRecognition), pictures described (visionDescriptions). */
  faceRecognition: boolean;
  visionDescriptions: boolean;
}

export interface RecognitionDeps {
  /** Acts as if the listener page had sent this (ws/server.ts applyListenerMessage). */
  apply(message: ListenerEffect): void;
  /** Each frame's observation, for the listener page and the dashboards. */
  publish(observation: FaceObservation): void;
  library(): EnrolledFace[];
  addFace(face: { name: string; embedding: number[]; thumbnail?: string }): void;
  /** The library changed: every page reloads it (faces_changed). */
  facesChanged(): void;
  inConversation(now: number): boolean;
  config(): RecognitionConfig;
  /** The service's newest frame as a JPEG data URL; its face crops; a fresh capture. */
  frame(maxPx: number): Promise<string | null>;
  thumbnail(track: number): Promise<string | null>;
  capture(): Promise<ServiceCapture>;
  /** The faces in a picture (an upload for someone's samples), each embedded, with its thumbnail. */
  detect(picture: Buffer): Promise<ServiceCapture>;
  /** "mac:3004": where the service runs. */
  where(): string;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (message: string) => void;
}

export interface Recognition {
  /** One line of the service's stream. */
  handleLine(line: ServiceLine): void;
  /** The service went away (or its camera stopped): nobody is in view any more. */
  lost(reason: string): void;
  /** A dashboard's onboarding call (studio_face_call), answered as the listener page answers it. */
  faceCall(method: StudioFaceMethod, args: Record<string, unknown>): Promise<unknown>;
  /** Someone told Tubs their name: enrol them from the snapshots taken while they were in view. */
  autoEnroll(personId: string, name: string): Promise<void>;
  /** The last observation; null before the first or after a loss. */
  observation(): FaceObservation | null;
  /** What the studio_live relay and the pulse show of the faces; null when the service has nothing. */
  liveFaces(): LiveFaceFields | null;
  /** Forget everything (the service stopped recognising: studio off, another camera). */
  reset(): void;
}

// The listener page's own constants (client/face/runtime.ts, enrollment.ts, studio/runtime.ts).
const FACE_STICKY_MS = 1400;
const MAX_EMPTY_FRAMES = 2;
const PEOPLE_REFRESH_MS = 5000;
const ENROLLMENT_CAPTURE_RETRY_DELAY_MS = 250;
const ENROLLMENT_MAX_CAPTURE_ATTEMPTS = 5;
const ENROLLMENT_DUPLICATE_THRESHOLD = 0.82;
const ENROLLMENT_IDLE_MS = 60_000;
const SNAPSHOT_KEEP_MS = 30 * 60_000;
const MAX_SAMPLES = 10;
const MAX_EMBEDDING = 2048;

type TrackedFace = DetectedFace & { track: number };

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const unit = (value: number) => Math.min(1, Math.max(0, value));

export function workerStatusOf(health: ServiceHealth | null, where: string, error?: string | null): FaceWorkerStatus {
  if (!health) {
    return { kind: 'service', state: 'error', backend: '', inferMs: 0, fps: 0, error: (error || 'the face service is not answering').slice(0, 300), where };
  }
  const reason = health.error ?? (health.state === 'loading' && health.download
    ? `downloading ${health.download.file}${health.download.pct !== null ? ` ${health.download.pct}%` : ''}`
    : undefined);
  return {
    kind: 'service',
    state: health.error ? 'error' : health.state,
    backend: health.backend,
    ...(health.threads ? { threads: health.threads } : {}),
    inferMs: Math.max(0, health.inferMs),
    fps: Math.max(0, health.fps),
    ...(reason ? { error: reason.slice(0, 300) } : {}),
    where,
  };
}

export function createRecognition(deps: RecognitionDeps): Recognition {
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((message: string) => console.log(`[faces] ${message}`));

  let peopleTracker = createPeopleTracker(deps.random);
  let visitorTracker = createVisitorTracker(deps.random);
  let stableFaces: TrackedFace[] = [];
  let stableFacesAt = 0;
  let emptyFrameCount = 0;
  let lastPeopleSignature = '';
  let lastPeopleSentAt = 0;
  let lastVisionFrameAt = 0;
  let enrollmentUntil = 0;
  const snapshots = new Map<string, Snapshot[]>();
  const snapshotPending = new Set<string>();
  let latest: FaceObservation | null = null;
  let live: LiveFaceFields | null = null;

  function stabilize(next: TrackedFace[], at: number): TrackedFace[] {
    if (next.length > 0) {
      stableFaces = next;
      stableFacesAt = at;
      emptyFrameCount = 0;
      return next;
    }
    emptyFrameCount += 1;
    if (stableFaces.length > 0 && emptyFrameCount <= MAX_EMPTY_FRAMES && at - stableFacesAt <= FACE_STICKY_MS) return stableFaces;
    stableFaces = [];
    stableFacesAt = 0;
    return [];
  }

  function enrolling(at: number): boolean {
    return at < enrollmentUntil;
  }

  /** Visitor events into the same messages the listener page sends; the greeting this frame deserves. */
  function handleVisitorEvents(events: VisitorEvent[], count: number): { returning: boolean; awayMs?: number } | null {
    let greeting: { returning: boolean; awayMs?: number } | null = null;
    const greetFor = (awayMs: number | undefined) => (awayMs !== undefined && awayMs >= RETURN_GREETING_MIN_AWAY_MS
      ? { returning: true, awayMs }
      : { returning: false });
    for (const event of events) {
      switch (event.type) {
        case 'arrived':
          greeting = greetFor(event.awayMs);
          break;
        case 'new_visitor':
          deps.apply({ type: 'presence', present: true, newVisitor: true, faces: event.names, count });
          greeting = greetFor(event.awayMs);
          break;
        case 'returned':
          if (event.awayMs >= RETURN_GREETING_MIN_AWAY_MS) greeting = { returning: true, awayMs: event.awayMs };
          break;
        case 'call_back':
          deps.apply({
            type: 'proactive',
            context: `${event.name} just walked away from you mid-conversation. Call them back by name, your way: annoyed, curious, or making it about you. Do not beg.`,
            faces: [event.name],
          });
          break;
        case 'gone':
          deps.apply({ type: 'presence', present: false, count: 0 });
          break;
      }
    }
    return greeting;
  }

  function takeSnapshot(person: TrackedPerson, at: number, frameHeight: number): void {
    const taken = snapshots.get(person.id) ?? [];
    const track = (person.face as TrackedFace).track;
    if (snapshotPending.has(person.id) || !wantsSnapshot(person, taken, at, frameHeight)) return;
    const embedding = person.face.embedding!;
    snapshotPending.add(person.id);
    void deps.thumbnail(track).then((thumbnail) => {
      if (!thumbnail) return;
      taken.push({ embedding, thumbnail, at });
      snapshots.set(person.id, taken);
    }).catch(() => undefined).finally(() => snapshotPending.delete(person.id));
    for (const [id, samples] of snapshots) {
      if (at - (samples.at(-1)?.at ?? 0) > SNAPSHOT_KEEP_MS) snapshots.delete(id);
    }
  }

  function reportPeople(people: TrackedPerson[], at: number, frameHeight: number): void {
    const config = deps.config();
    if (config.autoEnrollEnabled && config.faceRecognition) {
      for (const person of people) takeSnapshot(person, at, frameHeight);
    }
    const counts = people.map((person) => (person.names.length === 0 ? snapshots.get(person.id)?.length ?? 0 : 0));
    const signature = people.map((person, index) => `${person.id}:${person.position}:${person.names.join(',')}:${counts[index]}`).join('|');
    const someoneBack = people.some((person) => person.awayMs !== undefined);
    const due = people.length > 0 && at - lastPeopleSentAt >= PEOPLE_REFRESH_MS;
    if (signature === lastPeopleSignature && !someoneBack && !due) return;
    lastPeopleSignature = signature;
    lastPeopleSentAt = at;
    deps.apply({
      type: 'people',
      people: people.map(({ face: _face, joined: _joined, ...person }, index) => ({
        ...person,
        ...(counts[index] ? { snapshots: counts[index], thumbnail: snapshots.get(person.id)![0]!.thumbnail } : {}),
      })),
    });
  }

  function sendVision(kind: 'appearance' | 'refresh', extra: { faces: string[]; count: number; greeting: { returning: boolean; awayMs?: number } | null }): void {
    const config = deps.config();
    lastVisionFrameAt = now();
    void deps.frame(config.visionMaxPx).then((frame) => {
      if (!frame) return;
      if (kind === 'refresh') {
        deps.apply({ type: 'camera_frame', frame });
        return;
      }
      deps.apply({
        type: 'appearance_frame',
        frame,
        faces: extra.faces,
        count: extra.count,
        ...(extra.greeting?.returning ? { returning: true, awayMs: extra.greeting.awayMs ?? 0 } : {}),
      });
    }).catch((error: unknown) => log(`no picture for vision: ${error instanceof Error ? error.message : String(error)}`));
  }

  function liveFaceOf(face: TrackedFace): StudioLiveFace {
    const match = (entry: { name?: string; score: number }) => ({ ...(entry.name !== undefined ? { name: entry.name.slice(0, 80) } : {}), score: entry.score });
    return {
      box: [round(face.box[0], 1), round(face.box[1], 1), round(face.box[2], 1), round(face.box[3], 1)],
      score: face.score,
      name: face.name ?? null,
      match: face.match ? match(face.match) : null,
      matches: (face.matches ?? []).slice(0, 3).map(match),
    };
  }

  function observe(line: ServiceLine, faces: TrackedFace[], onboarding: Set<number>, at: number): FaceObservation {
    const { w, h } = line.frame ?? { w: 0, h: 0 };
    const enrollmentOpen = enrolling(at);
    return {
      t: line.t,
      source: line.source ?? '',
      frame: { w, h },
      faces: faces.slice(0, 32).map((face): FaceObservationFace => {
        const [x1, y1, x2, y2] = face.box;
        const name = face.name ?? null;
        return {
          track: face.track,
          box: [round(x1 / w), round(y1 / h), round((x2 - x1) / w), round((y2 - y1) / h)],
          score: round(unit(face.score)),
          candidates: (face.matches ?? []).filter((m) => m.name).slice(0, 3).map((m) => ({ name: m.name!.slice(0, 80), sim: round(m.score) })),
          decision: name ? 'match' : enrollmentOpen || onboarding.has(face.track) ? 'onboarding' : 'unknown',
          ...(name ? { name: name.slice(0, 80) } : {}),
        };
      }),
      worker: workerStatusOf(line.status, deps.where()),
    };
  }

  function lost(reason: string): void {
    stableFaces = [];
    stableFacesAt = 0;
    emptyFrameCount = 0;
    if (lastPeopleSignature) {
      lastPeopleSignature = '';
      deps.apply({ type: 'people', people: [] });
    }
    const worker: FaceWorkerStatus = latest
      ? { ...latest.worker, state: 'error', error: reason.slice(0, 300), fps: 0 }
      : workerStatusOf(null, deps.where(), reason);
    latest = latest ? { ...latest, t: now(), faces: [], worker } : null;
    live = live ? { ...live, faceLastDetectedCount: 0, faceLastFaces: [], faceWorkerReady: false, faceStatus: `Face service: ${reason}`.slice(0, 300) } : null;
    if (latest) deps.publish(latest);
  }

  return {
    handleLine(line) {
      const at = now();
      if (!line.frame) {
        // A status line: the service runs but has no new frame (no camera, or it stalled).
        const status = workerStatusOf(line.status, deps.where());
        if (latest) latest = { ...latest, worker: status };
        if (line.status.camera !== 'ok' && (stableFaces.length > 0 || live?.faceLastDetectedCount)) lost(line.status.error ?? 'the camera sends no frames');
        if (live) live = { ...live, faceWorkerReady: status.state === 'ready', faceStatus: statusText(status, live.faceLastDetectedCount) };
        return;
      }
      const config = deps.config();
      // Recognition switched off: faces are still detected (presence, descriptions), never named.
      const library = config.faceRecognition ? deps.library() : [];
      const detected: TrackedFace[] = line.faces.map((face) => ({ box: face.box, score: face.score, confidence: face.score, embedding: face.embedding, track: face.track }));
      const annotated = annotateDetectedFaces(detected, library) as TrackedFace[];
      const wasEmpty = stableFaces.length === 0;
      const faces = stabilize(annotated, at);
      const recognizedNames = [...new Set(faces.map((face) => face.match?.name ?? face.name ?? null).filter((name): name is string => Boolean(name?.trim())).map((name) => name.trim()))];

      const people = peopleTracker.update(faces, line.frame.w, at);
      const greeting = handleVisitorEvents(visitorTracker.update(faces, at, deps.inConversation(at), people.map((person) => person.id)), faces.length);
      reportPeople(people, at, line.frame.h);
      const groupChanged = faces.length > 0 && !wasEmpty && people.some((person) => person.joined);
      // Only faces trigger a picture: a new one appearing, or a refresh while they stay in view.
      if (config.visionDescriptions && config.visionProvider !== 'off' && faces.length > 0) {
        if (greeting || groupChanged) {
          sendVision('appearance', { faces: [...new Set([...recognizedNames, ...people.flatMap((person) => person.names)])], count: faces.length, greeting });
        } else if (at - lastVisionFrameAt >= config.visionRefreshMs) {
          sendVision('refresh', { faces: [], count: faces.length, greeting: null });
        }
      }

      const onboarding = new Set(people.filter((person) => person.names.length === 0 && (snapshots.get(person.id)?.length ?? 0) > 0).map((person) => (person.face as TrackedFace).track));
      latest = observe(line, faces, onboarding, at);
      live = {
        faceCameraActive: true,
        faceWorkerReady: latest.worker.state === 'ready',
        faceStatus: statusText(latest.worker, faces.length),
        faceLastDetectedCount: faces.length,
        faceFrameWidth: line.frame.w,
        faceFrameHeight: line.frame.h,
        faceLastFaces: faces.slice(0, 16).map(liveFaceOf),
      };
      deps.publish(latest);
    },

    lost,

    async faceCall(method, args) {
      if (!deps.config().faceRecognition && method !== 'endEnrollment') throw new Error('face recognition is switched off');
      switch (method) {
        case 'beginEnrollment':
          enrollmentUntil = now() + ENROLLMENT_IDLE_MS;
          return null;
        case 'endEnrollment':
          enrollmentUntil = 0;
          return null;
        case 'captureEnrollmentSample': {
          enrollmentUntil = now() + ENROLLMENT_IDLE_MS;
          const previous = embeddingsOf(args.previous);
          // With several people in view the dashboard says whose photos (the box it was shown), as with the browser.
          const choose = studioFaceBoxOf(args.choose);
          for (let attempt = 0; attempt < ENROLLMENT_MAX_CAPTURE_ATTEMPTS; attempt += 1) {
            const captured = await deps.capture();
            const candidates = captured.faces.filter((face) => Array.isArray(face.embedding));
            const face = choose ? chosenFace(candidates, choose, captured.frame.w, captured.frame.h) : candidates.length === 1 ? candidates[0]! : null;
            if (!face?.thumbnail) {
              await delay(ENROLLMENT_CAPTURE_RETRY_DELAY_MS);
              continue;
            }
            const embedding = face.embedding!;
            return {
              embedding,
              thumbnail: face.thumbnail,
              duplicate: previous.some((sample) => cosineSimilarity(sample, embedding) >= ENROLLMENT_DUPLICATE_THRESHOLD),
            };
          }
          return null;
        }
        case 'embedPicture': {
          // An uploaded photo for someone's samples: exactly one face, or the reason (client/face/runtime.ts embedPicture).
          if (!isStudioPicture(args.image)) return { ok: false, reason: NOT_A_STUDIO_PICTURE };
          const detected = await deps.detect(Buffer.from(args.image.slice(args.image.indexOf(',') + 1), 'base64'));
          const verdict = uploadVerdict(detected.faces.length);
          if (!verdict.ok) return verdict;
          const face = detected.faces[0]!;
          if (!Array.isArray(face.embedding) || !face.thumbnail) return { ok: false, reason: 'the face could not be read' };
          return { ok: true, sample: { embedding: face.embedding, thumbnail: face.thumbnail, duplicate: false } };
        }
        case 'saveEnrollment': {
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          if (!name) throw new Error('Enter a name before saving');
          const samples = samplesOf(args.samples);
          for (const sample of samples) deps.addFace({ name, embedding: sample.embedding, thumbnail: sample.thumbnail });
          if (samples.length > 0) deps.facesChanged();
          log(`enrolled ${name} with ${samples.length} samples from the face service's camera`);
          return samples.length;
        }
      }
      return null;
    },

    async autoEnroll(personId, name) {
      const samples = snapshots.get(personId);
      if (!samples || samples.length === 0) {
        log(`auto onboarding: no face snapshots for ${name}`);
        return;
      }
      for (const { embedding, thumbnail } of samples) deps.addFace({ name, embedding, thumbnail });
      deps.facesChanged();
      snapshots.delete(personId);
      log(`auto onboarding: remembered ${name} (${samples.length} photo${samples.length === 1 ? '' : 's'})`);
    },

    observation() {
      return latest;
    },

    liveFaces() {
      return live;
    },

    reset() {
      peopleTracker = createPeopleTracker(deps.random);
      visitorTracker = createVisitorTracker(deps.random);
      stableFaces = [];
      stableFacesAt = 0;
      emptyFrameCount = 0;
      if (lastPeopleSignature) deps.apply({ type: 'people', people: [] });
      lastPeopleSignature = '';
      lastPeopleSentAt = 0;
      snapshots.clear();
      latest = null;
      live = null;
    },
  };
}

function statusText(worker: FaceWorkerStatus, count: number): string {
  if (worker.state === 'error') return `Face service: ${worker.error ?? 'error'}`.slice(0, 300);
  if (worker.state === 'loading') return `Face service loading${worker.error ? `: ${worker.error}` : ''}`.slice(0, 300);
  return count > 0 ? `Face service: ${count} face(s), ${Math.round(worker.inferMs)} ms` : 'Face service: no faces';
}

const isEmbedding = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 && value.length <= MAX_EMBEDDING
  && value.every((n) => typeof n === 'number' && Number.isFinite(n));

/** A dashboard's earlier poses' embeddings (client/studio/runtime.ts embeddingsOf). */
function embeddingsOf(value: unknown): number[][] {
  return Array.isArray(value) ? value.filter(isEmbedding).slice(0, MAX_SAMPLES) : [];
}

/** The poses a dashboard kept, as the face library takes them (client/studio/runtime.ts samplesOf). */
function samplesOf(value: unknown): Array<{ embedding: number[]; thumbnail: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((sample: unknown) => {
    if (typeof sample !== 'object' || sample === null) return [];
    const { embedding, thumbnail } = sample as { embedding?: unknown; thumbnail?: unknown };
    return isEmbedding(embedding) && typeof thumbnail === 'string' && thumbnail.startsWith('data:image/') && thumbnail.length <= 200_000
      ? [{ embedding, thumbnail }]
      : [];
  }).slice(0, MAX_SAMPLES);
}
