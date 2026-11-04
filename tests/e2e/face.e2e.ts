import { expect, test } from '@playwright/test';
import { chunk, instrumentAudio, openFace, send } from './helpers.js';

// How the face behaves around speech. A face that stares at the visitor while
// "thinking" reads as a frozen screen; people look away and back.

test.beforeEach(async ({ page, request }) => {
  await instrumentAudio(page);
  await openFace(page, request);
});

const gaze = (page: import('@playwright/test').Page) => page.locator('#visual-face').evaluate((face) => ({
  x: Number(getComputedStyle(face).getPropertyValue('--gaze-x')),
  y: Number(getComputedStyle(face).getPropertyValue('--gaze-y')),
}));

test('looks up and away while thinking, and back at the visitor once it speaks', async ({ page, request }) => {
  // Pin the dice: this turn looks away, to the left.
  await page.evaluate(() => { Math.random = () => 0.1; });
  await send(request, { type: 'thinking' });
  await expect.poll(async () => (await gaze(page)).y).toBeLessThan(-0.2);
  expect((await gaze(page)).x).toBeLessThan(-0.2);

  await send(request, { type: 'turn_start', turnId: 't-gaze' }, chunk('t-gaze', 0, 'Right, so.', 600));
  await expect.poll(async () => Math.abs((await gaze(page)).y)).toBeLessThan(0.05);
});

test('some turns keep looking straight ahead while thinking', async ({ page, request }) => {
  await page.evaluate(() => { Math.random = () => 0.9; });
  await send(request, { type: 'thinking' });
  await page.waitForTimeout(800);
  expect(Math.abs((await gaze(page)).y)).toBeLessThan(0.05);
});
