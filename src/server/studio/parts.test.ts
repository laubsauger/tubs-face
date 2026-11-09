import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { HealthParts } from '../../shared/contracts/http.js';
import type { StudioResponse } from '../../shared/contracts/studio.js';
import { studioParts, type PartsSources, type RecognitionSource } from './parts.js';

// The operator (and the sentient panel) read GET /studio parts to see what
// runs where when something is off: which box the fleet picked for vision,
// whether Ming is up, which device the mic is. A part that does not work must
// say so (ok false) rather than look fine or break the response.

const HEALTH: HealthParts = {
  node: { state: 'up' },
  speech: { state: 'up' },
  ming: { state: 'up', needed: true },
  studio: { state: 'up' },
};
const STUDIO: StudioResponse = {
  enabled: true,
  site: 'http://127.0.0.1:8889',
  micSource: 'site:cam-flo-mac',
  visionSource: 'site:cam-flo-mac',
  launch: 'chrome',
  actors: [
    { id: 'main', stream: 'tubs-main', publishing: true, cadence: { renderFps: 59.8, renderMaxGapMs: 30, renderStalls: 0, encodedFps: 29.9, visible: true, focused: false } },
    { id: 'small', stream: 'tubs-small', publishing: true, cadence: { renderFps: 60, renderMaxGapMs: 28, renderStalls: 0, encodedFps: 30, visible: true, focused: false } },
  ],
  mic: { source: 'site:cam-flo-mac', listening: true },
};
const base: PartsSources = {
  config: {
    llmModel: 'gemini-3-flash',
    kokoroVoice: 'ming:friend',
    secondaryVoice: 'ming:friend-b',
    dualHeadEnabled: true,
    dualHeadMode: 'llm_directed',
    visionProvider: 'openai',
    visionModel: 'qwen3-vl:4b-instruct',
    visionBaseUrl: 'fleet:vision',
    visionDescriptions: true,
    relationshipsEnabled: true,
  },
  env: {},
  studio: STUDIO,
  health: HEALTH,
  llm: { ok: true, ms: 840, model: 'gemini-3-flash', at: 1 },
  llmReady: true,
  vision: null,
  fleetBase: null,
  speechPort: 3102,
  mingUrl: 'http://127.0.0.1:3003',
  hostname: 'studio-mac.local',
};
const part = (sources: PartsSources, id: string) => studioParts(sources).find((entry) => entry.id === id)!;

