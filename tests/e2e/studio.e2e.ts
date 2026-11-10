import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { MOCK, chunk, instrumentAudio, now, openFace, received, resetMock, send, speechAudio, tone } from './helpers.js';
import { fakeSiteNode, openStudio, setStudio } from './studio-helpers.js';
import { DEFAULT_CONFIG } from '../../src/client/glitch/constants.js';
import { STUDIO_LAYOUT, faceBox } from '../../src/client/glitch/pixel-grid.js';
import { SLEEP_GAZE_MAX } from '../../src/client/face/sleep-life.js';

// Studio mode (sentient-studio contract sections 5-6): a page per head,
// published to the site node, the mic from a selectable source, and gaze and
// presence from a director. The mock plays the Tubs server; the site node
// (mediamtx) is answered inside the page.

/**
 * In-page stand-ins for WebRTC and the mic: the default mic and the site
 * node's mic stream are tones made in the page, silent until a test "talks"
 * into one of them. RTCPeerConnection hands a WHEP (receive) session the site
 * tone and connects at once; the HTTP side still goes through fakeSiteNode.
 */
async function fakeMediaAndWebRtc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const context = new AudioContext();
    const source = (name: string) => {
      const gain = new GainNode(context, { gain: 0 });
      const tone = new OscillatorNode(context, { frequency: 220 });
      tone.connect(gain);
      tone.start();
      const out = context.createMediaStreamDestination();
      gain.connect(out);
      return {
        out,
        level: (value: number) => {
          void context.resume();
          gain.gain.setValueAtTime(value, context.currentTime);
          (window as unknown as Record<string, number>)[`__${name}Level`] = value;
        },
      };
    };
    const local = source('local');
    const site = source('site');
    const w = window as unknown as Record<string, unknown>;
    w.__talkLocal = local.level;
    w.__talkSite = site.level;
    w.__localTracks = [];
    void context.resume();

    const devices = navigator.mediaDevices;
    devices.getUserMedia = async (constraints) => {
      if (!constraints?.audio || constraints.video) throw new Error('only audio in this test');
      // A fresh track per call, like a real device, so a test can see it was stopped.
      const stream = new MediaStream([local.out.stream.getAudioTracks()[0]!.clone()]);
      (w.__localTracks as MediaStreamTrack[]).push(stream.getAudioTracks()[0]!);
      return stream;
    };

    class FakePeerConnection extends EventTarget {
      connectionState: RTCPeerConnectionState = 'new';
      iceGatheringState: RTCIceGatheringState = 'complete';
      localDescription: RTCSessionDescriptionInit | null = null;
      onconnectionstatechange: (() => void) | null = null;
      ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null;
      private kinds: Array<{ kind: string; direction?: string }> = [];
      addTransceiver(trackOrKind: MediaStreamTrack | string, init?: { direction?: string }) {
        const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
        this.kinds.push({ kind, ...(init?.direction ? { direction: init.direction } : {}) });
        return {
          sender: { getParameters: () => ({ encodings: [] }), setParameters: async () => {} },
          setCodecPreferences: () => {},
        };
      }
      getSenders() { return []; }
      async createOffer() { return { type: 'offer' as const, sdp: `v=0\r\n${this.kinds.map((k) => `m=${k.kind} ${k.direction ?? ''}`).join('\r\n')}\r\n` }; }
      async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
      async setRemoteDescription() {
        if (this.kinds.some((k) => k.kind === 'audio' && k.direction === 'recvonly')) {
          const track = site.out.stream.getAudioTracks()[0]!.clone();
          setTimeout(() => this.ontrack?.({ track }), 10);
        }
        if (this.kinds.some((k) => k.kind === 'video' && k.direction === 'recvonly')) {
          // A camera on the site node: a green test picture.
          const canvas = document.createElement('canvas');
          canvas.width = 64;
          canvas.height = 48;
          const g = canvas.getContext('2d')!;
          const paint = () => { g.fillStyle = '#00ff00'; g.fillRect(0, 0, 64, 48); };
          paint();
          const timer = setInterval(paint, 50);
          const track = canvas.captureStream(20).getVideoTracks()[0]!;
          track.addEventListener('ended', () => clearInterval(timer));
          setTimeout(() => this.ontrack?.({ track }), 10);
        }
        setTimeout(() => {
          this.connectionState = 'connected';
          this.onconnectionstatechange?.();
        }, 20);
      }
      close() {
        this.connectionState = 'closed';
        (window as unknown as { __closedPeers: number }).__closedPeers = ((window as unknown as { __closedPeers?: number }).__closedPeers ?? 0) + 1;
      }
    }
    (window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;
  });
}

async function talk(page: Page, where: 'Local' | 'Site', level: number): Promise<void> {
  await page.evaluate(([fn, value]) => (window as unknown as Record<string, (v: number) => void>)[fn as string]!(value as number), [`__talk${where}`, level]);
}

async function voiceUploads(request: APIRequestContext): Promise<number> {
  return (await received(request)).http.filter((entry) => entry.method === 'POST' && entry.path === '/voice').length;
}

async function interrupts(request: APIRequestContext): Promise<number> {
  return (await received(request)).ws.filter((message) => message.type === 'interrupt').length;
}

/** The face's gaze as the renderer gets it (store units: x right, y down). */
async function gaze(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const face = document.querySelector<HTMLElement>('#visual-face')!;
    return { x: Number(face.style.getPropertyValue('--gaze-x') || 0), y: Number(face.style.getPropertyValue('--gaze-y') || 0) };
  });
}

test.afterEach(async ({ request }) => {
  await resetMock(request);
});

// With studio mode off nothing about the operator face may change: it keeps
// the default mic, a director's message moves nothing, and nothing is
// published anywhere. Studio mode is something you ask for.
test('studio mode off: the operator face keeps its mic, ignores a director and publishes nothing', async ({ page, request }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __peerConnections: number; __micConstraints: unknown[] };
    w.__peerConnections = 0;
    w.__micConstraints = [];
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        w.__peerConnections += 1;
      }
    };
    const devices = navigator.mediaDevices;
    devices.getUserMedia = async (constraints) => {
      w.__micConstraints.push(constraints);
      const context = new AudioContext();
      return context.createMediaStreamDestination().stream;
    };
  });
  await openFace(page, request);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __micConstraints: unknown[] }).__micConstraints.length)).toBe(1);

  for (let i = 0; i < 8; i += 1) {
    await send(request, { type: 'studio_look', actor: 'main', gaze: [0.9, 0.6] }, { type: 'studio_presence', actor: 'main', present: true, people: 3 });
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(400);

  const { x, y } = await gaze(page);
  expect(Math.abs(x), 'the director does not move the operator face').toBeLessThan(0.2);
  expect(Math.abs(y)).toBeLessThan(0.2);
  const state = await page.evaluate(() => ({
    peers: (window as unknown as { __peerConnections: number }).__peerConnections,
    mic: (window as unknown as { __micConstraints: unknown[] }).__micConstraints,
  }));
  expect(state.peers, 'nothing published').toBe(0);
  expect(state.mic).toEqual([{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }]);
  const sent = (await received(request)).ws.map((message) => message.type);
  expect(sent.filter((type) => String(type).startsWith('studio_'))).toEqual([]);
});

