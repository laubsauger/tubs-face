import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { resetMock } from './helpers.js';

// In studio mode the dashboard has no camera: the studio listener page has it,
// maybe on another machine. To check that recognition works, the operator
// needs what normal mode shows (the camera with the face boxes, names and
// match scores, the mic) and has to be able to onboard someone through the
// listener's camera from here. The dashboard asks for that traffic only while
// it shows it. The server side of the socket is played by the test.

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const STATUS = {
  micReady: true, micDenied: false, micLevel: 0.4, recording: false, listenState: 'Listening', voiceLastTranscript: 'Hello Tubs',
  audioPlaying: false, faceCameraActive: true, faceWorkerReady: true, faceWorkerBusy: false, faceStatus: 'Detected 1 face(s)', faceLastDetectedCount: 1,
  faceLastInferenceMs: 180, faceLastEmbeddingsExtracted: 1, faceLastEmbeddingsReused: 0,
  faceFrameWidth: 960, faceFrameHeight: 540,
  faceLastFaces: [{ box: [480, 135, 672, 405], score: 0.98, name: 'Flo', match: { name: 'Flo', score: 0.87 }, matches: [{ name: 'Flo', score: 0.87 }, { name: 'Dimi', score: 0.41 }] }],
};
const FACE_WORKER = {
  state: 'ready', camera: true, checksPerSecond: 2, lastCheckAt: Date.now(), lastFaceAt: Date.now(), faces: 1, best: { name: 'Flo', prob: 0.87 },
  backend: 'wasm', threads: 8, isolated: true, source: 'site:cam-flo-mac', frameWidth: 960, frameHeight: 540, lastFrameAt: Date.now(),
  inferenceMs: 180, threshold: 0.65, margin: 0.01, lastVisionFrameAt: null, visionSkip: 'not due', checkSkip: null,
};
const PULSE = {
  t: 1, mic: { source: 'site:cam-flo-mac', level: 0.4, state: 'listening' }, speaking: null, heard: { text: 'Hello Tubs', t: 1 },
  seen: [{ name: 'Flo', prob: 0.87, box: [0.5, 0.25, 0.2, 0.5] }], vision: { provider: 'openai', lastMs: 900, at: 1 },
};
const STUDIO = {
  enabled: true, site: 'http://127.0.0.1:8889', micSource: 'site:cam-flo-mac', visionSource: 'site:cam-flo-mac',
  actors: [{ id: 'main', stream: 'tubs-main', publishing: true }, { id: 'small', stream: 'tubs-small', publishing: true }], launch: 'chrome',
};
const VISION = {
  camera: { on: true, source: 'site:cam-flo-mac' }, vision: { provider: 'openai', model: 'qwen3-vl:4b-instruct', on: true },
  last: { at: Date.now(), kind: 'refresh', ok: true, ms: 900, provider: 'openai', model: 'qwen3-vl:4b-instruct', where: 'studio-box:11434', text: 'A person in a grey hoodie.' },
  relationships: [{ name: 'Flo', attitude: 'He is the boss.' }],
};

interface Socket {
  sent: Array<Record<string, unknown>>;
  push(message: unknown): void;
}

async function dashboardWithStudio(page: Page): Promise<Socket> {
  const socket: Socket = { sent: [], push: () => {} };
  await page.routeWebSocket(/\/ws(\?.*)?$/, (ws: WebSocketRoute) => {
    socket.push = (message) => ws.send(JSON.stringify(message));
    ws.onMessage((raw) => socket.sent.push(JSON.parse(String(raw)) as Record<string, unknown>));
  });
  await page.route(/\/(presets|relationships)(\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: path === '/presets' ? { presets: [], active: null } : { relationships: [] } });
  });
  await page.route(/\/studio(\/sources|\/vision)?(\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: path === '/studio/vision' ? VISION : path === '/studio/sources' ? { micSource: 'off', visionSource: 'off', mic: [], vision: [], suggested: {}, problems: [] } : STUDIO });
  });
  await page.goto('/?view=dashboard');
  const tab = page.getByRole('tab', { name: /^Studio/ });
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  return socket;
}

