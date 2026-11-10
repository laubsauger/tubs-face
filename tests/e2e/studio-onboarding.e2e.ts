import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { resetMock } from './helpers.js';

// Onboarding knows who it is adding to. With Flo recognised in front of the
// studio camera the button says "Add photos to Flo"; with someone unknown the
// name field suggests the people the library knows, and picking one adds to
// them instead of making a second Flo. Shots that look like somebody else are
// not saved into a person without a question, and a photo without exactly one
// face is refused with the reason. The studio listener (its camera, its face
// worker) is played by the test over the dashboard's socket.

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
// A real (blank) picture, so the browser can decode it and the face worker is asked.
const BLANK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const LIBRARY = {
  faces: [
    { id: 'f1', name: 'Flo', embedding: [1, 0, 0], createdAt: 1_000, thumbnail: JPEG },
    { id: 'f2', name: 'Flo', embedding: [0.95, 0.31, 0], createdAt: 2_000, thumbnail: JPEG },
    { id: 'fl1', name: 'Florian', embedding: [0, 0, 1], createdAt: 3_000, thumbnail: JPEG },
  ],
};
const face = (named: boolean) => ({
  box: [480, 135, 672, 405], score: 0.98,
  ...(named ? { name: 'Flo', match: { name: 'Flo', score: 0.87 } } : { match: null }),
  matches: [{ name: 'Flo', score: named ? 0.87 : 0.42 }, { name: 'Florian', score: 0.1 }],
});
const status = (named: boolean) => ({
  micReady: true, micDenied: false, micLevel: 0.1, recording: false, listenState: 'Listening', voiceLastTranscript: '',
  audioPlaying: false, faceCameraActive: true, faceWorkerReady: true, faceWorkerBusy: false, faceStatus: 'Detected 1 face(s)', faceLastDetectedCount: 1,
  faceLastInferenceMs: 120, faceLastEmbeddingsExtracted: 1, faceLastEmbeddingsReused: 0, faceFrameWidth: 960, faceFrameHeight: 540,
  faceLastFaces: [face(named)],
});
const STUDIO = {
  enabled: true, site: 'http://127.0.0.1:8889', micSource: 'off', visionSource: 'site:cam-test',
  actors: [{ id: 'main', stream: 'tubs-main', publishing: true }, { id: 'small', stream: 'tubs-small', publishing: true }], launch: 'chrome',
};

interface Listener {
  calls: Array<{ id: string; method: string; args?: Record<string, unknown> }>;
  push(message: unknown): void;
  /** What the listener's face runtime answers, per method. */
  answers: Record<string, unknown>;
}

async function dashboardOnPeople(page: Page, named: boolean): Promise<Listener> {
  const listener: Listener = { calls: [], push: () => {}, answers: { beginEnrollment: null, endEnrollment: null, saveEnrollment: 1 } };
  await page.routeWebSocket(/\/ws(\?.*)?$/, (ws: WebSocketRoute) => {
    listener.push = (message) => ws.send(JSON.stringify(message));
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; id: string; method: string; args?: Record<string, unknown> };
      if (message.type !== 'studio_face_call') return;
      listener.calls.push({ id: message.id, method: message.method, ...(message.args ? { args: message.args } : {}) });
      ws.send(JSON.stringify({ type: 'studio_face_result', id: message.id, ok: true, value: listener.answers[message.method] ?? null }));
    });
  });
  await page.route(/\/faces(\?.*)?$/, (route) => route.fulfill({ json: LIBRARY }));
  await page.route(/\/(presets|relationships)(\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: path === '/presets' ? { presets: [], active: null } : { relationships: [] } });
  });
  await page.route(/\/studio(\/sources|\/vision)?(\?.*)?$/, (route) => route.fulfill({ json: STUDIO }));
  await page.goto('/?view=dashboard&tab=people');
  await expect(page.getByRole('tab', { name: /^People/ })).toHaveAttribute('aria-selected', 'true');
  // The studio listener reports Flo (or someone unknown) in front of its camera.
  await expect.poll(() => listener.push !== undefined).toBe(true);
  listener.push({ type: 'studio_live', actor: 'main', status: status(named), speaking: false });
  listener.push({ type: 'studio_frame', actor: 'main', frame: JPEG, width: 320, height: 180 });
  return listener;
}

test.afterEach(async ({ request }) => {
  await resetMock(request);
});

