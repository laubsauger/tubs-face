import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { StudioLiveStatus, StudioPulse } from '../../shared/contracts/studio.js';
import { handleStudioRoute } from '../routes/studio-routes.js';
import { handleVisionRoute } from '../routes/vision-routes.js';
import { initWebSocketServer } from '../ws/server.js';
import { PULSE_LEASE_MS, resetLive } from './live.js';
import { listenStateOf, noteHeard, resetPulse } from './pulse.js';
import { forgetObservation } from './faces.js';
import { resetStudioReports, studioSettings } from './state.js';

// In studio mode the dashboard has no mic or camera: the studio listener page
// (maybe on another machine) reports what it hears and sees, and the dashboard
// shows it. That traffic (10 reports and a few pictures a second) must cost
// nothing while nobody looks, and what the dashboard and the sentient panel's
// pulse bar show has to be what the listener just saw.

let server: http.Server;
let port = 0;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    void handleVisionRoute(request, response, url).then((done) => done || handleStudioRoute(request, response, url));
  });
  initWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await settle();
  studioSettings.enabled = false;
  resetStudioReports();
  resetLive();
  resetPulse();
  forgetObservation();
});

interface Client {
  messages: Array<Record<string, unknown>>;
  send(message: unknown): void;
  of(type: string): Array<Record<string, unknown>>;
  close(): void;
}

async function connect(query = ''): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  sockets.push(socket);
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    messages,
    send: (message) => socket.send(JSON.stringify(message)),
    of: (type) => messages.filter((message) => message.type === type),
    close: () => socket.close(),
  };
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

const STATUS: StudioLiveStatus = {
  micReady: true,
  micDenied: false,
  micLevel: 0.35,
  recording: false,
  listenState: 'Listening',
  voiceLastTranscript: '',
  audioPlaying: false,
  faceCameraActive: true,
  faceWorkerReady: true,
  faceWorkerBusy: false,
  faceStatus: 'Detected 1 face(s)',
  faceLastInferenceMs: 180,
  faceLastEmbeddingsExtracted: 1,
  faceLastEmbeddingsReused: 0,
  faceLastDetectedCount: 1,
  faceFrameWidth: 960,
  faceFrameHeight: 540,
  faceLastFaces: [{
    box: [480, 135, 672, 405],
    score: 0.98,
    name: 'Flo',
    match: { name: 'Flo', score: 0.87 },
    matches: [{ name: 'Flo', score: 0.87 }, { name: 'Dimi', score: 0.41 }],
    // Never relayed: the page's embedding stays on the page.
    ...({ embedding: [0.1, 0.2] } as object),
  }],
};
const report = (status: StudioLiveStatus | null = STATUS) => ({ type: 'studio_live', actor: 'main', status, speaking: false });
const FRAME = { type: 'studio_frame', actor: 'main', frame: 'data:image/jpeg;base64,/9j/AAAA', width: 320, height: 180 };
const pulse = async () => (await (await fetch(`http://127.0.0.1:${port}/studio/pulse`)).json()) as StudioPulse;