// Two pages listening to one room would answer every visitor twice. Once
// studio mode is on the studio listener has the mic; the operator face lets
// go of it, and takes it back when studio mode goes off.
test('studio mode on: the operator face lets go of the mic, and takes it back when it goes off', async ({ page, request }) => {
  await fakeMediaAndWebRtc(page);
  await openFace(page, request);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __localTracks: MediaStreamTrack[] }).__localTracks.length)).toBe(1);

  await setStudio(request, { enabled: true });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __localTracks: MediaStreamTrack[] }).__localTracks[0]!.readyState)).toBe('ended');

  await setStudio(request, { enabled: false });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __localTracks: MediaStreamTrack[] }).__localTracks.map((t) => t.readyState))).toEqual(['ended', 'live']);
});

// The director steers where each head looks, but only while it keeps saying
// so. A director that stops (crashed, or done) must not leave the face staring
// at a stale point: after ~2 s it looks for itself again.
test('a studio_look drives the gaze while fresh, and a stale one releases it back to the face', async ({ page, request }) => {
  await fakeMediaAndWebRtc(page);
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');

  for (let i = 0; i < 10; i += 1) {
    // The other head's look must not move this one.
    await send(request, { type: 'studio_look', actor: 'main', gaze: [0.8, 0.5] }, { type: 'studio_look', actor: 'small', gaze: [-0.9, -0.9] });
    await page.waitForTimeout(150);
  }
  const held = await gaze(page);
  expect(held.x, 'looks right').toBeGreaterThan(0.5);
  expect(held.y, 'looks up (the director\'s y is up, the face\'s is down)').toBeLessThan(-0.3);

  // A short pause in the updates is not a release.
  await page.waitForTimeout(1000);
  expect((await gaze(page)).x).toBeGreaterThan(0.5);

  await expect.poll(async () => Math.abs((await gaze(page)).x), { timeout: 4000 }).toBeLessThan(0.4);
});

// The voice goes to the site node, so the room plays it from elsewhere and
// the mic (here the site node's) hears Tubs at full strength. Taken as a
// visitor he would interrupt or answer himself. While he talks nothing is
// transcribed; the visitor is heard as soon as he is quiet again.
test('site mic: Tubs\' own voice coming back is never taken as a visitor, who is heard once he is quiet', async ({ page, request }) => {
  await fakeMediaAndWebRtc(page);
  const site = await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await request.post(`${MOCK}/config`, { data: { vadModel: 'rms', interruptible: true } });
  await setStudio(request, { enabled: true, micSource: 'site:mic-room' });
  await expect.poll(() => site.some((r) => r.method === 'POST' && r.path === '/mic-room/whep')).toBe(true);
  await page.waitForTimeout(400);
  await request.post(`${MOCK}/__test/reset-received`);

  // Tubs talks for 3 s; the room gives his voice back at a steady level.
  await send(request, { type: 'turn_start', turnId: 't-echo' }, chunk('t-echo', 0, 'I will talk for a while, and you will hear me twice.', 3000));
  await page.waitForTimeout(150);
  await talk(page, 'Site', 0.2);
  await page.waitForTimeout(2600);
  await talk(page, 'Site', 0);
  expect(await interrupts(request), 'his echo did not cut him off').toBe(0);
  await page.waitForTimeout(2000);
  expect(await voiceUploads(request), 'his echo was not transcribed').toBe(0);

  // Quiet again: the visitor at the same level is heard.
  await talk(page, 'Site', 0.2);
  await page.waitForTimeout(1000);
  await talk(page, 'Site', 0);
  await expect.poll(() => voiceUploads(request), { timeout: 5000 }).toBe(1);
});

// Recognition is muted while he talks, but with Interruptible on someone can
// still talk over him: they just have to be clearly louder than his echo.
test('site mic: a visitor well above the echo still cuts Tubs off', async ({ page, request }) => {
  await fakeMediaAndWebRtc(page);
  const site = await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await request.post(`${MOCK}/config`, { data: { vadModel: 'rms', interruptible: true } });
  await setStudio(request, { enabled: true, micSource: 'site:mic-room' });
  await expect.poll(() => site.some((r) => r.method === 'POST' && r.path === '/mic-room/whep')).toBe(true);
  await page.waitForTimeout(400);
  await request.post(`${MOCK}/__test/reset-received`);

  await send(request, { type: 'turn_start', turnId: 't-over' }, chunk('t-over', 0, 'This is going to be a long and boring story.', 5000));
  await page.waitForTimeout(150);
  await talk(page, 'Site', 0.04);
  await page.waitForTimeout(1600);
  expect(await interrupts(request)).toBe(0);
  await talk(page, 'Site', 0.5);
  await expect.poll(() => interrupts(request), { timeout: 3000 }).toBeGreaterThan(0);
  await talk(page, 'Site', 0);
});

// The studio switches mics while the show runs (a guest mic, the room mic, a
// camera's). The switch must take effect at once, without reloading the face
// or its stream: the old source stops being heard, the new one is.
test('switching the mic source takes effect live', async ({ page, request }) => {
  await fakeMediaAndWebRtc(page);
  const site = await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await request.post(`${MOCK}/config`, { data: { vadModel: 'rms' } });
  await page.evaluate(() => { (window as unknown as { __sameDocument: boolean }).__sameDocument = true; });
  await setStudio(request, { enabled: true, micSource: 'local' });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __localTracks: MediaStreamTrack[] }).__localTracks.length)).toBe(1);
  await page.waitForTimeout(300);

  await talk(page, 'Local', 0.2);
  await page.waitForTimeout(900);
  await talk(page, 'Local', 0);
  await expect.poll(() => voiceUploads(request), { timeout: 5000 }).toBe(1);

  await setStudio(request, { micSource: 'site:mic-guest' });
  await expect.poll(() => site.some((r) => r.method === 'POST' && r.path === '/mic-guest/whep')).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __localTracks: MediaStreamTrack[] }).__localTracks[0]!.readyState)).toBe('ended');
  await page.waitForTimeout(500);

  await talk(page, 'Local', 0.2);
  await page.waitForTimeout(900);
  await talk(page, 'Local', 0);
  await page.waitForTimeout(1500);
  expect(await voiceUploads(request), 'the old mic is no longer heard').toBe(1);

  await talk(page, 'Site', 0.2);
  await page.waitForTimeout(900);
  await talk(page, 'Site', 0);
  await expect.poll(() => voiceUploads(request), { timeout: 5000 }).toBe(2);

  await setStudio(request, { micSource: 'off' });
  await expect.poll(() => site.some((r) => r.method === 'DELETE' && r.path.startsWith('/mic-guest/whep/'))).toBe(true);
  await talk(page, 'Site', 0.2);
  await page.waitForTimeout(900);
  await talk(page, 'Site', 0);
  await page.waitForTimeout(1500);
  expect(await voiceUploads(request), 'off is off').toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), 'no reload').toBe(true);
});

