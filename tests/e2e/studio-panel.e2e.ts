import { expect, test, type Frame, type Page } from '@playwright/test';
import { received, resetMock } from './helpers.js';

// The Studio panel is the one place to run Tubs in the studio, and the
// sentient-studio panel shows it inside an iframe from another origin, on a
// laptop screen. Every control there has to reach this server from inside
// that iframe, and the panel has to fit.

const STUDIO = {
  enabled: true,
  site: 'http://127.0.0.1:8889',
  micSource: 'off',
  visionSource: 'off',
  actors: [
    { id: 'main', stream: 'tubs-main', publishing: true },
    { id: 'small', stream: 'tubs-small', publishing: false, error: 'face page not connected' },
  ],
  launch: 'chrome',
  ui: { dashboard: 'http://localhost:39190/?view=dashboard', memory: 'http://localhost:39190/?view=memory' },
  presets: { names: ['Pirate', 'Tubs'], active: 'Tubs' },
  parts: [
    { id: 'brain', label: 'Brain', where: 'generativelanguage.googleapis.com', ok: true, detail: 'gemini-3-flash · 840 ms' },
    { id: 'voices', label: 'Voices', where: 'studio-mac:3003', ok: true, detail: 'ming:friend, ming:friend-b' },
    { id: 'realtime', label: 'Speech service', where: 'studio-mac:3102', ok: true },
    { id: 'vision', label: 'Vision', where: 'fleet:vision (no box found yet)', ok: false, detail: 'qwen3-vl:4b-instruct' },
    { id: 'mic', label: 'Mic', where: 'off', ok: null },
    { id: 'faces', label: 'Face pages', where: 'Chrome @ studio-mac', ok: false, detail: 'main 30 fps · small not publishing' },
    { id: 'site', label: 'Site node', where: 'studio-mac:8889', ok: false, detail: 'face page not connected' },
  ],
};

// GET /studio/sources as the server builds it (studio/sources.ts).
const SNAPSHOT = 'snapshot:http://204-eeg.tail:8090/api/snapshot/color.jpg';
const SOURCES = {
  micSource: 'off',
  visionSource: 'off',
  mic: [
    { value: 'off', label: 'Off', kind: 'off', ready: true },
    { value: 'local', label: 'Default input', kind: 'local', ready: true },
    { value: 'local:Scarlett 2i2 USB', label: 'Scarlett 2i2 USB', kind: 'local', ready: true },
    { value: 'site:cam-flo-mac', label: 'cam-flo-mac', kind: 'site', ready: true, tracks: ['H264', 'Opus'] },
  ],
  vision: [
    { value: 'off', label: 'Off', kind: 'off', ready: true },
    { value: 'local', label: 'Default camera', kind: 'local', ready: true },
    { value: 'site:cam-c920', label: 'cam-c920', kind: 'site', ready: true, tracks: ['H264'] },
    { value: 'site:cam-flo-mac', label: 'cam-flo-mac', kind: 'site', ready: true, tracks: ['H264', 'Opus'] },
    { value: SNAPSHOT, label: 'RealSense · 204-eeg', kind: 'snapshot', ready: false },
  ],
  suggested: { mic: { value: 'site:cam-flo-mac', label: 'cam-flo-mac', kind: 'site', ready: true, tracks: ['H264', 'Opus'] } },
  problems: [],
};

async function fakeStudioServer(page: Page, studio: Record<string, unknown> = STUDIO): Promise<Array<{ path: string; body: unknown }>> {
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.route(/\/(studio(\/sources)?|presets(\/apply)?|relationships)(\?.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') posts.push({ path, body: request.postDataJSON() as unknown });
    if (request.method() === 'GET' && path === '/studio/sources') {
      posts.push({ path, body: null });
      await route.fulfill({ json: SOURCES });
    } else if (path === '/studio') await route.fulfill({ json: studio });
    else if (path.startsWith('/presets')) await route.fulfill({ json: { presets: [{ name: 'Pirate', savedAt: null }, { name: 'Tubs', savedAt: null }], active: 'Tubs' } });
    else if (request.method() === 'POST') await route.fulfill({ json: request.postDataJSON() as unknown });
    else await route.fulfill({ json: { relationships: [{ name: 'Flo', attitude: 'He is the boss.' }] } });
  });
  return posts;
}