describe('the studio listener\'s live state', () => {
  it('is not asked for and goes nowhere while nobody watches', async () => {
    studioSettings.enabled = true;
    const dashboard = await connect('?role=spectator');
    const listener = await connect('?studio=main');
    await settle();
    // Nobody watches: the listener is not even told (it starts out sending nothing).
    expect(listener.of('studio_watch')).toEqual([]);
    // Even if it sent anyway, nobody gets it.
    listener.send(report());
    listener.send(FRAME);
    await settle();
    expect([...dashboard.of('studio_live'), ...dashboard.of('studio_frame'), ...dashboard.of('studio_pulse')]).toEqual([]);
  });

  it('is asked for while a dashboard watches, reaches only that dashboard, and stops when it stops watching or goes', async () => {
    studioSettings.enabled = true;
    const listener = await connect('?studio=main');
    const dashboard = await connect('?role=spectator');
    const other = await connect('?role=spectator');
    dashboard.send({ type: 'studio_watch', live: true, video: true });
    await settle();
    expect(listener.of('studio_watch').at(-1)).toEqual({ type: 'studio_watch', live: true, video: true });

    listener.send(report());
    listener.send(FRAME);
    await settle();
    const relayed = dashboard.of('studio_live')[0] as { status: StudioLiveStatus };
    expect(relayed.status.faceLastFaces[0]).toEqual({
      box: [480, 135, 672, 405], score: 0.98, name: 'Flo', match: { name: 'Flo', score: 0.87 }, matches: [{ name: 'Flo', score: 0.87 }, { name: 'Dimi', score: 0.41 }],
    });
    expect(dashboard.of('studio_frame')).toEqual([FRAME]);
    expect(dashboard.of('studio_pulse')).toHaveLength(1);
    expect([...other.of('studio_live'), ...other.of('studio_frame')]).toEqual([]);

    // The camera only while it is on screen.
    dashboard.send({ type: 'studio_watch', live: true, video: false });
    await settle();
    expect(listener.of('studio_watch').at(-1)).toEqual({ type: 'studio_watch', live: true, video: false });
    dashboard.close();
    await settle();
    expect(listener.of('studio_watch').at(-1)).toEqual({ type: 'studio_watch', live: false, video: false });
  });

  it('is asked for at once from a listener page that (re)connects while a dashboard watches', async () => {
    studioSettings.enabled = true;
    const dashboard = await connect('?role=spectator');
    dashboard.send({ type: 'studio_watch', live: true, video: false });
    await settle();
    const listener = await connect('?studio=main');
    await settle();
    expect(listener.of('studio_watch')).toEqual([{ type: 'studio_watch', live: true, video: false }]);
  });

  it('is asked for while someone polls GET /studio/pulse, and not once the polls stop', async () => {
    studioSettings.enabled = true;
    const listener = await connect('?studio=main');
    await pulse();
    await settle();
    expect(listener.of('studio_watch').at(-1)).toMatchObject({ live: true, video: false });
    await settle(PULSE_LEASE_MS + 150);
    expect(listener.of('studio_watch').at(-1)).toMatchObject({ live: false, video: false });
  });

  it('tells the dashboards when the listener page goes, so nothing stale stays on screen', async () => {
    studioSettings.enabled = true;
    const listener = await connect('?studio=main');
    const dashboard = await connect('?role=spectator');
    dashboard.send({ type: 'studio_watch', live: true, video: false });
    await settle();
    listener.send(report());
    await settle();
    listener.close();
    await settle();
    expect(dashboard.of('studio_live').at(-1)).toEqual({ type: 'studio_live', actor: 'main', status: null, speaking: false });
  });
});

describe('GET /studio/pulse', () => {
  it('shows the match the listener just reported: name, how sure, where in the picture', async () => {
    studioSettings.enabled = true;
    studioSettings.micSource = 'site:cam-flo-mac';
    const listener = await connect('?studio=main');
    const small = await connect('?studio=small');
    const dashboard = await connect('?role=spectator');
    dashboard.send({ type: 'studio_watch', live: true, video: false });
    await settle();
    noteHeard('Hello Tubs', 1_000);
    small.send({ type: 'studio_state', actor: 'small', speaking: true, expr: 'happy', mood: { pos: 0.5, neg: 0, arousal: 0.3 }, ts: 1 });
    // Only a head's own page says whether it talks: this one is ignored.
    listener.send({ type: 'studio_state', actor: 'small', speaking: false, expr: 'idle', mood: { pos: 0, neg: 0, arousal: 0 }, ts: 1 });
    await settle();
    listener.send(report());
    await settle();
    const now = await pulse();
    expect(now).toMatchObject({
      mic: { source: 'site:cam-flo-mac', level: 0.35, state: 'speaking' },
      speaking: 'small',
      heard: { text: 'Hello Tubs', t: 1_000 },
      seen: [{ name: 'Flo', prob: 0.87, box: [0.5, 0.25, 0.2, 0.5] }],
      vision: { provider: expect.any(String) },
    });
    // The shape the pulse bar builds on, plus faceWorker (additive): nobody in view is not the same as not looking.
    expect(Object.keys(now).sort()).toEqual(['faceWorker', 'heard', 'mic', 'seen', 'speaking', 't', 'vision']);
    // The push carries the same shape.
    expect((dashboard.of('studio_pulse').at(-1) as { pulse: StudioPulse }).pulse.seen).toEqual(now.seen);
    studioSettings.micSource = 'local';
  });

  it('names the mic state the way the pulse bar shows it', () => {
    expect(listenStateOf(null, false)).toBe('off');
    expect(listenStateOf({ ...STATUS, micReady: false }, false)).toBe('off');
    expect(listenStateOf(STATUS, false)).toBe('listening');
    expect(listenStateOf({ ...STATUS, recording: true }, false)).toBe('hearing');
    expect(listenStateOf({ ...STATUS, listenState: 'Thinking...' }, false)).toBe('thinking');
    expect(listenStateOf({ ...STATUS, listenState: 'Thinking...' }, true)).toBe('speaking');
  });
});

