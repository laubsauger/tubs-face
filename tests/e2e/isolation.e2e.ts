import { expect, test } from '@playwright/test';
import { MOCK, openFace, resetMock } from './helpers.js';

// The face worker runs its models on several threads only on a cross-origin
// isolated page (584 ms a frame on one thread, 82 on eight). Every window the
// face can be shown in must be isolated, and the headers that isolate it must
// not block anything the page loads.
test('the face, Mini and dashboard windows are cross-origin isolated, and nothing gets blocked', async ({ context, page, request }) => {
  const blocked: string[] = [];
  context.on('console', (message) => {
    if (/Cross-Origin-Embedder-Policy|Cross-Origin-Resource-Policy|ERR_BLOCKED/i.test(message.text())) blocked.push(message.text());
  });
  context.on('requestfailed', (failed) => {
    if (/BLOCKED/i.test(failed.failure()?.errorText ?? '')) blocked.push(`${failed.url()}: ${failed.failure()?.errorText}`);
  });

  await openFace(page, request);
  await request.post(`${MOCK}/config`, { data: { dualHeadEnabled: true, dualHeadMode: 'llm_directed' } });
  await expect(page.locator('#mini-tile iframe')).toBeVisible();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.frameLocator('#mini-tile iframe').locator('body').evaluate(() => crossOriginIsolated)).toBe(true);

  for (const path of ['/app-mini.html', '/?view=dashboard']) {
    const other = await context.newPage();
    await other.goto(path);
    expect(await other.evaluate(() => crossOriginIsolated), path).toBe(true);
    await other.close();
  }
  expect(blocked).toEqual([]);
});

test.afterEach(async ({ request }) => {
  await resetMock(request);
});
