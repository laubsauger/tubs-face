import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EnrolledFace } from '../../shared/contracts/faces.js';
import type { FaceObservation } from '../../shared/contracts/studio.js';
import { isFaceObservation } from '../../shared/guards/index.js';
import { createRecognition, type ListenerEffect, type RecognitionConfig } from './recognition.js';
import type { ServiceCapture, ServiceFace, ServiceHealth, ServiceLine } from './service.js';

// The face service only finds and embeds faces; the server decides who they
// are and what that means, exactly as the studio listener page did for its
// browser worker: the same matching thresholds on real ArcFace embeddings, the
// same messages for who is in view, greetings and vision pictures, and the same
// onboarding answers. A dashboard must not be able to tell which one ran.

interface FixtureFace { box: number[]; embedding: number[] }
const fixtures = JSON.parse(readFileSync(new URL('../../../tests/fixtures/faces/browser-embeddings.json', import.meta.url), 'utf8')) as {
  images: Record<string, { width: number; height: number; faces: FixtureFace[] }>;
};
const embeddingOf = (image: string, index = 0) => fixtures.images[image]!.faces[index]!.embedding;

const READY: ServiceHealth = { state: 'ready', backend: 'CoreML', fps: 5, inferMs: 40, frames: 10, source: 'site:cam-1', camera: 'ok', where: 'studio-mac', threads: 4 };

function line(faces: Array<Partial<ServiceFace> & { embedding: number[] | null }>, t = 1000, status: ServiceHealth = READY): ServiceLine {
  return {
    t,
    source: 'site:cam-1',
    frame: { w: 960, h: 540 },
    faces: faces.map((face, index) => ({ track: face.track ?? index + 1, box: face.box ?? [100 + index * 300, 100, 260 + index * 300, 300], score: face.score ?? 0.9, embedding: face.embedding })),
    status,
  };
}