// The site node takes faces as H.264 only (video-codec=h264/90000), with the
// voice in the same session for lip sync. A site node that is down or says no
// must not end the stream for the night: the page tries again.
test('a face page publishes H.264 video with its voice, and tries again when the site node says no', async ({ page, request }) => {
  let refusals = 0;
  const site = await fakeSiteNode(page, () => (refusals++ === 0 ? { status: 500 } : { status: 201 }));
  await openStudio(page, request, 'small');
  await setStudio(request, { enabled: true });

  await expect.poll(() => site.filter((r) => r.method === 'POST' && r.path === '/tubs-small/whip').length, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  const offer = site.find((r) => r.path === '/tubs-small/whip')!.body;
  const sections = offer.split(/\r?\nm=/).slice(1);
  const video = sections.find((section) => section.startsWith('video'))!;
  const audio = sections.find((section) => section.startsWith('audio'))!;
  const videoCodecs = [...video.matchAll(/a=rtpmap:\d+ ([^/\s]+)\/(\d+)/g)].map((m) => `${m[1]}/${m[2]}`);
  expect(videoCodecs.length).toBeGreaterThan(0);
  expect(videoCodecs.every((codec) => codec === 'H264/90000'), videoCodecs.join(' ')).toBe(true);
  expect(audio).toMatch(/a=rtpmap:\d+ opus\/48000/);
  expect(video).toMatch(/a=sendonly/);
  // One stream id on both, so receivers keep the voice in sync with the face.
  const msid = (section: string) => section.match(/a=msid:(\S+)/)?.[1];
  expect(msid(video)).toBeTruthy();
  expect(msid(video)).toBe(msid(audio));

  const statuses = (await received(request)).ws.filter((m) => m.type === 'studio_status');
  expect(statuses.some((m) => m.publishing === false && typeof m.error === 'string')).toBe(true);
});

// GET /studio/sources lists this Mac's devices from the listener page, by the
// labels local:<label> takes; only the listener has the mic and the camera.
test('the listener page reports this Mac\'s input devices by label', async ({ page, request }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __openCameras: number };
    w.__openCameras = 0;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await real(constraints);
      for (const track of stream.getVideoTracks()) {
        w.__openCameras += 1;
        const stop = track.stop.bind(track);
        track.stop = () => {
          w.__openCameras -= 1;
          stop();
        };
      }
      return stream;
    };
  });
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true });
  const devices = async () => (await received(request)).ws.filter((m) => m.type === 'studio_status' && m.devices).map((m) => m.devices as { audio: string[]; video: string[] });
  await expect.poll(async () => (await devices()).length, { timeout: 8000 }).toBeGreaterThan(0);
  const listed = (await devices()).at(-1)!;
  // Chrome's fake devices; "default" is an alias of one of them, so not listed twice.
  expect(listed.audio.length).toBeGreaterThan(0);
  expect(listed.video.length).toBeGreaterThan(0);
  expect([...listed.audio, ...listed.video].every((label) => label.length > 0 && !/^Default\b|^Fake Default/.test(label))).toBe(true);
  // The short open that unlocked the labels is closed again: no camera left running.
  expect(await page.evaluate(() => (window as unknown as { __openCameras?: number }).__openCameras ?? 0)).toBe(0);
});

// In studio mode the dashboard shows what the listener hears and sees, and
// onboards people with its camera. The listener sends that only while a
// dashboard watches (the server says so with studio_watch): ten reports and a
// few pictures a second for nobody would load the studio Mac for nothing.
test('the listener sends its live state and camera only while watched, and runs onboarding calls', async ({ page, request }) => {
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true, visionSource: 'local' });
  const sentOf = async (type: string) => (await received(request)).ws.filter((m) => m.type === type);
  await page.waitForTimeout(1200);
  expect([...await sentOf('studio_live'), ...await sentOf('studio_frame')]).toEqual([]);

  await send(request, { type: 'studio_watch', live: true, video: true });
  await expect.poll(async () => (await sentOf('studio_live')).at(-1)?.status, { timeout: 8000 }).toMatchObject({ micReady: expect.any(Boolean), faceCameraActive: true });
  await expect.poll(async () => (await sentOf('studio_frame')).length, { timeout: 8000 }).toBeGreaterThan(1);
  const frame = (await sentOf('studio_frame')).at(-1)!;
  expect(String(frame.frame)).toMatch(/^data:image\/jpeg;base64,/);
  expect(Math.max(Number(frame.width), Number(frame.height))).toBeLessThanOrEqual(320);
  // Never the face worker's embeddings.
  expect(JSON.stringify(await sentOf('studio_live'))).not.toContain('embedding');

  await send(request, { type: 'studio_face_call', id: 'c1', method: 'beginEnrollment' }, { type: 'studio_face_call', id: 'c2', method: 'endEnrollment' });
  await expect.poll(async () => (await sentOf('studio_face_result')).map((m) => [m.id, m.ok])).toEqual([['c1', true], ['c2', true]]);

  await send(request, { type: 'studio_watch', live: false, video: false });
  await expect.poll(async () => (await sentOf('studio_live')).at(-1)?.status, { timeout: 4000 }).toBeNull();
  const frames = (await sentOf('studio_frame')).length;
  const reports = (await sentOf('studio_live')).length;
  await page.waitForTimeout(1200);
  expect((await sentOf('studio_frame')).length).toBe(frames);
  expect((await sentOf('studio_live')).length).toBe(reports);
});

// With the face service on (docs/face-service.md), recognition runs on the
// server: the listener page must not load the face models or open the camera
// (two recognisers would greet everyone twice), yet its sleep, proactive lines
// and live relay still follow who is in view, from the server's observations.
test('with the face service the listener starts no face worker, and shows the server\'s faces', async ({ page, request }) => {
  const models: string[] = [];
  await page.context().route('**/*.onnx', async (route) => {
    models.push(route.request().url());
    await route.abort();
  });
  const site = await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await request.post(`${MOCK}/__test/face-service`, { data: { on: true } });
  await setStudio(request, { enabled: true, visionSource: 'site:cam-facetest' });
  const sentOf = async (type: string) => (await received(request)).ws.filter((m) => m.type === type);
  await send(request, { type: 'studio_watch', live: true, video: false });
  await send(request, {
    type: 'face_observation',
    observation: {
      t: Date.now(),
      source: 'site:cam-facetest',
      frame: { w: 960, h: 540 },
      faces: [{ track: 1, box: [0.1, 0.2, 0.2, 0.5], score: 0.9, candidates: [{ name: 'Flo', sim: 0.82 }], decision: 'match', name: 'Flo' }],
      worker: { kind: 'service', state: 'ready', backend: 'CoreML', inferMs: 40, fps: 5, where: 'studio-mac:3004' },
    },
  });
  await expect.poll(async () => (await sentOf('studio_live')).at(-1)?.status, { timeout: 8000 })
    .toMatchObject({ faceCameraActive: true, faceWorkerReady: true, faceLastDetectedCount: 1, faceFrameWidth: 960, faceLastFaces: [{ name: 'Flo', match: { name: 'Flo', score: 0.82 } }] });
  await page.waitForTimeout(1500);
  expect(models, 'no face model is fetched').toEqual([]);
  expect(site.filter((r) => r.path.startsWith('/cam-facetest')), 'the page does not open the camera').toEqual([]);

  // FACE_SERVICE off again: the same page takes the camera back and loads its worker.
  await request.post(`${MOCK}/__test/face-service`, { data: { on: false } });
  await expect.poll(() => models.length, { timeout: 15_000 }).toBeGreaterThan(0);
});