const watches = (socket: Socket) => socket.sent.filter((message) => message.type === 'studio_watch');

test.afterEach(async ({ request }) => {
  await resetMock(request);
});

test('the dashboard shows the studio camera with face boxes, names and scores, and the mic, asking only while it shows them', async ({ page }) => {
  const socket = await dashboardWithStudio(page);
  await expect.poll(() => watches(socket).at(-1)).toEqual({ type: 'studio_watch', live: true, video: true });

  // A worker that has not loaded: the debug view opens by itself and says so.
  socket.push({ type: 'studio_live', actor: 'main', status: { ...STATUS, faceWorkerReady: false, faceLastFaces: [] }, speaking: false, faceWorker: { ...FACE_WORKER, state: 'loading', detail: 'init: Loading recognition model...', lastCheckAt: null } });
  const studio = page.locator('#dock-panel-studio');
  await expect(studio.locator('#face-debug')).toContainText('loading: init: Loading recognition model...');
  await expect(studio.getByRole('checkbox', { name: 'Face debug' })).toBeChecked();

  socket.push({ type: 'studio_live', actor: 'main', status: STATUS, speaking: false, faceWorker: FACE_WORKER });
  socket.push({ type: 'studio_frame', actor: 'main', frame: JPEG, width: 320, height: 180 });
  socket.push({ type: 'studio_pulse', pulse: PULSE });
  // Healthy: the debug view is the operator's choice; turned on it shows everything the listener knows.
  await expect(studio.getByRole('checkbox', { name: 'Face debug' })).not.toBeChecked();
  await studio.getByRole('checkbox', { name: 'Face debug' }).check();
  await expect(studio.locator('#face-debug')).toContainText('loaded · wasm · 8 threads');
  await expect(studio.locator('#face-debug')).toContainText('A match needs 65%');
  await expect(studio.locator('#face-debug')).toContainText('Flo 87% ≥ 65%');
  await expect(studio.locator('#face-debug')).toContainText('Dimi 41% < 65%');
  await expect(studio.locator('#face-debug')).toContainText('match · det 98%');
  await expect(studio.locator('#studio-live-mic')).toContainText('listening');
  await expect(studio.locator('#studio-live-heard')).toContainText('Hello Tubs');
  await expect(studio.getByRole('list', { name: 'In view' })).toContainText('Flo');
  await expect(studio.getByRole('list', { name: 'In view' })).toContainText('87%');
  await expect(studio.getByRole('list', { name: 'In view' })).toContainText('He is the boss.');
  await expect(studio.getByRole('img', { name: 'What the studio camera sees' })).toHaveAttribute('src', JPEG);
  await expect(studio.locator('canvas.camera-overlay[data-faces="1"]')).toHaveCount(1);
  await expect(studio.locator('#studio-live-vision')).toContainText('900 ms');

  // A site stream camera: the dashboard reads it itself over WHEP; if that fails it keeps the relayed pictures.
  const whep: string[] = [];
  await page.route('http://127.0.0.1:8889/**', async (route) => {
    whep.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({ status: 404, body: 'no such stream here' });
  });
  socket.push({ type: 'studio_config', enabled: true, site: 'http://127.0.0.1:8889', micSource: 'site:cam-flo-mac', visionSource: 'site:cam-flo-mac', streams: { main: 'tubs-main', small: 'tubs-small' } });
  await expect.poll(() => whep).toContain('POST http://127.0.0.1:8889/cam-flo-mac/whep');
  await expect(studio.getByRole('img', { name: 'What the studio camera sees' })).toBeVisible();

  // The People tab: the same detection list as normal mode, top candidates included.
  await page.getByRole('tab', { name: /^People/ }).click();
  const people = page.locator('#dock-panel-people');
  await expect(people.getByRole('img', { name: 'What the studio camera sees' })).toBeVisible();
  await expect(people.locator('#face-results-list')).toContainText('Likely Flo at 87');
  await expect(people.locator('#face-results-list')).toContainText('Dimi');
  // The listener's worker in the header, never this page's own (absent) one.
  await expect(people.locator('#face-debug')).toContainText('2 checks/s · inference 180 ms');
  await expect(people.locator('#face-results-list')).toContainText('a match needs 65%');
  // The status bar's mic chip knows the mic again.
  await expect(page.locator('#status-mic')).not.toContainText('No face window');

  // Another tab: no pictures needed; a hidden dashboard: nothing at all.
  await page.getByRole('tab', { name: /^Mind/ }).click();
  await expect.poll(() => watches(socket).at(-1)).toEqual({ type: 'studio_watch', live: true, video: false });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => watches(socket).at(-1)).toEqual({ type: 'studio_watch', live: false, video: false });

  // The listener stops: nothing stale stays.
  socket.push({ type: 'studio_live', actor: 'main', status: null, speaking: false });
  await page.getByRole('tab', { name: /^People/ }).click();
  await expect(people.getByRole('img', { name: 'What the studio camera sees' })).toHaveCount(0);
});

