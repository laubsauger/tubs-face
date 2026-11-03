import { expect, test } from '@playwright/test';
import { openFace, received } from './helpers.js';

// Operator tools used during a session.
test.beforeEach(async ({ page, request }) => {
  await openFace(page, request);
});

test('Manual Beats sends a typed line to the server as a beat script', async ({ page, request }) => {
  await page.getByRole('button', { name: /Manual Beats/ }).click();
  await page.locator('#manual-beat-text').fill('Happy opening night, humans.');
  await page.locator('#manual-beats-send').click();

  await expect.poll(async () => {
    const post = (await received(request)).http.find((entry) => entry.path === '/turn-script/manual');
    const beats = (post?.body as { beats?: Array<{ actor?: string; action?: string; text?: string }> } | undefined)?.beats;
    return beats?.[0];
  }).toMatchObject({ actor: 'main', action: 'speak', text: 'Happy opening night, humans.' });
});

test('Controls > Speak sends the line for Tubs to say', async ({ page, request }) => {
  await page.getByRole('button', { name: /Controls/ }).click();
  await page.getByPlaceholder('Line for Tubs to say').fill('Testing one two.');
  await page.locator('#action-speak').click();

  await expect.poll(async () => (await received(request)).http.find((entry) => entry.path === '/speak')?.body).toMatchObject({ text: 'Testing one two.' });
});