// Face detection runs while recognition (names) or vision descriptions (a
// detected face triggers them) is on. With both off the face worker never
// loads: no model is fetched, nothing is checked. Descriptions back on, it
// loads again to find the faces they need.
test('face recognition and descriptions both off: no face model is loaded; descriptions on loads it', async ({ page, request }) => {
  await fakeSiteNode(page);
  const models: string[] = [];
  await page.context().route('**/*.onnx', async (route) => {
    models.push(route.request().url());
    await route.abort();
  });
  await openStudio(page, request, 'main');
  await request.post(`${MOCK}/config`, { data: { visionDescriptions: false } });
  await setStudio(request, { enabled: true, visionSource: 'snapshot:http://127.0.0.1:7000/api/snapshot/color.jpg', switches: { faceRecognition: false } });
  const workerState = async () => (await received(request)).ws.filter((m) => m.type === 'studio_status')
    .map((m) => m.faceWorker as { state: string; detail?: string } | undefined).filter(Boolean).at(-1);
  await expect.poll(workerState, { timeout: 8000 }).toMatchObject({ state: 'off', detail: 'face recognition and vision descriptions both switched off' });
  await page.waitForTimeout(1500);
  expect(models).toEqual([]);

  // Descriptions on: faces are needed again, so the worker loads (recognition stays off: no names).
  await request.post(`${MOCK}/config`, { data: { visionDescriptions: true } });
  await setStudio(request, { switches: { faceRecognition: false, camera: true } });
  await setStudio(request, { visionSource: 'snapshot:http://127.0.0.1:7001/api/snapshot/color.jpg' });
  await expect.poll(() => models.length, { timeout: 10_000 }).toBeGreaterThan(0);
});

// A studio camera without a video (snapshot URL, site stream): each onboarding
// pose is a fresh picture, not the last one the detector happened to take.
test('onboarding through a snapshot camera takes a fresh picture per pose', async ({ page, request }) => {
  // The face model loads before the first pose can be taken.
  test.setTimeout(90_000);
  await fakeSiteNode(page);
  let snapshots = 0;
  await page.route('**/studio/snapshot', async (route) => {
    snapshots += 1;
    const body = Buffer.from(await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(320, 240);
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#556677';
      g.fillRect(0, 0, 320, 240);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    }), 'base64');
    await route.fulfill({ status: 200, contentType: 'image/jpeg', body });
  });
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true, visionSource: 'snapshot:http://127.0.0.1:7000/api/snapshot/color.jpg' });
  let calls = 0;
  const faceCall = async (method: string, args?: Record<string, unknown>) => {
    calls += 1;
    const id = `call${calls}`;
    await send(request, { type: 'studio_face_call', id, method, ...(args ? { args } : {}) });
    let answer: Record<string, unknown> | undefined;
    await expect.poll(async () => {
      answer = (await received(request)).ws.find((m) => m.type === 'studio_face_result' && m.id === id);
      return Boolean(answer);
    }, { timeout: 15_000 }).toBe(true);
    return answer!;
  };
  // Onboarding holds the detector's own pictures: what is fetched from here on is the poses'.
  expect((await faceCall('beginEnrollment')).ok).toBe(true);
  // The face model loads first; until then the call says so.
  let capture = await faceCall('captureEnrollmentSample', { previous: [] });
  const loadedBy = Date.now() + 45_000;
  while (!capture.ok && Date.now() < loadedBy) {
    await page.waitForTimeout(1000);
    capture = await faceCall('captureEnrollmentSample', { previous: [] });
  }
  const before = snapshots;
  capture = await faceCall('captureEnrollmentSample', { previous: [] });
  // Nobody in an empty picture: no pose, after a fresh picture per attempt.
  expect(capture).toMatchObject({ ok: true, value: null });
  expect(snapshots - before).toBeGreaterThanOrEqual(2);
  await send(request, { type: 'studio_face_call', id: 'end', method: 'endEnrollment' });
});

// Captions (contract section 8): each head's line under its face in the
// windows, the heard part lit, so it reads with the sound turned down. The
// face page that plays the voice sends them, on its playback clock.

async function captions(request: APIRequestContext): Promise<Array<Record<string, unknown>>> {
  return (await received(request)).ws.filter((message) => message.type === 'studio_caption');
}

test('captions follow a head\'s voice line by line, a filler included, each finished once', async ({ page, request }) => {
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true });
  await page.waitForTimeout(300);
  await request.post(`${MOCK}/__test/reset-received`);

  const reply = 'Did it come with instructions?';
  await send(
    request,
    { type: 'turn_start', turnId: 't-cap' },
    { ...chunk('t-cap', 0, 'Um, okay.', 600), filler: true },
    chunk('t-cap', 1, reply, 1500),
    { type: 'speak_end', turnId: 't-cap', fullText: reply },
  );
  await expect.poll(async () => (await captions(request)).filter((c) => c.done).length, { timeout: 8000 }).toBe(2);
  await page.waitForTimeout(800);

  const all = await captions(request);
  expect(all.every((c) => c.actor === 'main' && c.turnId === 't-cap')).toBe(true);
  expect(all.filter((c) => c.done).map((c) => [c.text, c.spoken])).toEqual([['Um, okay.', 9], [reply, reply.length]]);
  // The reply was reported as it was heard, not all at once.
  const replySpoken = all.filter((c) => c.text === reply).map((c) => c.spoken as number);
  expect(replySpoken.length).toBeGreaterThan(3);
  expect(replySpoken).toEqual([...replySpoken].sort((a, b) => a - b));
  // At most ten a second, not every animation frame: a line's captions come ~100 ms apart.
  const times = all.filter((c) => c.text === reply).map((c) => c.receivedAt as number);
  const gaps = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b);
  expect(gaps[Math.floor(gaps.length / 2)]!).toBeGreaterThanOrEqual(90);
});