describe('studioParts', () => {
  it('lists every part, in the order the card and the sentient panel show them', () => {
    expect(studioParts(base).map((entry) => entry.id)).toEqual(['brain', 'voices', 'realtime', 'vision', 'mic', 'faces', 'site', 'camera', 'recognition', 'relationships']);
  });

  it('shows fleet:vision as the box the hub picked, and as not working while no box is known', () => {
    expect(part(base, 'vision')).toMatchObject({ where: 'fleet:vision (no box found yet)', ok: false });
    const picked = { ...base, fleetBase: 'http://192.168.1.20:11434/v1', vision: { at: 1, kind: 'refresh' as const, ok: true, ms: 910, provider: 'openai' as const, model: 'qwen3-vl:4b-instruct', where: '192.168.1.20:11434', text: 'A person.' } };
    expect(part(picked, 'vision')).toEqual({ id: 'vision', label: 'Vision', where: '192.168.1.20:11434', ok: true, detail: 'qwen3-vl:4b-instruct · 910 ms · when a face is detected' });
    // A last call that failed is not ok, with its reason.
    const failed = { ...picked, vision: { ...picked.vision, ok: false, error: 'timed out after 8000 ms' } };
    expect(part(failed, 'vision')).toMatchObject({ ok: false, detail: 'qwen3-vl:4b-instruct · timed out after 8000 ms · when a face is detected' });
  });

  it('names this machine for work on loopback, with the voices and how the heads publish', () => {
    expect(part(base, 'voices')).toEqual({ id: 'voices', label: 'Voices', where: 'studio-mac:3003', ok: true, detail: 'ming:friend, ming:friend-b' });
    expect(part({ ...base, health: { ...HEALTH, ming: { state: 'starting', needed: true } } }, 'voices').ok).toBe(false);
    expect(part(base, 'realtime')).toMatchObject({ where: 'studio-mac:3102', ok: true });
    expect(part(base, 'faces')).toEqual({ id: 'faces', label: 'Face pages', where: 'Chrome @ studio-mac', ok: true, detail: 'main 30 fps · small 30 fps' });
    expect(part(base, 'mic')).toEqual({ id: 'mic', label: 'Mic', where: 'cam-flo-mac @ studio-mac:8889', ok: true });
    expect(part({ ...base, studio: { ...STUDIO, micSource: 'local:Scarlett 2i2 USB', mic: { source: 'local:Scarlett 2i2 USB', listening: false, error: 'No input device labelled "Scarlett 2i2 USB"' } } }, 'mic'))
      .toEqual({ id: 'mic', label: 'Mic', where: 'Scarlett 2i2 USB @ studio-mac', ok: false, detail: 'No input device labelled "Scarlett 2i2 USB"' });
  });

  it('says what is wrong with the site node and the brain', () => {
    const refused = { ...STUDIO, actors: STUDIO.actors.map((actor) => ({ ...actor, publishing: false, error: 'the site node refused the login (401)' })) };
    expect(part({ ...base, studio: refused }, 'site')).toMatchObject({ where: 'studio-mac:8889', ok: false, detail: 'the site node refused the login (401)' });
    expect(part({ ...base, studio: refused }, 'faces').ok).toBe(false);
    expect(part({ ...base, llmReady: false, llm: null }, 'brain')).toMatchObject({ where: 'generativelanguage.googleapis.com', ok: false, detail: 'gemini-3-flash · no GEMINI_API_KEY' });
    expect(part({ ...base, env: { LLM_PROVIDER: 'ollama', OLLAMA_HOST: 'http://192.168.1.30:11434', REALTIME_LLM_MODEL: 'qwen3:8b' }, llm: null }, 'brain'))
      .toMatchObject({ where: '192.168.1.30:11434', ok: null, detail: 'qwen3:8b' });
  });

  // The user could not tell whether the face worker ran at all. The part says
  // where it runs and how, ok only while it actually checks pictures.
  it('shows the face worker: ok while it checks pictures, not ok while loading or stalled, off when switched off', () => {
    const now = 100_000;
    const worker = { state: 'ready' as const, camera: true, checksPerSecond: 2, lastCheckAt: now - 400, lastFaceAt: now - 400, faces: 1, best: { name: 'Flo', prob: 0.74 }, threads: 8, inferenceMs: 95 };
    const withWorker = (faceWorker: typeof worker | null, studio = STUDIO) => ({ ...base, studio, faceWorker, libraryPeople: 10, now });
    expect(part(withWorker(worker), 'recognition')).toEqual({
      id: 'recognition', label: 'Face recognition', where: 'Chrome @ studio-mac', ok: true, detail: 'SCRFD+ArcFace · 8 threads · 95 ms · 2 fps · 10 people',
    });
    expect(part(withWorker({ ...worker, state: 'loading', lastCheckAt: null, detail: 'Detection model: Downloaded & cached' } as never), 'recognition'))
      .toMatchObject({ ok: false, detail: 'loading: Detection model: Downloaded & cached' });
    expect(part(withWorker({ ...worker, lastCheckAt: now - 30_000, checkSkip: 'voice rendering' } as never), 'recognition'))
      .toMatchObject({ ok: false, detail: expect.stringContaining('no check for 30 s (voice rendering)') });
    expect(part(withWorker(null), 'recognition')).toMatchObject({ ok: false, detail: 'the listener page is not connected' });
    expect(part(withWorker(worker, { ...STUDIO, switches: { camera: true, faceRecognition: false, visionDescriptions: true, relationships: true, mic: true } }), 'recognition'))
      .toMatchObject({ where: 'off', ok: null, detail: 'switched off (faces are still detected, for descriptions)' });
  });

  it('marks what is not in use as such, not as broken', () => {
    const off = { ...base, config: { ...base.config, visionProvider: 'off' as const }, studio: { ...STUDIO, enabled: false } };
    for (const id of ['vision', 'mic', 'faces', 'site']) expect(part(off, id).ok).toBeNull();
  });
});