function setup(options: { library?: EnrolledFace[]; config?: Partial<RecognitionConfig>; capture?: () => Promise<ServiceCapture> } = {}) {
  const applied: ListenerEffect[] = [];
  const published: FaceObservation[] = [];
  const added: Array<{ name: string; embedding: number[]; thumbnail?: string }> = [];
  let changed = 0;
  let clock = 1_000_000;
  const frames: number[] = [];
  const recognition = createRecognition({
    apply: (message) => applied.push(message),
    publish: (observation) => published.push(observation),
    library: () => options.library ?? [],
    addFace: (face) => added.push(face),
    facesChanged: () => { changed += 1; },
    inConversation: () => false,
    config: () => ({ autoEnrollEnabled: false, visionProvider: 'openai', visionMaxPx: 512, visionRefreshMs: 30_000, ...options.config }),
    frame: async (maxPx) => { frames.push(maxPx); return 'data:image/jpeg;base64,AAAA'; },
    thumbnail: async () => 'data:image/jpeg;base64,BBBB',
    capture: options.capture ?? (async () => ({ frame: { w: 960, h: 540 }, faces: [] })),
    where: () => 'studio-mac:3004',
    now: () => clock,
    delay: async () => undefined,
    random: () => 0.5,
    log: () => undefined,
  });
  return {
    recognition, applied, published, added, frames,
    changed: () => changed,
    advance: (ms: number) => { clock += ms; },
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

const obamaLibrary: EnrolledFace[] = [{ id: 'o1', name: 'Obama', embedding: embeddingOf('obama-2012.jpg') }];

describe('recognition on the server', () => {
  it('recognises an enrolled face from another photo, and leaves strangers unknown (real ArcFace embeddings, the browser thresholds)', () => {
    const { recognition, published } = setup({ library: obamaLibrary });
    recognition.handleLine(line([
      { embedding: embeddingOf('obama-2009.jpg') },
      { embedding: embeddingOf('apollo-11-crew.jpg', 0) },
      { embedding: embeddingOf('biden-2021.jpg') },
    ]));
    const faces = published.at(-1)!.faces;
    expect(faces[0]).toMatchObject({ decision: 'match', name: 'Obama' });
    // Another photo of the same man: over the 0.65 threshold, but well below 1.
    expect(faces[0]!.candidates[0]!.sim).toBeGreaterThan(0.65);
    expect(faces[0]!.candidates[0]!.sim).toBeLessThan(0.9);
    expect(faces[1]).toMatchObject({ decision: 'unknown' });
    expect(faces[1]!.name).toBeUndefined();
    expect(faces[2]!.decision).toBe('unknown');
    expect(faces[2]!.candidates[0]!.sim).toBeLessThan(0.3);
  });

  it('holds back a match that is not clear of the second name (the 0.01 margin)', () => {
    const twin = embeddingOf('obama-2012.jpg').map((value, index) => value + (index % 7 === 0 ? 1e-4 : 0));
    const { recognition, published } = setup({ library: [...obamaLibrary, { id: 'x', name: 'Double', embedding: twin }] });
    recognition.handleLine(line([{ embedding: embeddingOf('obama-2009.jpg') }]));
    expect(published.at(-1)!.faces[0]).toMatchObject({ decision: 'unknown' });
    expect(published.at(-1)!.faces[0]!.candidates.map((c) => c.name).sort()).toEqual(['Double', 'Obama']);
  });

  it('sends an observation every frame that validates, boxes in 0..1 of the frame', () => {
    const { recognition, published } = setup({ library: obamaLibrary });
    recognition.handleLine(line([{ box: [96, 54, 288, 324], embedding: embeddingOf('obama-2009.jpg') }]));
    const observation = published.at(-1)!;
    expect(isFaceObservation(observation)).toBe(true);
    expect(observation.faces[0]!.box).toEqual([0.1, 0.1, 0.2, 0.5]);
    expect(observation.worker).toMatchObject({ kind: 'service', state: 'ready', backend: 'CoreML', inferMs: 40, fps: 5, where: 'studio-mac:3004' });
    expect(JSON.stringify(observation)).not.toContain('embedding');
  });

  it('tells the server who is in view and greets a first arrival with a picture, as the listener page did', async () => {
    const { recognition, applied, frames, flush } = setup({ library: obamaLibrary });
    recognition.handleLine(line([{ embedding: embeddingOf('obama-2009.jpg') }]));
    await flush();
    const people = applied.find((message) => message.type === 'people');
    expect(people).toMatchObject({ type: 'people', people: [{ names: ['Obama'], position: 'left' }] });
    expect(frames).toEqual([512]);
    expect(applied.find((message) => message.type === 'appearance_frame')).toMatchObject({ type: 'appearance_frame', faces: ['Obama'], count: 1, frame: 'data:image/jpeg;base64,AAAA' });
  });

  it('refreshes the picture only while faces stay in view, after visionRefreshMs', async () => {
    const { recognition, applied, advance, flush } = setup({ library: obamaLibrary });
    const obama = { embedding: embeddingOf('obama-2009.jpg') };
    recognition.handleLine(line([obama]));
    advance(10_000);
    recognition.handleLine(line([obama]));
    await flush();
    expect(applied.filter((message) => message.type === 'camera_frame')).toHaveLength(0);
    advance(21_000);
    recognition.handleLine(line([obama]));
    await flush();
    expect(applied.filter((message) => message.type === 'camera_frame')).toHaveLength(1);
    // Nobody in view: no picture, however long.
    advance(5000);
    recognition.handleLine(line([]));
    recognition.handleLine(line([]));
    recognition.handleLine(line([]));
    advance(60_000);
    recognition.handleLine(line([]));
    await flush();
    expect(applied.filter((message) => message.type === 'camera_frame' || message.type === 'appearance_frame')).toHaveLength(2);
  });

  it('sends no picture anywhere with vision off', async () => {
    const { recognition, applied, frames, flush } = setup({ library: obamaLibrary, config: { visionProvider: 'off' } });
    recognition.handleLine(line([{ embedding: embeddingOf('obama-2009.jpg') }]));
    await flush();
    expect(frames).toEqual([]);
    expect(applied.some((message) => message.type === 'appearance_frame' || message.type === 'camera_frame')).toBe(false);
  });

  it('lets go of everyone when the service goes away, and says why', () => {
    const { recognition, applied, published } = setup({ library: obamaLibrary });
    recognition.handleLine(line([{ embedding: embeddingOf('obama-2009.jpg') }]));
    recognition.lost('the face service is not answering: connection refused');
    expect(applied.at(-1)).toEqual({ type: 'people', people: [] });
    expect(published.at(-1)!.faces).toEqual([]);
    expect(published.at(-1)!.worker).toMatchObject({ state: 'error', error: 'the face service is not answering: connection refused' });
    expect(recognition.liveFaces()).toMatchObject({ faceLastDetectedCount: 0, faceWorkerReady: false });
  });

  it('marks unknown faces as onboarding while an onboarding dialog is open', async () => {
    const { recognition, published } = setup({ library: obamaLibrary });
    await recognition.faceCall('beginEnrollment', {});
    recognition.handleLine(line([{ embedding: embeddingOf('obama-2009.jpg') }, { embedding: embeddingOf('biden-2021.jpg') }]));
    expect(published.at(-1)!.faces.map((face) => face.decision)).toEqual(['match', 'onboarding']);
    await recognition.faceCall('endEnrollment', {});
    recognition.handleLine(line([{ embedding: embeddingOf('obama-2009.jpg') }, { embedding: embeddingOf('biden-2021.jpg') }]));
    expect(published.at(-1)!.faces.map((face) => face.decision)).toEqual(['match', 'unknown']);
  });

  it('onboards from the service camera: one face per pose, duplicates flagged, saved to the library once', async () => {
    const biden = embeddingOf('biden-2021.jpg');
    const captures: ServiceCapture[] = [
      { frame: { w: 960, h: 540 }, faces: [] },
      { frame: { w: 960, h: 540 }, faces: [{ track: 1, box: [1, 1, 50, 50], score: 0.9, embedding: biden, thumbnail: 'data:image/jpeg;base64,T1' }] },
      { frame: { w: 960, h: 540 }, faces: [{ track: 1, box: [1, 1, 50, 50], score: 0.9, embedding: biden, thumbnail: 'data:image/jpeg;base64,T2' }] },
    ];
    const { recognition, added, changed } = setup({ capture: async () => captures.shift() ?? { frame: { w: 1, h: 1 }, faces: [] } });
    // A pose without a face is tried again (the browser's retries), then taken.
    const first = await recognition.faceCall('captureEnrollmentSample', { previous: [] }) as { embedding: number[]; thumbnail: string; duplicate: boolean };
    expect(first).toEqual({ embedding: biden, thumbnail: 'data:image/jpeg;base64,T1', duplicate: false });
    const second = await recognition.faceCall('captureEnrollmentSample', { previous: [first.embedding] }) as { duplicate: boolean };
    expect(second.duplicate).toBe(true);
    // Nobody (or several) for every attempt: no pose.
    expect(await recognition.faceCall('captureEnrollmentSample', { previous: [] })).toBeNull();
    await expect(recognition.faceCall('saveEnrollment', { name: '  ', samples: [first] })).rejects.toThrow('Enter a name before saving');
    expect(await recognition.faceCall('saveEnrollment', { name: ' Joe ', samples: [first, { embedding: 'nope', thumbnail: 'x' }] })).toBe(1);
    expect(added).toEqual([{ name: 'Joe', embedding: biden, thumbnail: 'data:image/jpeg;base64,T1' }]);
    expect(changed()).toBe(1);
  });

  it('auto onboarding: snapshots of an unnamed visitor become their library entry once they say their name', async () => {
    const { recognition, applied, added, advance, flush } = setup({ config: { autoEnrollEnabled: true } });
    const face = { box: [100, 50, 300, 350] as [number, number, number, number], embedding: embeddingOf('harris-2021.jpg') };
    recognition.handleLine(line([face]));
    await flush();
    advance(5000);
    recognition.handleLine(line([face]));
    await flush();
    const person = [...applied].reverse().find((message) => message.type === 'people');
    expect(person).toMatchObject({ people: [{ names: [], snapshots: 1, thumbnail: 'data:image/jpeg;base64,BBBB' }] });
    const id = (person as Extract<ListenerEffect, { type: 'people' }>).people[0]!.id;
    await recognition.autoEnroll(id, 'Kamala');
    expect(added).toEqual([{ name: 'Kamala', embedding: face.embedding, thumbnail: 'data:image/jpeg;base64,BBBB' }]);
  });
});