// A streamed reply whose next piece is late must not light words nobody has
// heard yet: the caption waits with the voice. And it stays one line: under
// load Ming sent a piece every ~0.8 s with ~0.3 s of audio in it, the line
// ended after each piece, the next restarted it from the beginning, and the
// windows showed the start and the end of one reply in turn (22 backward
// jumps in 135 captions).
test('a stalled Ming reply stays one line: spoken only grows, done once at the true end, never ahead of the voice', async ({ page, request }) => {
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true });
  await page.waitForTimeout(300);
  await request.post(`${MOCK}/__test/reset-received`);

  // Twenty words, streamed like Ming under load: four short pieces, each late.
  const text = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.';
  await send(request, { type: 'turn_start', turnId: 't-stall' });
  let lastPieceAt = 0;
  for (let piece = 0; piece < 4; piece += 1) {
    if (piece === 3) lastPieceAt = Date.now();
    await send(request, { ...chunk('t-stall', piece, text, 300), ...(piece < 3 ? { more: true } : {}) });
    await page.waitForTimeout(800);
  }
  await send(request, { type: 'speak_end', turnId: 't-stall', fullText: text });
  await expect.poll(async () => (await captions(request)).some((c) => c.done), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(500);

  const all = await captions(request);
  expect(all.every((c) => c.text === text && c.turnId === 't-stall')).toBe(true);
  const spoken = all.map((c) => c.spoken as number);
  expect(spoken, 'never backwards').toEqual([...spoken].sort((a, b) => a - b));
  expect(all.filter((c) => c.done), 'done once, at the end, with all of it heard').toEqual([expect.objectContaining({ spoken: text.length })]);
  expect(all.at(-1)!.done).toBe(true);
  // Pieces this slow are held until the reply can play through (streaming-session.ts), so
  // nothing is lit before then; whatever was, was never far ahead of the voice.
  const stalled = all.filter((c) => (c.receivedAt as number) < lastPieceAt);
  expect(Math.max(0, ...stalled.map((c) => c.spoken as number))).toBeLessThanOrEqual(Math.ceil(text.length * 0.25));
});

// Paused playback (a suspended audio context) holds the caption exactly where
// the voice is, however long; it goes on with the voice.
test('a caption holds while playback is paused and goes on with it', async ({ page, request }) => {
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    (window as unknown as { __contexts: AudioContext[] }).__contexts = contexts;
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args);
        contexts.push(this);
      }
    };
  });
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true });
  await page.waitForTimeout(300);
  await request.post(`${MOCK}/__test/reset-received`);

  const text = 'I am going to take my time with this sentence.';
  await send(request, { type: 'turn_start', turnId: 't-pause' }, chunk('t-pause', 0, text, 2500));
  await page.waitForTimeout(900);
  // The speech plays in the page's 24 kHz context.
  await page.evaluate(() => Promise.all((window as unknown as { __contexts: AudioContext[] }).__contexts.filter((c) => c.sampleRate === 24000).map((c) => c.suspend())));
  await page.waitForTimeout(300);
  const pausedAt = Date.now();
  await page.waitForTimeout(2000);
  const resumedAt = Date.now();
  await page.evaluate(() => Promise.all((window as unknown as { __contexts: AudioContext[] }).__contexts.filter((c) => c.sampleRate === 24000).map((c) => c.resume())));
  await expect.poll(async () => (await captions(request)).some((c) => c.done), { timeout: 8000 }).toBe(true);

  const all = await captions(request);
  const before = all.filter((c) => (c.receivedAt as number) <= pausedAt);
  const during = all.filter((c) => (c.receivedAt as number) > pausedAt && (c.receivedAt as number) < resumedAt);
  expect(during, 'nothing new while paused').toEqual([]);
  expect(before.at(-1)!.spoken as number).toBeLessThan(text.length / 2);
  expect(all.filter((c) => c.done)).toEqual([expect.objectContaining({ text, spoken: text.length })]);
});

test('no captions while studio mode is off', async ({ page, request }) => {
  await openStudio(page, request, 'main');
  await send(request, { type: 'turn_start', turnId: 't-off' }, chunk('t-off', 0, 'Nobody is filming.', 800));
  await page.waitForTimeout(2000);
  expect(await captions(request)).toEqual([]);
});

// Asleep, the face window floats "z z z" over the face as page text, which a
// stream never carries. The studio frame has to show it itself, or a sleeping
// Tubs just looks switched off; awake, nothing may be drawn there.
test('the published frame shows the sleeping Zs while Tubs sleeps, and none while awake', async ({ page, request }) => {
  await page.addInitScript(() => {
    const sent: MediaStreamTrack[] = [];
    (window as unknown as { __sentVideo: MediaStreamTrack[] }).__sentVideo = sent;
    const original = RTCPeerConnection.prototype.addTransceiver;
    RTCPeerConnection.prototype.addTransceiver = function addTransceiver(this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
      if (typeof trackOrKind !== 'string' && trackOrKind.kind === 'video') sent.push(trackOrKind);
      return original.call(this, trackOrKind, init);
    };
  });
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  // A red face: its brightest pixels (purple ones get close to white) can't be mistaken for a Z.
  await request.post(`${MOCK}/config`, { data: { glitchFxBaseColor: '#ff0000', glitchScanBeamColor: '#ff0000' } });
  await setStudio(request, { enabled: true });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sentVideo: MediaStreamTrack[] }).__sentVideo.length)).toBeGreaterThan(0);

  // Up and to the right of the face, where the Zs float.
  const face = faceBox(DEFAULT_CONFIG, 1024, 1024, STUDIO_LAYOUT);
  const region = { x0: Math.round(face.x + face.w * 0.85), x1: 1024, y0: 0, y1: Math.round(face.y + face.h * 0.45) };
  /** Z-coloured pixels in that region of the published video (the most in a few frames), and lit face pixels. */
  const zPixels = () => published().then((counts) => counts.z);
  const published = () => page.evaluate(async ({ box, faceArea }) => {
    const track = (window as unknown as { __sentVideo: MediaStreamTrack[] }).__sentVideo[0]!;
    const Processor = (window as unknown as { MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
    const reader = new Processor({ track: track.clone() }).readable.getReader();
    const canvas = new OffscreenCanvas(1024, 1024);
    const ctx = canvas.getContext('2d')!;
    let most = 0;
    let faceLit = 0;
    for (let i = 0; i < 6; i += 1) {
      const { value: frame } = await reader.read();
      if (!frame) break;
      ctx.drawImage(frame, 0, 0, 1024, 1024);
      frame.close();
      const face = ctx.getImageData(faceArea.x, faceArea.y, faceArea.w, faceArea.h).data;
      let lit = 0;
      for (let p = 0; p < face.length; p += 4) {
        if (Math.max(face[p]!, face[p + 1]!, face[p + 2]!) > 60) lit += 1;
      }
      faceLit = Math.max(faceLit, lit);
      const { data } = ctx.getImageData(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      let white = 0;
      for (let p = 0; p < data.length; p += 4) {
        const low = Math.min(data[p]!, data[p + 1]!, data[p + 2]!);
        const high = Math.max(data[p]!, data[p + 1]!, data[p + 2]!);
        // The Zs' near-white (#f1eefc). The face is drawn pure red below, so
        // none of its pixels, however bright, has green and blue up as well.
        if (low >= 200 && high - low <= 40) white += 1;
      }
      most = Math.max(most, white);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    void reader.cancel();
    return { z: most, faceLit };
  }, { box: region, faceArea: { x: Math.round(face.x), y: Math.round(face.y), w: Math.round(face.w), h: Math.round(face.h) } });

  await send(request, { type: 'wake' });
  await page.waitForTimeout(600);
  const awake = await published();
  expect(awake.z, 'awake: no Zs').toBe(0);
  // The Zs are drawn over the face, never instead of it.
  expect(awake.faceLit, 'the face is in the published frame').toBeGreaterThan(500);

  await send(request, { type: 'sleep' });
  await page.waitForTimeout(1200);
  expect(await zPixels(), 'asleep: Zs in the frame').toBeGreaterThan(200);

  await send(request, { type: 'wake' });
  await page.waitForTimeout(600);
  expect(await zPixels(), 'awake again: gone').toBe(0);
});

// GET /studio once said "publishing" while both streams were black. Whatever
// the cause, a face page whose published frame stays black must say so.
test('a face page whose published frame is black stops claiming to publish', async ({ page, request }) => {
  // No WebGPU: the face cannot render, so the published frame is black.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  });
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true });
  await expect.poll(async () => (await received(request)).ws.some((m) => m.type === 'studio_status' && String(m.error ?? '').includes('published frame is black')), { timeout: 12_000 }).toBe(true);
  const last = (await received(request)).ws.filter((m) => m.type === 'studio_status').at(-1)!;
  expect(last.publishing).toBe(false);
});

