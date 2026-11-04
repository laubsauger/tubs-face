import { expect, test, type Page } from '@playwright/test';
import { MOCK, chunk, instrumentAudio, openFace, received, resetMock, send, speechAudio } from './helpers.js';

// The operator HUD: a status bar, the face, and a dock beside it. The face must
// stay visible and keep working (camera, speech) however the dock is set up.

const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) });

test.afterEach(async ({ request }) => {
  await resetMock(request);
});

test('typing reaches Tubs with the dock folded', async ({ page, request }) => {
  await openFace(page, request);
  await page.keyboard.press('Backquote');
  await expect(page.locator('.dock-pane')).toBeHidden();

  await page.keyboard.type('hello there');
  await expect(page.locator('#quick-chat-input')).toHaveValue('hello there');
  await page.keyboard.press('Enter');

  await expect.poll(async () => (await received(request)).http.find((entry) => entry.path === '/incoming')?.body).toMatchObject({ text: 'hello there' });
});

test('the FX editor is a tab beside the live face, and Escape goes back to where the operator was', async ({ page, request }) => {
  await openFace(page, request);
  await tab(page, 'Mind').click();
  await page.keyboard.press('e');
  await expect(page.locator('#dock-panel-fx')).toBeVisible();

  // The face is not covered: it sits left of the dock, at a usable size.
  const face = await page.locator('#visual-face').boundingBox();
  const dock = await page.locator('.dock').boundingBox();
  expect(face && dock).toBeTruthy();
  expect(face!.width).toBeGreaterThan(400);
  expect(face!.x + face!.width).toBeLessThanOrEqual(dock!.x + 1);

  await page.keyboard.press('Escape');
  await expect(page.locator('#dock-panel-fx')).toBeHidden();
  await expect(page.locator('#dock-panel-mind')).toBeVisible();
  // Escape closed the editor; it must not also have put Tubs to sleep.
  expect((await received(request)).http.map((entry) => entry.path)).not.toContain('/sleep');
});

test('perform mode gives the face the whole screen with only the chosen overlays, and survives a reload', async ({ page, request }) => {
  await openFace(page, request);
  await tab(page, 'Settings').click();
  await page.getByRole('switch', { name: 'Subtitles' }).uncheck();
  await page.keyboard.press('z');

  await expect(page.locator('.status-bar')).toBeHidden();
  await expect(page.locator('.dock')).toBeHidden();
  const viewport = page.viewportSize()!;
  await expect.poll(async () => (await page.locator('#visual-face').boundingBox())?.width).toBe(viewport.width);
  expect((await page.locator('#visual-face').boundingBox())?.height).toBe(viewport.height);
  await expect(page.locator('#visual-subtitle')).toBeHidden();
  await expect(page.locator('#visual-listening-dot')).toBeVisible();

  await page.reload();
  await page.locator('#visual-face').waitFor();
  await expect(page.locator('.status-bar')).toBeHidden();
  await expect(page.locator('#visual-subtitle')).toBeHidden();
});

// The camera <video> lives in the People tab. Taken out of the page it would
// stop, and Tubs would keep seeing the last frame.
test('the camera keeps running with the dock folded and in perform mode', async ({ page, request }) => {
  await openFace(page, request);
  const video = page.locator('#face-camera-video');
  const currentTime = () => video.evaluate((element: HTMLVideoElement) => element.currentTime);
  const advances = async () => {
    const before = await currentTime();
    await page.waitForTimeout(600);
    return (await currentTime()) > before;
  };

  await page.keyboard.press('c');
  await expect.poll(currentTime).toBeGreaterThan(0);
  await page.keyboard.press('Backquote');
  expect(await advances()).toBe(true);
  await page.keyboard.press('z');
  expect(await advances()).toBe(true);
});

test('two heads in one window: the mini tile shows Small, and steps aside for a mini window', async ({ context, page, request }) => {
  await openFace(page, request);
  await expect(page.locator('#mini-tile')).toHaveCount(0);

  await request.post(`${MOCK}/config`, { data: { dualHeadEnabled: true, dualHeadMode: 'llm_directed' } });
  await expect(page.locator('#mini-tile iframe')).toBeVisible();
  // The tile is the real mini app, with its own face.
  await expect(page.frameLocator('#mini-tile iframe').locator('#visual-face')).toBeAttached();

  // A mini window anywhere in this browser takes over, so Small is never on screen, or heard, twice.
  const mini = await context.newPage();
  await mini.goto('/app-mini.html');
  await expect(page.locator('#mini-tile')).toHaveCount(0);
  await mini.close();
  await expect(page.locator('#mini-tile')).toHaveCount(1, { timeout: 8000 });
});

// Multi-screen: face on one screen, the dashboard on another. The operator works
// from the dashboard, so the face screen goes clean, and the dashboard still
// sees what only the face window knows (mic, camera).
test('a dashboard takes over the HUD: the face window goes clean and follows its perform toggle', async ({ context, page, request }) => {
  await openFace(page, request);
  await expect(page.locator('.status-bar')).toBeVisible();
  const dashboard = await context.newPage();
  await dashboard.goto('/?view=dashboard');

  await expect(page.locator('.status-bar')).toBeHidden();
  await expect(dashboard.locator('#face-perform-toggle')).toContainText('perform');
  await expect(dashboard.locator('#status-mic')).not.toContainText('No face window');

  await dashboard.locator('#face-perform-toggle').click();
  await expect(page.locator('.status-bar')).toBeVisible();
  await expect(dashboard.locator('#face-perform-toggle')).toContainText('dev view');
});

// The server sends speech audio to every client. A dashboard on a third screen
// that also played it, or grabbed the mic or camera, would wreck the show.
test('the dashboard plays no speech and opens no mic or camera', async ({ page, request }) => {
  await instrumentAudio(page);
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as unknown as { __media: unknown[] }).__media = calls;
    const devices = navigator.mediaDevices;
    if (devices) {
      const original = devices.getUserMedia.bind(devices);
      devices.getUserMedia = (constraints) => {
        calls.push(constraints);
        return original(constraints);
      };
    }
  });
  await resetMock(request);
  await page.goto('/?view=dashboard');
  await expect(page.locator('#chat-panel-input')).toBeVisible();
  await expect(page.locator('#visual-face')).toHaveCount(0);
  for (let i = 0; i < 100; i += 1) {
    const { clients } = await (await request.get(`${MOCK}/__test/clients`)).json() as { clients: number };
    if (clients > 0) break;
    await page.waitForTimeout(100);
  }
  await request.post(`${MOCK}/__test/reset-received`);

  await send(request,
    { type: 'turn_start', turnId: 't-dash' },
    chunk('t-dash', 0, 'Hello from the face.', 600),
    { type: 'speak_end', turnId: 't-dash', fullText: 'Hello from the face.' },
  );
  await expect(page.locator('#chat-log-list')).toContainText('Hello from the face.');
  await page.waitForTimeout(800);

  expect(await speechAudio(page)).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as { __media: unknown[] }).__media)).toEqual([]);
  // Nor does it talk for the face on the socket (TTS requests, speech state, gaze).
  expect((await received(request)).ws.filter((message) => message.type !== 'ping')).toEqual([]);

  // Typing goes straight to its chat column.
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.type('hi');
  await expect(page.locator('#chat-panel-input')).toHaveValue('hi');
});