test('Flo in view: "Add photos to Flo" captures from the studio camera into Flo', async ({ page }) => {
  const listener = await dashboardOnPeople(page, true);
  const people = page.locator('#dock-panel-people');
  await expect(people.getByRole('button', { name: 'Someone else…' })).toBeVisible();
  // A shot like Flo's samples.
  listener.answers.captureEnrollmentSample = { embedding: [0.98, 0.2, 0], thumbnail: JPEG, duplicate: false };
  await people.getByRole('button', { name: 'Add photos to Flo' }).click();

  const wizard = page.getByRole('dialog', { name: 'Face onboarding' });
  await expect(wizard).toContainText('Adding photos to Flo (2 samples)');
  await wizard.getByRole('radio', { name: /Quick/ }).click();
  await wizard.getByRole('button', { name: 'Add photos to Flo' }).click();
  await expect(wizard.locator('#enroll-similarity')).toContainText('these shots match Flo at 99%', { timeout: 10_000 });
  await wizard.getByRole('button', { name: 'Save face' }).click();
  await expect(wizard).toContainText('Got it, Flo!');
  const save = listener.calls.find((call) => call.method === 'saveEnrollment');
  expect(save?.args).toMatchObject({ name: 'Flo' });
});

test('someone unknown: the picker suggests Flo; shots unlike Flo ask first, then go to Flo', async ({ page }) => {
  const listener = await dashboardOnPeople(page, false);
  const people = page.locator('#dock-panel-people');
  // A shot nothing like Flo's samples (the picker could be wrong).
  listener.answers.captureEnrollmentSample = { embedding: [0, 0.2, 0.98], thumbnail: JPEG, duplicate: false };
  await people.getByRole('button', { name: 'Onboard' }).click();

  const wizard = page.getByRole('dialog', { name: 'Face onboarding' });
  const name = wizard.getByRole('combobox', { name: "Who's this?" });
  await name.fill('fl');
  const suggestions = wizard.getByRole('list', { name: 'People in the library' });
  expect(await suggestions.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))).toEqual(['Flo, 2 samples', 'Florian, 1 sample']);
  await suggestions.getByRole('button', { name: 'Flo, 2 samples' }).click();
  await expect(name).toHaveValue('Flo');
  await expect(wizard).toContainText('Adding photos to Flo (2 samples)');

  await wizard.getByRole('radio', { name: /Quick/ }).click();
  await wizard.getByRole('button', { name: 'Add photos to Flo' }).click();
  await expect(wizard.getByRole('button', { name: 'Save face' })).toBeVisible({ timeout: 10_000 });
  await wizard.getByRole('button', { name: 'Save face' }).click();
  // Far under the threshold: a question, not a save.
  await expect(wizard).toContainText(/These look like a different person: \d+%/);
  expect(listener.calls.some((call) => call.method === 'saveEnrollment')).toBe(false);
  await wizard.getByRole('button', { name: /^Add anyway/ }).click();
  await expect(wizard).toContainText('Got it, Flo!');
  expect(listener.calls.filter((call) => call.method === 'saveEnrollment').map((call) => call.args?.name)).toEqual(['Flo']);
});

test('a typed name that is someone in the library adds to them, never a second one', async ({ page }) => {
  const listener = await dashboardOnPeople(page, false);
  listener.answers.captureEnrollmentSample = { embedding: [0.97, 0.25, 0], thumbnail: JPEG, duplicate: false };
  await page.locator('#dock-panel-people').getByRole('button', { name: 'Onboard' }).click();
  const wizard = page.getByRole('dialog', { name: 'Face onboarding' });
  await wizard.getByRole('combobox', { name: "Who's this?" }).fill('  flo ');
  await expect(wizard).toContainText('Adding photos to Flo');
  await wizard.getByRole('radio', { name: /Quick/ }).click();
  await wizard.getByRole('button', { name: 'Add photos to Flo' }).click();
  await wizard.getByRole('button', { name: 'Save face' }).click({ timeout: 10_000 });
  await expect(wizard).toContainText('Got it, Flo!');
  expect(listener.calls.find((call) => call.method === 'saveEnrollment')?.args?.name).toBe('Flo');
});

test('the library\'s Add photos: an uploaded photo without a face is refused with the reason', async ({ page }) => {
  const listener = await dashboardOnPeople(page, true);
  listener.answers.embedPicture = { ok: false, reason: 'no face found' };
  const people = page.locator('#dock-panel-people');
  await people.getByRole('button', { name: 'Library' }).click();
  const flo = page.getByRole('listitem', { name: 'Library person Flo', exact: true });
  await flo.getByRole('button', { name: 'Add photos' }).click();
  const adding = page.getByRole('group', { name: 'Add photos to Flo' });
  await expect(adding.getByRole('button', { name: 'Capture from the camera' })).toBeEnabled();
  await adding.getByLabel('Photos of Flo').setInputFiles({ name: 'empty-wall.png', mimeType: 'image/png', buffer: Buffer.from(BLANK_PNG, 'base64') });
  await expect(adding.getByRole('status')).toContainText('0 photos added to Flo; not used: empty-wall.png (no face found)');
  expect(listener.calls.find((call) => call.method === 'embedPicture')?.args?.image).toMatch(/^data:image\/jpeg;base64,/);
  expect(listener.calls.some((call) => call.method === 'saveEnrollment')).toBe(false);
});