test('a face page with its face rendering never reports a black frame', async ({ page, request }) => {
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true });
  await page.waitForTimeout(8000);
  expect((await received(request)).ws.some((m) => m.type === 'studio_status' && String(m.error ?? '').includes('black'))).toBe(false);
});

// Asleep the eyes are closed: they stay near centre whatever the director
// says, but they must not look frozen either.
test('a sleeping face keeps its gaze near centre, not following looks', async ({ page, request }) => {
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await send(request, { type: 'sleep' });
  await page.waitForTimeout(500);
  for (let i = 0; i < 30; i += 1) {
    await send(request, { type: 'studio_look', actor: 'main', gaze: [0.9, 0.9] });
    await page.waitForTimeout(200);
    const { x, y } = await gaze(page);
    expect(Math.abs(x), 'at most a sleeping glance').toBeLessThanOrEqual(SLEEP_GAZE_MAX + 1e-4);
    expect(Math.abs(y)).toBeLessThanOrEqual(SLEEP_GAZE_MAX + 1e-4);
  }

  // Awake, the director's looks count again.
  await send(request, { type: 'wake' });
  await page.waitForTimeout(300);
  for (let i = 0; i < 8; i += 1) {
    await send(request, { type: 'studio_look', actor: 'main', gaze: [0.9, 0.9] });
    await page.waitForTimeout(150);
  }
  expect((await gaze(page)).x).toBeGreaterThan(0.5);
});

// docs/vision.md: a studio camera that does not stream. A snapshot URL costs
// one request per picture; a site node stream is opened for one picture and
// closed again, so the site node's on-demand mirror costs nothing in between.
interface ShapeStats { x: number; y: number; light: number; minX: number; maxX: number; minY: number; maxY: number; quads: number }
type Region = { x: number; y: number; w: number; h: number };

/** Keeps the video tracks a face page publishes (window.__sentVideo), to read its frames. */
async function keepPublishedVideo(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sent: MediaStreamTrack[] = [];
    (window as unknown as { __sentVideo: MediaStreamTrack[] }).__sentVideo = sent;
    const original = RTCPeerConnection.prototype.addTransceiver;
    RTCPeerConnection.prototype.addTransceiver = function addTransceiver(this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
      if (typeof trackOrKind !== 'string' && trackOrKind.kind === 'video') sent.push(trackOrKind);
      return original.call(this, trackOrKind, init);
    };
  });
}

/**
 * The published frames for `ms`, per region: where the shape is (brightness
 * weighted, so a brighter breath does not move it), how bright, its lit
 * bounding box and how many pixel quads a row of it has.
 */
async function publishedShapes(page: Page, ms: number, regions: Record<string, Region>): Promise<Array<Record<string, ShapeStats>>> {
  return page.evaluate(async ({ duration, boxes }) => {
    const track = (window as unknown as { __sentVideo: MediaStreamTrack[] }).__sentVideo[0]!;
    const Processor = (window as unknown as { MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
    const reader = new Processor({ track: track.clone() }).readable.getReader();
    const canvas = new OffscreenCanvas(1024, 1024);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const out: Array<Record<string, ShapeStats>> = [];
    const started = performance.now();
    while (performance.now() - started < duration) {
      const { value: frame } = await reader.read();
      if (!frame) break;
      ctx.drawImage(frame, 0, 0, 1024, 1024);
      frame.close();
      const row: Record<string, ShapeStats> = {};
      for (const [name, box] of Object.entries(boxes)) {
        const x0 = Math.round(box.x);
        const y0 = Math.round(box.y);
        const w = Math.round(box.w);
        const { data } = ctx.getImageData(x0, y0, w, Math.round(box.h));
        let sx = 0;
        let sy = 0;
        let sum = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        const litColumns = new Set<number>();
        for (let p = 0; p < data.length; p += 4) {
          const v = Math.max(data[p]!, data[p + 1]!, data[p + 2]!);
          const x = (p / 4) % w;
          const y = Math.floor(p / 4 / w);
          sx += x * v;
          sy += y * v;
          sum += v;
          if (v > 60) {
            litColumns.add(x);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
        let quads = 0;
        for (let x = minX; x <= maxX; x += 1) if (litColumns.has(x) && !litColumns.has(x - 1)) quads += 1;
        row[name] = { x: x0 + sx / sum, y: y0 + sy / sum, light: sum / (data.length / 4), minX: x0 + minX, maxX: x0 + maxX, minY: y0 + minY, maxY: y0 + maxY, quads };
      }
      out.push(row);
    }
    void reader.cancel();
    return out;
  }, { duration: ms, boxes: regions });
}

/** The left eye and the mouth of a studio frame (the Zs float on the right). */
function sleepingShapes(): Record<string, Region> {
  const face = faceBox(DEFAULT_CONFIG, 1024, 1024, STUDIO_LAYOUT);
  return {
    leftEye: { x: face.x - 0.05 * face.w, y: face.y + 0.3 * face.h, w: 0.38 * face.w, h: 0.55 * face.h },
    mouth: { x: face.x + 0.36 * face.w, y: face.y + 0.86 * face.h, w: 0.33 * face.w, h: 0.26 * face.h },
  };
}

/** A studio head in a window this size, publishing, asleep for a moment (its sleep morph is over in under a second). */
async function sleepingHead(page: Page, request: APIRequestContext, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await keepPublishedVideo(page);
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sentVideo: MediaStreamTrack[] }).__sentVideo.length)).toBeGreaterThan(0);
  await send(request, { type: 'sleep' });
  await page.waitForTimeout(1500);
}

const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

// Live, 2026-11-10: both sleeping heads looked like they shuffled by a
// pixel all the time. A slow drift and a breathing swell moved the face by
// fractions of a screen pixel each frame, and the pixel grid drew that as
// quad edges stepping a pixel, different ones each frame; the scanlines'
// scroll stepped over it too. Asleep the face holds still between twitches
// (the first comes 6 s after falling asleep at the soonest) and breathes in
// brightness.
test('a sleeping face holds still in the published stream between twitches, and still breathes', async ({ page, request }) => {
  // The face windows' size in the studio (server/studio/chrome-window.ts), where it was seen.
  await sleepingHead(page, request, { width: 560, height: 600 });
  const frames = await publishedShapes(page, 3000, sleepingShapes());
  expect(frames.length).toBeGreaterThan(30);
  for (const name of ['leftEye', 'mouth']) {
    // Before, the eyes moved by 5 to 15 px over a few seconds, a pixel at a time.
    expect(spread(frames.map((frame) => frame[name]!.x)), `${name} holds still sideways`).toBeLessThan(0.5);
    expect(spread(frames.map((frame) => frame[name]!.y)), `${name} holds still up and down`).toBeLessThan(0.5);
  }
  const light = frames.map((frame) => frame.leftEye!.light);
  expect(spread(light) / Math.max(...light), 'still breathes, in brightness').toBeGreaterThan(0.02);
});