// One shape from either producer (docs/face-service.md): what the listener's
// browser worker saw reaches the watching dashboards, GET /studio/faces and
// the pulse; nobody else may put faces there.
describe('face observations', () => {
  const observation = {
    t: 5_000, source: 'site:cam-test', frame: { w: 960, h: 540 },
    faces: [{ track: 1, box: [0.5, 0.25, 0.2, 0.5], score: 0.82, candidates: [{ name: 'Flo', sim: 0.74 }, { name: 'Tihana', sim: 0.13 }], decision: 'match', name: 'Flo' }],
    worker: { kind: 'browser', state: 'ready', backend: 'wasm', threads: 8, inferMs: 120, fps: 0.5, where: 'the studio listener page' },
  };

  it('go from the listener page to watching dashboards, GET /studio/faces and the pulse', async () => {
    studioSettings.enabled = true;
    const listener = await connect('?studio=main');
    const dashboard = await connect('?role=spectator');
    const other = await connect('?role=spectator');
    dashboard.send({ type: 'studio_watch', live: true, video: false });
    await settle();
    listener.send({ type: 'face_observation', observation });
    await settle();
    expect(dashboard.of('face_observation')).toEqual([{ type: 'face_observation', observation }]);
    expect(other.of('face_observation')).toEqual([]);
    expect(await (await fetch(`http://127.0.0.1:${port}/studio/faces`)).json()).toEqual(observation);
    const now = await pulse();
    expect(now.seen).toEqual([{ name: 'Flo', prob: 0.74, box: [0.5, 0.25, 0.2, 0.5] }]);
    expect(now.faceWorker).toMatchObject({ state: 'ready', checksPerSecond: 0.5, lastCheckAt: 5_000 });
  });

  it('are taken from the listener page only', async () => {
    studioSettings.enabled = true;
    const small = await connect('?studio=small');
    const dashboard = await connect('?role=spectator');
    small.send({ type: 'face_observation', observation });
    dashboard.send({ type: 'face_observation', observation });
    await settle();
    expect((await fetch(`http://127.0.0.1:${port}/studio/faces`)).status).toBe(404);
  });
});

describe('onboarding with the studio camera', () => {
  it('goes from the dashboard to the listener page and the answer back to that dashboard only', async () => {
    studioSettings.enabled = true;
    const listener = await connect('?studio=main');
    const dashboard = await connect('?role=spectator');
    const other = await connect('?role=spectator');
    dashboard.send({ type: 'studio_face_call', id: 'd1', method: 'captureEnrollmentSample', args: { previous: [] } });
    await settle();
    const call = listener.of('studio_face_call')[0] as { id: string; method: string; args: unknown };
    expect(call).toMatchObject({ method: 'captureEnrollmentSample', args: { previous: [] } });
    listener.send({ type: 'studio_face_result', id: call.id, ok: true, value: { embedding: [0.1], thumbnail: 'data:image/jpeg;base64,AA', duplicate: false } });
    await settle();
    expect(dashboard.of('studio_face_result')).toEqual([{ type: 'studio_face_result', id: 'd1', ok: true, value: { embedding: [0.1], thumbnail: 'data:image/jpeg;base64,AA', duplicate: false } }]);
    expect(other.of('studio_face_result')).toEqual([]);
  });

  it('fails at once without a listener page, and when it goes away mid-call', async () => {
    studioSettings.enabled = true;
    const dashboard = await connect('?role=spectator');
    dashboard.send({ type: 'studio_face_call', id: 'd1', method: 'beginEnrollment' });
    await settle();
    expect(dashboard.of('studio_face_result')).toEqual([{ type: 'studio_face_result', id: 'd1', ok: false, error: 'the studio listener page is not connected' }]);
    const listener = await connect('?studio=main');
    dashboard.send({ type: 'studio_face_call', id: 'd2', method: 'captureEnrollmentSample' });
    await settle();
    listener.close();
    await settle();
    expect(dashboard.of('studio_face_result').at(-1)).toMatchObject({ id: 'd2', ok: false, error: expect.stringContaining('went away') });
  });
});