test('onboarding from the dashboard runs on the studio listener\'s camera, with its preview', async ({ page }) => {
  const socket = await dashboardWithStudio(page);
  await expect.poll(() => watches(socket).length).toBeGreaterThan(0);
  socket.push({ type: 'studio_live', actor: 'main', status: STATUS, speaking: false, faceWorker: FACE_WORKER });
  socket.push({ type: 'studio_frame', actor: 'main', frame: JPEG, width: 320, height: 180 });
  socket.push({ type: 'studio_pulse', pulse: PULSE });

  // The listener page answers each call the way its face runtime would.
  const SAMPLE = { embedding: [0.1, 0.2, 0.3], thumbnail: JPEG, duplicate: false };
  const calls = () => socket.sent.filter((message) => message.type === 'studio_face_call') as Array<{ id: string; method: string; args?: Record<string, unknown> }>;
  const answered = new Set<string>();
  const answer = setInterval(() => {
    for (const call of calls()) {
      if (answered.has(call.id)) continue;
      answered.add(call.id);
      const value = call.method === 'captureEnrollmentSample' ? SAMPLE : call.method === 'saveEnrollment' ? 1 : null;
      socket.push({ type: 'studio_face_result', id: call.id, ok: true, value });
    }
  }, 50);
  try {
    await page.locator('#dock-panel-studio').getByRole('button', { name: 'Onboard someone' }).click();
    const wizard = page.getByRole('dialog', { name: 'Face onboarding' });
    await expect(wizard.getByRole('img', { name: 'What the studio camera sees' })).toBeVisible();
    await wizard.getByPlaceholder('Name').fill('Rosa');
    await wizard.getByRole('radio', { name: /Quick/ }).click();
    await wizard.getByRole('button', { name: 'Start' }).click();
    await expect(wizard.getByRole('button', { name: /Shot 1/ })).toBeVisible({ timeout: 10_000 });
    await wizard.getByRole('button', { name: 'Save face' }).click();
    await expect(wizard).toContainText('Got it, Rosa!');
    expect(calls().map((call) => call.method)).toEqual(['beginEnrollment', 'captureEnrollmentSample', 'endEnrollment', 'saveEnrollment']);
    expect(calls().at(-1)?.args).toEqual({ name: 'Rosa', samples: [{ embedding: SAMPLE.embedding, thumbnail: JPEG }] });
    // The pictures keep coming while the dialog is open.
    expect(watches(socket).at(-1)).toMatchObject({ video: true });
  } finally {
    clearInterval(answer);
  }
});

// The sentient panel's pulse bar opens the dashboard on the People tab.
test('a link with ?tab=people opens the dashboard on the People tab, dock unfolded', async ({ page }) => {
  await page.addInitScript(() => {
    // The operator left the dock folded on Stats.
    localStorage.setItem('tubs.uiPrefs.dashboard', JSON.stringify({ dockTab: 'stats', dockFolded: true }));
  });
  await page.goto('/?view=dashboard&tab=people');
  await expect(page.getByRole('tab', { name: /^People/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#dock-panel-people')).toBeVisible();
});