/** The dashboard as the sentient panel shows it: an iframe from another origin, laptop sized. */
async function embeddedDashboard(page: Page): Promise<Frame> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent('<body style="margin:0"><iframe id="tubs" src="http://localhost:39190/?view=dashboard" style="width:1280px;height:720px;border:0"></iframe></body>');
  const frame = page.frame({ url: /localhost:39190/ });
  if (!frame) throw new Error('no dashboard frame');
  await frame.waitForLoadState();
  // The Studio tab is the dashboard's first; clicking an open tab folds the dock.
  const tab = frame.getByRole('tab', { name: /^Studio/ });
  await expect(tab).toBeVisible();
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  await expect(frame.locator('#dock-panel-studio')).toBeVisible();
  return frame;
}

test.afterEach(async ({ request }) => {
  await resetMock(request);
});

test('from inside a cross-origin iframe the Studio panel shows the heads and runs studio mode and sources', async ({ page, request }) => {
  const posts = await fakeStudioServer(page);
  const frame = await embeddedDashboard(page);
  const panel = frame.locator('#dock-panel-studio');
  await expect(panel.getByRole('list', { name: 'Heads' })).toContainText('tubs-main');
  await expect(panel.getByRole('list', { name: 'Heads' })).toContainText('face page not connected');
  await expect(panel.getByRole('link', { name: 'Memory view' })).toHaveAttribute('href', STUDIO.ui.memory);
  // What runs where, at the top: each part's machine, and a dot that says whether it works.
  const parts = panel.getByRole('list', { name: 'What runs where' });
  await expect(parts.getByRole('listitem')).toHaveCount(7);
  await expect(parts.locator('[data-part="vision"]')).toContainText('fleet:vision (no box found yet)');
  await expect(parts.getByRole('img', { name: 'Vision not ok' })).toBeVisible();
  await expect(parts.getByRole('img', { name: 'Voices ok' })).toBeVisible();
  await expect(parts.getByRole('img', { name: 'Mic not in use or not known' })).toBeVisible();

  await panel.getByRole('switch', { name: 'Studio mode' }).click();
  await expect.poll(() => posts.find((post) => post.path === '/studio')?.body).toEqual({ enabled: false });

  // A source nobody listed is typed: the override next to each pick list.
  const mic = panel.getByRole('group', { name: 'Mic source' });
  const vision = panel.getByRole('group', { name: 'Vision source' });
  await mic.getByLabel('Mic source, typed').fill('site:mic-1');
  await mic.getByRole('button', { name: 'Set' }).click();
  await expect.poll(() => posts.filter((post) => post.path === '/studio').at(-1)?.body).toEqual({ micSource: 'site:mic-1' });
  await vision.getByLabel('Vision source, typed').fill('snapshot:http://127.0.0.1:7000/api/snapshot/color.jpg');
  await vision.getByRole('button', { name: 'Set' }).click();
  await expect.poll(() => posts.filter((post) => post.path === '/studio').at(-1)?.body).toEqual({ visionSource: 'snapshot:http://127.0.0.1:7000/api/snapshot/color.jpg' });

  await panel.getByRole('combobox', { name: 'Provider' }).selectOption('openai');
  await panel.getByLabel('Model', { exact: true }).fill('qwen3-vl:4b-instruct');
  await panel.getByLabel('Base URL').fill('http://127.0.0.1:11434/v1');
  await panel.getByRole('button', { name: 'Apply model' }).click();
  await expect.poll(async () => (await received(request)).http.filter((entry) => entry.path === '/config').map((entry) => entry.body)).toEqual([
    { visionProvider: 'openai' },
    { visionModel: 'qwen3-vl:4b-instruct', visionBaseUrl: 'http://127.0.0.1:11434/v1' },
  ]);

  // Laptop width: nothing sticks out sideways.
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await panel.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
});