describe('the recognition part with the face service', () => {
  // Face recognition used to fail silently inside a Chrome page ("LOADING
  // WORKER" for ever). With FACE_SERVICE the card says where the service runs
  // and what is wrong with it, even before its first frame.
  const READY = { state: 'ready' as const, backend: 'CoreML', fps: 5, inferMs: 40.4, frames: 99, source: 'site:cam-flo-mac', camera: 'ok', where: 'studio-mac' };
  const up = { mode: 'local' as const, where: 'studio-mac:3004', health: READY, error: null };
  const withService = (service: RecognitionSource['service'], recognizer: RecognitionSource['recognizer'] = 'service'): PartsSources =>
    ({ ...base, libraryPeople: 10, recognition: { recognizer, service } });

  it('shows the service host and its numbers, in the place the card has for recognition', () => {
    expect(studioParts(withService(up)).map((entry) => entry.id)).toEqual(['brain', 'voices', 'realtime', 'vision', 'mic', 'faces', 'site', 'camera', 'recognition', 'relationships']);
    expect(part(withService(up), 'recognition')).toEqual({
      id: 'recognition', label: 'Face recognition', where: 'studio-mac:3004', ok: true, detail: 'SCRFD+ArcFace · CoreML · 40 ms · 5 fps · 10 people',
    });
  });

  it('is not ok, with the reason, when the service is down, failing or gets no frames', () => {
    expect(part(withService({ ...up, health: null, error: 'connection refused (not running?)' }), 'recognition'))
      .toMatchObject({ where: 'studio-mac:3004', ok: false, detail: 'face service not answering: connection refused (not running?)' });
    expect(part(withService({ ...up, health: { ...READY, state: 'error', error: 'could not download the face models from huggingface.co (HTTP Error 503); retrying in 30 s' } }), 'recognition'))
      .toMatchObject({ ok: false, detail: 'could not download the face models from huggingface.co (HTTP Error 503); retrying in 30 s' });
    expect(part(withService({ ...up, health: { ...READY, camera: 'no frames', error: 'method DESCRIBE failed: 404 Not Found' } }), 'recognition'))
      .toMatchObject({ ok: false, detail: 'method DESCRIBE failed: 404 Not Found' });
    expect(part(withService({ ...up, health: { ...READY, camera: 'no frames' } }), 'recognition'))
      .toMatchObject({ ok: false, detail: 'SCRFD+ArcFace · CoreML · no frames from the camera · 10 people' });
    expect(part(withService({ mode: 'fleet', where: null, health: null, error: 'fleet:faces: the hub lists no face service box (or does not answer)' }), 'recognition'))
      .toMatchObject({ where: 'fleet:faces (no box found yet)', ok: false });
  });

  it('shows the model download while loading, as not known yet rather than broken', () => {
    expect(part(withService({ ...up, health: { ...READY, state: 'loading', download: { file: 'w600k_r50.onnx', pct: 45, mb: 78.5, totalMb: 174.4 } } }), 'recognition'))
      .toMatchObject({ ok: null, detail: 'downloading w600k_r50.onnx 45% (78.5 MB)' });
  });

  it('follows the switches: off with the camera or recognition switched off, whatever the service says', () => {
    const studio = { ...STUDIO, switches: { camera: true, faceRecognition: false, visionDescriptions: false, relationships: true, mic: true } };
    expect(part({ ...withService(up), studio }, 'recognition')).toMatchObject({ where: 'off', ok: null });
    expect(part({ ...withService(up), studio: { ...STUDIO, switches: { ...studio.switches, faceRecognition: true, camera: false } } }, 'recognition')).toMatchObject({ where: 'off', ok: null });
  });
});

describe('GET /studio', () => {
  it('carries the parts', async () => {
    const { handleStudioRoute } = await import('../routes/studio-routes.js');
    const server = http.createServer((request, response) => {
      void handleStudioRoute(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const body = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/studio`)).json()) as StudioResponse;
      expect(body.parts?.map((entry) => entry.id)).toEqual(['brain', 'voices', 'realtime', 'vision', 'mic', 'faces', 'site', 'camera', 'recognition', 'relationships']);
      for (const entry of body.parts ?? []) expect(typeof entry.where).toBe('string');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