// The face is laid out in its stream's square, not its window: sized from
// the window, the small off-screen windows drew four-pixel eyes into the 1024
// stream (live, 2026-11-09). Any window size gives the same face.
test('a studio head draws the same face whatever the size of its window', async ({ browser, request }) => {
  const looks: ShapeStats[][] = [];
  for (const size of [{ width: 240, height: 180 }, { width: 560, height: 600 }, { width: 1100, height: 900 }]) {
    const page = await browser.newPage();
    await sleepingHead(page, request, size);
    const [frame] = await publishedShapes(page, 1, sleepingShapes());
    looks.push(['leftEye', 'mouth'].map((name) => frame![name]!));
    await page.close();
  }
  const [small, studio, large] = looks;
  for (const other of [small!, large!]) {
    for (let i = 0; i < 2; i += 1) {
      expect(other[i]!.quads, 'as many pixels across').toBe(studio![i]!.quads);
      for (const edge of ['minX', 'maxX', 'minY', 'maxY'] as const) expect(Math.abs(other[i]![edge] - studio![i]![edge]), edge).toBeLessThanOrEqual(1);
    }
  }
});

test('a snapshot picture is one request, and a site stream picture opens and closes its session', async ({ page, request }) => {
  await fakeMediaAndWebRtc(page);
  const site = await fakeSiteNode(page);
  await openStudio(page, request, 'small');
  // A JPEG made in the page, served as the camera's snapshot.
  const jpeg = Buffer.from(await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(320, 240);
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#336699';
    g.fillRect(0, 0, 320, 240);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  }), 'base64');
  let snapshots = 0;
  await page.route('**/studio/snapshot', async (route) => {
    snapshots += 1;
    await route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg });
  });

  const sizes = await page.evaluate(async () => {
    const { snapshotPicture } = await import('/src/client/face/pictures.ts');
    const out: number[][] = [];
    for (let i = 0; i < 3; i += 1) {
      const picture = await snapshotPicture('/studio/snapshot');
      out.push([picture.width, picture.height]);
      picture.close();
    }
    return out;
  });
  expect(sizes).toEqual([[320, 240], [320, 240], [320, 240]]);
  expect(snapshots, 'one request per picture').toBe(3);

  const frame = await page.evaluate(async (url) => {
    const { whepPicture } = await import('/src/client/transport/whip.ts');
    const picture = await whepPicture(url);
    const canvas = new OffscreenCanvas(picture.width, picture.height);
    canvas.getContext('2d')!.drawImage(picture, 0, 0);
    const [r, g, b] = canvas.getContext('2d')!.getImageData(10, 10, 1, 1).data;
    return { width: picture.width, rgb: [r, g, b], closed: (window as unknown as { __closedPeers?: number }).__closedPeers ?? 0 };
  }, 'http://127.0.0.1:39011/cam-c920/whep');
  expect(frame.width).toBe(64);
  expect(frame.rgb[1]).toBeGreaterThan(200);
  expect(frame.closed, 'the WHEP session is closed after the picture').toBe(1);
  expect(site.filter((r) => r.path.startsWith('/cam-c920/whep')).map((r) => r.method)).toEqual(['POST', 'DELETE']);
});

// Hold until in place: the director may move a head to another window before
// it speaks; its voice should come from where its face is. A filler or a
// call-out covers the journey; the line itself waits for studio_stage ready,
// never longer than 2.5 s.
async function stagedPage(page: Page, request: APIRequestContext): Promise<void> {
  await instrumentAudio(page);
  await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  await setStudio(request, { enabled: true });
  await page.waitForTimeout(300);
  await send(request, { type: 'studio_stage', actor: 'main', ready: false });
  await page.waitForTimeout(100);
}

test('a line waits for its face to be in place, while the filler covers the wait', async ({ page, request }) => {
  await stagedPage(page, request);
  const sentAt = await now(page);
  await send(request, { type: 'turn_start', turnId: 't-stage' }, { ...chunk('t-stage', 0, 'Hmm.', 500), filler: true }, chunk('t-stage', 1, 'Nice hat.', 1200));
  await page.waitForTimeout(1200);
  const before = await speechAudio(page);
  expect(before.map((a) => Math.round(a.duration * 10) / 10), 'only the filler so far').toEqual([0.5]);
  expect(before[0]!.calledAt - sentAt).toBeLessThan(500);
  const readyAt = await now(page);
  await send(request, { type: 'studio_stage', actor: 'main', ready: true });
  await expect.poll(async () => (await speechAudio(page)).length).toBe(2);
  const line = (await speechAudio(page))[1]!;
  expect(line.calledAt).toBeGreaterThanOrEqual(readyAt);
  expect(line.calledAt - readyAt).toBeLessThan(600);
});

test('a line starts anyway at the cap when the face never says it is in place', async ({ page, request }) => {
  await stagedPage(page, request);
  const sentAt = await now(page);
  await send(request, { type: 'turn_start', turnId: 't-cap' }, chunk('t-cap', 0, 'Still here?', 1000));
  await expect.poll(async () => (await speechAudio(page)).length, { timeout: 5000 }).toBe(1);
  const waited = (await speechAudio(page))[0]!.calledAt - sentAt;
  expect(waited).toBeGreaterThan(2300);
  expect(waited).toBeLessThan(3300);
});

test('a call-out plays at once, and the line after it waits for the face', async ({ page, request }) => {
  await stagedPage(page, request);
  const sentAt = await now(page);
  await send(
    request,
    { type: 'turn_start', turnId: 't-call' },
    { ...chunk('t-call', 0, 'Hey, you over by the cinema!', 800), callout: true },
    chunk('t-call', 1, 'Come here, I have opinions.', 1200),
  );
  await page.waitForTimeout(1000);
  const early = await speechAudio(page);
  expect(early).toHaveLength(1);
  expect(early[0]!.calledAt - sentAt, 'the call-out did not wait').toBeLessThan(500);
  await send(request, { type: 'studio_stage', actor: 'main', ready: true });
  await expect.poll(async () => (await speechAudio(page)).length).toBe(2);
});