// Nobody has to remember a path: what the server found is a pick list (this
// Mac's devices, site streams, snapshots), choosing posts it at once, the one
// obvious pick is one click, and the list keeps up while the tab is open.
test('sources: pick lists from GET /studio/sources, posted on choosing, refreshed while open', async ({ page }) => {
  const calls = await fakeStudioServer(page, { ...STUDIO, visionSource: SNAPSHOT });
  const frame = await embeddedDashboard(page);
  const panel = frame.locator('#dock-panel-studio');
  const mic = panel.getByRole('group', { name: 'Mic source' });
  const vision = panel.getByRole('group', { name: 'Vision source' });
  const studioPosts = () => calls.filter((call) => call.path === '/studio').map((call) => call.body);
  // Asked when the tab opens, then every 5 s while it is open (nothing touched meanwhile).
  const asked = () => calls.filter((call) => call.path === '/studio/sources').length;
  await expect.poll(asked).toBeGreaterThan(0);
  const opened = asked();
  await expect.poll(asked, { timeout: 8000 }).toBeGreaterThan(opened);

  const micList = mic.getByRole('combobox', { name: 'Mic source' });
  await expect(micList.locator('optgroup')).toHaveCount(2);
  expect(await micList.locator('optgroup').evaluateAll((groups) => groups.map((group) => (group as HTMLOptGroupElement).label))).toEqual(["This Mac's devices", 'Site streams']);
  await expect(micList.locator('option', { hasText: 'cam-flo-mac · H264 Opus' })).toHaveCount(1);
  await expect(micList).toHaveValue('off');
  // The current vision source is selected; its camera is not answering (red dot).
  await expect(vision.getByRole('combobox', { name: 'Vision source' })).toHaveValue(SNAPSHOT);
  await expect(vision.getByRole('img', { name: 'Vision source down' })).toBeVisible();
  expect(await vision.locator('optgroup').evaluateAll((groups) => groups.map((group) => (group as HTMLOptGroupElement).label))).toEqual(["This Mac's devices", 'Site streams', 'Snapshots']);

  await micList.selectOption('local:Scarlett 2i2 USB');
  await expect.poll(() => studioPosts().at(-1)).toEqual({ micSource: 'local:Scarlett 2i2 USB' });
  await vision.getByRole('combobox', { name: 'Vision source' }).selectOption('site:cam-c920');
  await expect.poll(() => studioPosts().at(-1)).toEqual({ visionSource: 'site:cam-c920' });
  await mic.getByRole('button', { name: 'Use cam-flo-mac' }).click();
  await expect.poll(() => studioPosts().at(-1)).toEqual({ micSource: 'site:cam-flo-mac' });
  // The other field has no obvious pick, so no button.
  await expect(vision.getByRole('button', { name: /^Use / })).toHaveCount(0);

});

// Vision without the jargon: Ollama on this Mac, a fleet box by name or
// another host, a model from what that server has (the thinking variant that
// answers nothing is flagged, with the -instruct one a click away), and a
// Test with one picture before applying.
test('vision: pick a server and a model from lists, get warned off a thinking model, test, apply', async ({ page, request }) => {
  await fakeStudioServer(page);
  const tests: unknown[] = [];
  await page.route(/\/vision\/(servers|models|test)(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/vision/servers') {
      await route.fulfill({ json: { servers: [
        { label: 'Ollama on this machine', baseUrl: 'http://127.0.0.1:11434/v1', healthy: null },
        { label: 'Ollama via the fleet (the hub picks a box)', baseUrl: 'fleet:vision', healthy: null },
        { label: 'vision · msi', baseUrl: 'http://192.168.1.40:11434/v1', healthy: true },
      ] } });
    } else if (url.pathname === '/vision/models') {
      await route.fulfill({ json: { base: url.searchParams.get('base'), models: [
        { id: 'qwen3-vl:4b', warning: 'thinks before it answers: often an empty answer; use an -instruct model' },
        { id: 'qwen3-vl:4b-instruct' },
      ], suggested: 'qwen3-vl:4b-instruct' } });
    } else {
      tests.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, ms: 912, where: '192.168.1.40:11434', text: 'A person in a red coat.' } });
    }
  });
  const frame = await embeddedDashboard(page);
  const panel = frame.locator('#dock-panel-studio');
  const provider = panel.getByRole('combobox', { name: 'Provider' });
  await expect(provider.locator('option', { hasText: 'OpenAI-compatible (Ollama, LM Studio)' })).toHaveCount(1);
  await provider.selectOption('openai');

  await panel.getByRole('combobox', { name: 'Server' }).selectOption({ label: 'vision · msi' });
  await expect(panel.getByLabel('Base URL')).toHaveValue('http://192.168.1.40:11434/v1');
  await panel.getByRole('combobox', { name: 'Models on that server' }).selectOption('qwen3-vl:4b');
  await expect(panel.getByRole('note')).toContainText('empty answer');
  await panel.getByRole('button', { name: 'Use qwen3-vl:4b-instruct' }).click();
  await expect(panel.getByLabel('Model', { exact: true })).toHaveValue('qwen3-vl:4b-instruct');
  await expect(panel.getByRole('note')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Test' }).click();
  await expect(panel.locator('#vision-test-result')).toHaveText('912 ms at 192.168.1.40:11434: A person in a red coat.');
  expect(tests[0]).toMatchObject({ provider: 'openai', model: 'qwen3-vl:4b-instruct', baseUrl: 'http://192.168.1.40:11434/v1', frame: expect.stringMatching(/^data:image\/jpeg;base64,/) });

  await panel.getByRole('button', { name: 'Apply model' }).click();
  await expect.poll(async () => (await received(request)).http.filter((entry) => entry.path === '/config').map((entry) => entry.body).at(-1))
    .toEqual({ visionModel: 'qwen3-vl:4b-instruct', visionBaseUrl: 'http://192.168.1.40:11434/v1' });

  // Another machine, by host: Ollama's port unless one is given.
  await panel.getByRole('combobox', { name: 'Server' }).selectOption({ label: 'Another machine on the network…' });
  await panel.getByLabel('Host').fill('studio-box.local');
  await panel.getByRole('button', { name: 'Use host' }).click();
  await expect(panel.getByLabel('Base URL')).toHaveValue('http://studio-box.local:11434/v1');
});

