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
};

async function fakeStudioServer(page: Page): Promise<Array<{ path: string; body: unknown }>> {
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.route(/\/(studio|presets(\/apply)?|relationships)(\?.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') posts.push({ path, body: request.postDataJSON() as unknown });
    if (path === '/studio') await route.fulfill({ json: STUDIO });
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

  await panel.getByRole('switch', { name: 'Studio mode' }).click();
  await expect.poll(() => posts.find((post) => post.path === '/studio')?.body).toEqual({ enabled: false });

  await panel.getByLabel('Mic source').fill('site:mic-1');
  await panel.getByLabel('Vision source').fill('snapshot:http://127.0.0.1:7000/api/snapshot/color.jpg');
  await panel.getByRole('button', { name: 'Apply sources' }).click();
  await expect.poll(() => posts.filter((post) => post.path === '/studio').at(-1)?.body).toEqual({ micSource: 'site:mic-1', visionSource: 'snapshot:http://127.0.0.1:7000/api/snapshot/color.jpg' });

  await panel.getByRole('combobox', { name: 'Provider' }).selectOption('openai');
  await panel.getByLabel('Model').fill('qwen3-vl:4b-instruct');
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
