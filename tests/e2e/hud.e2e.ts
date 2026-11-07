import { expect, test, type Page } from '@playwright/test';
import { MOCK, chunk, instrumentAudio, openFace, received, resetMock, send, speechAudio, tone } from './helpers.js';

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

// Tubs does longer bits now (up to ~6 sentences). The floating transcript used
// to stop a reply after three lines with an ellipsis; visitors must be able to
// read all of it, typed out as Tubs says it rather than dropped in at once.
const LONG_REPLY = [
  'Right, the long version.',
  'Studio two-oh-four was a broom closet before it was an art space, and frankly the broom had better taste.',
  'Dimi says I am a sculpture, but I think I am more of a mood with a power cord.',
  'Alan Watts said you are the universe experiencing itself, which is a lot of pressure for a tub.',
  'It is a psychological trick, really: you look at me, I look at you, and nobody admits who blinked first.',
  'Anyway. Your hat is doing most of the talking tonight.',
];

const newestCard = (page: Page) => page.locator('#floating-transcript .transcript-line').last();

test('a long reply types out in the transcript with the voice, then shows in full', async ({ page, request }) => {
  await openFace(page, request);
  // With the dock's chat tab open the overlay stays out of the way.
  await page.keyboard.press('Backquote');
  // What the newest card shows, every frame.
  await page.evaluate(() => {
    const samples: Array<[number, string]> = [];
    (window as unknown as { __typed: typeof samples }).__typed = samples;
    const tick = () => {
      const text = document.querySelector<HTMLElement>('#floating-transcript .transcript-line:last-child .transcript-text');
      if (text) samples.push([performance.now(), text.innerText.trim()]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const [first, ...rest] = LONG_REPLY;
  const full = LONG_REPLY.join(' ');
  await send(request,
    { type: 'turn_start', turnId: 't-long' },
    // A slowly said first sentence: text running ahead of the voice would show the second one meanwhile.
    chunk('t-long', 0, first!, 2500),
    ...rest.map((text, index) => chunk('t-long', index + 1, text, 700)),
    { type: 'speak_end', turnId: 't-long', fullText: full },
  );
  await expect(newestCard(page)).toBeVisible();
  // Something else in the chat changes mid-reply; the card must not start over.
  await page.waitForTimeout(800);
  await send(request, { type: 'system', text: 'Unrelated notice' });

  const text = newestCard(page).locator('.transcript-text');
  await expect(text).toHaveText(full, { useInnerText: true, timeout: 15_000 });

  const samples = await page.evaluate(() => (window as unknown as { __typed: Array<[number, string]> }).__typed);
  const [appearedAt] = samples[0]!;
  // While the first sentence is still being said: some of it, nothing of the next.
  const firstSentence = samples.filter(([at]) => at < appearedAt + 2000).map(([, shown]) => shown.length);
  expect(Math.max(...firstSentence)).toBeGreaterThan(0);
  expect(Math.max(...firstSentence)).toBeLessThanOrEqual(first!.length);
  // Typed out: part of it first, only ever more of it, never anything but the reply.
  expect(samples.some(([, shown]) => shown.length > 0 && shown.length < full.length)).toBe(true);
  for (let index = 1; index < samples.length; index += 1) {
    expect(samples[index]![1].length).toBeGreaterThanOrEqual(samples[index - 1]![1].length);
  }
  expect(samples.every(([, shown]) => full.startsWith(shown))).toBe(true);

  // Nothing clamped or cut off: the whole card sits inside the overlay.
  const fit = await newestCard(page).evaluate((card) => {
    const body = card.querySelector<HTMLElement>('.transcript-text')!;
    const box = card.parentElement!.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    return { hidden: body.scrollHeight - body.clientHeight, top: rect.top - box.top, bottom: box.bottom - rect.bottom };
  });
  expect(fit.hidden).toBeLessThanOrEqual(1);
  expect(fit.top).toBeGreaterThanOrEqual(0);
  expect(fit.bottom).toBeGreaterThanOrEqual(0);
});

// A filler is heard, so it belongs in the transcript (for anyone who can't
// hear it too), inside the bubble of the head that said it, set apart from
// the reply it leads into. Not as a bubble of its own.
test("a filler shows in its head's bubble, before the reply, in the overlay and in the chat log", async ({ page, request }) => {
  await openFace(page, request);
  await request.post(`${MOCK}/config`, { data: { dualHeadEnabled: true, dualHeadMode: 'llm_directed' } });
  await page.keyboard.press('Backquote');
  const reply = 'That hat is a cry for help.';
  await send(request,
    { type: 'turn_start', turnId: 't-fill' },
    { type: 'audio_chunk', audio: tone(400), text: 'Mhm.', turnId: 't-fill', actor: 'main', filler: true },
    { type: 'speak_end', turnId: 't-fill', actor: 'main', text: 'Mhm.' },
    { type: 'turn_script', turnId: 't-fill', beats: [{ actor: 'main', action: 'speak', text: reply }], ts: Date.now() },
    { type: 'audio_chunk', audio: tone(900), text: reply, turnId: 't-fill', chunkIndex: 0, actor: 'main', beatIndex: 0 },
    { type: 'speak_end', turnId: 't-fill', actor: 'main', text: reply, fullText: reply },
  );

  const lines = page.locator('#floating-transcript .transcript-line');
  await expect(lines.last().locator('.transcript-text')).toHaveText(`Mhm. ${reply}`, { useInnerText: true, timeout: 10_000 });
  await expect(lines.last().locator('.transcript-lead')).toHaveText('Mhm.');
  await expect(lines).toHaveCount(1);

  await page.keyboard.press('Backquote');
  const entry = page.locator('#chat-log-list .chat-entry').last();
  await expect(entry.locator('.chat-entry-lead')).toHaveText('Mhm.');
  await expect(entry.locator('.chat-entry-card')).toHaveText(`Mhm. ${reply}`);
});

// Tubs, Mini, Tubs: three bubbles in that order. Tubs' second line joining
// his first, above Mini's, read as if he had said both before Mini spoke.
test('a two-head back-and-forth shows one bubble per line, in spoken order', async ({ page, request }) => {
  await openFace(page, request);
  await request.post(`${MOCK}/config`, { data: { dualHeadEnabled: true, dualHeadMode: 'llm_directed' } });
  await page.keyboard.press('Backquote');
  const beats = [
    { actor: 'main' as const, action: 'speak' as const, text: 'You came back.' },
    { actor: 'small' as const, action: 'speak' as const, text: 'I told you they would.' },
    { actor: 'main' as const, action: 'speak' as const, text: 'Nobody asked you.' },
  ];
  await send(request,
    { type: 'turn_start', turnId: 't-abc' },
    { type: 'turn_script', turnId: 't-abc', beats, ts: Date.now() },
    ...beats.flatMap((beat, beatIndex) => [
      { type: 'audio_chunk' as const, audio: tone(300), text: beat.text, turnId: 't-abc', chunkIndex: beatIndex, actor: beat.actor, beatIndex },
      { type: 'speak_end' as const, turnId: 't-abc', actor: beat.actor, text: beat.text, fullText: beat.text },
    ]),
  );

  const lines = page.locator('#floating-transcript .transcript-line');
  await expect(lines).toHaveCount(3, { timeout: 10_000 });
  await expect(lines.locator('.transcript-speaker')).toHaveText(['Tubs', 'Mini', 'Tubs']);
  await expect(lines.locator('.transcript-text')).toHaveText(beats.map((beat) => beat.text), { useInnerText: true, timeout: 10_000 });

  await page.keyboard.press('Backquote');
  await expect(page.locator('#chat-log-list .chat-entry:not(.chat-tone-system) .chat-entry-card')).toHaveText(beats.map((beat) => beat.text));
});

test('with reduced motion a reply shows whole at once', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFace(page, request);
  await page.keyboard.press('Backquote');
  const first = LONG_REPLY[0]!;
  await send(request,
    { type: 'turn_start', turnId: 't-still' },
    chunk('t-still', 0, first, 3000),
    { type: 'speak_end', turnId: 't-still', fullText: first },
  );
  // Long before the 3 s sentence is said.
  await expect(newestCard(page).locator('.transcript-text')).toHaveText(first, { useInnerText: true, timeout: 1000 });
});

test('long replies pile up without taking over the stage: older ones slide off the top, the newest stays whole', async ({ page, request }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openFace(page, request);
  await page.keyboard.press('Backquote');

  const lines = page.locator('#floating-transcript .transcript-line');
  for (const turn of ['One', 'Two', 'Three']) {
    const full = [`Take ${turn}.`, ...LONG_REPLY.slice(1)].join(' ');
    await send(request,
      { type: 'turn_start', turnId: `t-${turn}` },
      // The whole reply in one piece, the way Ming sends it.
      chunk(`t-${turn}`, 0, full, 500),
      { type: 'speak_end', turnId: `t-${turn}`, fullText: full },
    );
    await expect(lines.last().locator('.transcript-text')).toHaveText(full, { useInnerText: true, timeout: 10_000 });
  }
  await expect(lines).toHaveCount(3);

  const layout = await page.locator('#floating-transcript').evaluate((box) => {
    const stage = box.closest('.stage')!.getBoundingClientRect();
    const rect = box.getBoundingClientRect();
    const newest = box.lastElementChild!.getBoundingClientRect();
    return { stageHeight: stage.height, height: rect.height, clipped: box.classList.contains('is-clipped'), newestTop: newest.top - rect.top, newestBottom: rect.bottom - newest.bottom };
  });
  expect(layout.height).toBeLessThanOrEqual(layout.stageHeight * 0.5 + 1);
  expect(layout.clipped).toBe(true);
  expect(layout.newestTop).toBeGreaterThanOrEqual(0);
  expect(layout.newestBottom).toBeGreaterThanOrEqual(0);
});