test('presets: apply one and save the current character, from the panel', async ({ page }) => {
  const posts = await fakeStudioServer(page);
  const frame = await embeddedDashboard(page);
  const panel = frame.locator('#dock-panel-studio');
  await expect(panel.locator('#studio-preset-active')).toHaveText('Tubs');
  await panel.getByRole('combobox', { name: 'Preset' }).selectOption('Pirate');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => posts.find((post) => post.path === '/presets/apply')?.body).toEqual({ name: 'Pirate' });
  await panel.getByLabel('Save the current character as').fill('Night Two');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => posts.find((post) => post.path === '/presets')?.body).toEqual({ name: 'Night Two' });
});

test('relationships: switch them, add, edit and remove people, and save the list', async ({ page, request }) => {
  const posts = await fakeStudioServer(page);
  const frame = await embeddedDashboard(page);
  const panel = frame.locator('#dock-panel-studio');
  await expect(panel.getByRole('group', { name: 'Relationship Flo' }).getByLabel('Attitude')).toHaveValue('He is the boss.');

  await panel.getByRole('switch', { name: 'Relationships' }).click();
  await expect.poll(async () => (await received(request)).http.find((entry) => entry.path === '/config')?.body).toEqual({ relationshipsEnabled: false });

  await expect(panel.getByRole('button', { name: 'Save relationships' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Add person' }).click();
  const added = panel.getByRole('group', { name: 'Relationship 2' });
  await added.getByLabel('Name (as in the face library)').fill('Dimi');
  await panel.getByRole('group', { name: 'Relationship Dimi' }).getByLabel('Attitude').fill('An old friend; tease him about tea.');
  await panel.getByRole('group', { name: 'Relationship Flo' }).getByLabel('Attitude').fill('He is the boss. Be warm.');
  await panel.getByRole('button', { name: 'Save relationships' }).click();
  await expect.poll(() => posts.find((post) => post.path === '/relationships')?.body).toEqual({
    relationships: [{ name: 'Flo', attitude: 'He is the boss. Be warm.' }, { name: 'Dimi', attitude: 'An old friend; tease him about tea.' }],
  });

  await panel.getByRole('group', { name: 'Relationship Flo' }).getByRole('button', { name: 'Remove' }).click();
  await panel.getByRole('button', { name: 'Save relationships' }).click();
  await expect.poll(() => posts.filter((post) => post.path === '/relationships').at(-1)?.body).toEqual({
    relationships: [{ name: 'Dimi', attitude: 'An old friend; tease him about tea.' }],
  });
});