// Studio heads looked flat next to the face window: Small had no mood at all,
// and every line after a head's first spoke with a plain face. Each head shows
// its own line's feeling while it speaks, and its own mood takes the impulse.
test('a line\'s emotion shows on that head\'s face, and moves that head\'s mood only', async ({ context, request }) => {
  const small = await context.newPage();
  const main = await context.newPage();
  await fakeSiteNode(small);
  await fakeSiteNode(main);
  await openStudio(small, request, 'small');
  await main.goto('/studio-face.html?actor=main');
  await main.locator('#visual-face').waitFor();
  await setStudio(request, { enabled: true });
  await request.post(`${MOCK}/config`, { data: { dualHeadEnabled: true, dualHeadMode: 'llm_directed' } });
  await small.waitForTimeout(500);

  const happy = { emoji: '😄', expression: 'happy', impulse: { pos: 0.6, neg: 0, arousal: 0.7 } };
  const angry = { emoji: '😤', expression: 'angry', impulse: { pos: 0.24, neg: 0.56, arousal: 0.82 } };
  const smug = { emoji: '😏', expression: 'smug', impulse: { pos: 0.5, neg: 0.16, arousal: 0.48 } };
  const turnId = 't-feel';
  const line = (actor: string, beatIndex: number, text: string, emotion: object, index: number) =>
    ({ type: 'audio_chunk', audio: tone(900), text, turnId, chunkIndex: index, actor, beatIndex, emotion });
  await send(request,
    { type: 'turn_start', turnId },
    { type: 'turn_script', turnId, ts: Date.now(), beats: [
      { actor: 'main', action: 'speak', text: 'Lovely night.', emotion: happy },
      { actor: 'small', action: 'speak', text: 'Says you.', emotion: angry },
      { actor: 'small', action: 'speak', text: 'Fine, it is.', emotion: smug },
    ] },
    line('main', 0, 'Lovely night.', happy, 0),
    { type: 'speak_end', turnId, actor: 'main', text: 'Lovely night.', fullText: 'Lovely night.' },
    line('small', 1, 'Says you.', angry, 1),
    { type: 'speak_end', turnId, actor: 'small', text: 'Says you.', fullText: 'Says you.' },
  );
  const smallFace = small.locator('#visual-face');
  await expect(smallFace).toHaveAttribute('data-expression', 'angry', { timeout: 5000 });
  // Small's mood took its own line's anger; Tubs's did not.
  const mood = (page: typeof small) => page.evaluate(() => (window as unknown as { __tubsStore: { getState(): { moodNeg: number } } }).__tubsStore.getState().moodNeg);
  await expect.poll(() => mood(small)).toBeGreaterThan(0.2);
  expect(await mood(main)).toBeLessThan(0.1);
  await expect(main.locator('#visual-face')).not.toHaveAttribute('data-expression', 'angry');

  // Small's second line, later in the same turn, shows its own feeling too.
  await send(request, line('small', 2, 'Fine, it is.', smug, 2), { type: 'speak_end', turnId, actor: 'small', text: 'Fine, it is.', fullText: 'Fine, it is.' });
  await expect(smallFace).toHaveAttribute('data-expression', 'smug', { timeout: 5000 });
});

// Two heads, two face pages. The answer arrives ahead (the server sends it
// early in studio mode) and starts a breath after the other head's line has
// actually played out: not over it, and not 0.9 s later.
test('an answer from the other head starts a breath after the line it answers ends', async ({ context, request }) => {
  const main = await context.newPage();
  const small = await context.newPage();
  for (const page of [main, small]) {
    await instrumentAudio(page);
    await fakeSiteNode(page);
  }
  await openStudio(main, request, 'main');
  await small.goto('/studio-face.html?actor=small');
  await small.locator('#visual-face').waitFor();
  await setStudio(request, { enabled: true });
  await request.post(`${MOCK}/config`, { data: { dualHeadEnabled: true, dualHeadMode: 'llm_directed' } });
  await main.waitForTimeout(500);

  const turnId = 't-handover';
  const first = 'Did you get lost on purpose?';
  await send(request,
    { type: 'turn_start', turnId },
    { type: 'turn_script', turnId, ts: Date.now(), beats: [{ actor: 'main', action: 'speak', text: first }, { actor: 'small', action: 'speak', text: 'He has a map.' }] },
    { type: 'audio_chunk', audio: tone(2000), text: first, turnId, chunkIndex: 0, actor: 'main', beatIndex: 0 },
    { type: 'speak_end', turnId, actor: 'main', text: first, fullText: first },
  );
  await main.waitForTimeout(300);
  // Sent while Tubs still has 1.7 s to go.
  await send(request,
    { type: 'audio_chunk', audio: tone(800), text: 'He has a map.', turnId, chunkIndex: 1, actor: 'small', beatIndex: 1, after: { actor: 'main', text: first } },
    { type: 'speak_end', turnId, actor: 'small', text: 'He has a map.', fullText: 'He has a map.' },
  );
  const epoch = async (page: typeof main) => {
    const origin = await page.evaluate(() => performance.timeOrigin);
    return (await speechAudio(page)).map((rec) => ({ start: origin + rec.calledAt, end: rec.endedAt === null ? null : origin + rec.endedAt }));
  };
  await expect.poll(async () => (await speechAudio(small)).length, { timeout: 8000 }).toBe(1);
  await expect.poll(async () => (await epoch(main))[0]?.end ?? null, { timeout: 8000 }).not.toBeNull();
  const mainEnd = (await epoch(main))[0]!.end!;
  const smallStart = (await epoch(small))[0]!.start;
  // Not over Tubs, and right after him: a short breath plus the caption tick (100 ms). With
  // Ming's own silence at the ends of lines that is the 250-450 ms pause heard live.
  expect(smallStart - mainEnd).toBeGreaterThanOrEqual(40);
  expect(smallStart - mainEnd).toBeLessThanOrEqual(300);
});

// The studio's mediamtx lets the face pages publish only with a login
// (TUBS_STUDIO_SITE_AUTH). The page sends it on every WHIP request, the
// session's DELETE included; and a refused login is reported, not retried in
// a tight loop.
test('publishes with the site login it was given, never in the page address', async ({ page, request }) => {
  const requests = await fakeSiteNode(page);
  await openStudio(page, request, 'main');
  const header = `Basic ${Buffer.from('tubs:not-a-real-pass').toString('base64')}`;
  await request.post(`${MOCK}/__test/site-auth`, { data: { publish: header } });
  await setStudio(request, { enabled: true });
  await expect.poll(() => requests.filter((r) => r.method === 'POST').length, { timeout: 8000 }).toBeGreaterThan(0);
  expect(requests.find((r) => r.method === 'POST')!.authorization).toBe(header);
  // Never in the page's address. (The session's DELETE: transport/whip.test.ts.)
  expect(page.url()).not.toContain('not-a-real-pass');
});

test('a refused site login is reported and not retried in a tight loop', async ({ page, request }) => {
  const requests = await fakeSiteNode(page, () => ({ status: 401 }));
  await openStudio(page, request, 'main');
  await request.post(`${MOCK}/__test/reset-received`);
  await setStudio(request, { enabled: true });
  await expect.poll(async () => (await received(request)).ws.some((m) => m.type === 'studio_status' && typeof m.error === 'string' && /login/.test(m.error as string)), { timeout: 8000 }).toBe(true);
  await page.waitForTimeout(3000);
  expect(requests.filter((r) => r.method === 'POST').length).toBeLessThanOrEqual(2);
});
