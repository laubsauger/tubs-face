import { expect, test } from '@playwright/test';
import { chunk, openFace, received, send } from './helpers.js';

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

// The operator could not see Tubs's mood or any error: both panels were hidden.
test('Mind shows the mood in words after an annoyed reply', async ({ page, request }) => {
  await page.getByRole('button', { name: /Mind/ }).click();
  const annoyed = { emoji: '😤', expression: 'angry', impulse: { pos: 0.24, neg: 0.56, arousal: 0.82 } };
  await send(request, { type: 'turn_start', turnId: 't-mind' }, { ...chunk('t-mind', 0, 'Oh, you again.', 600), emotion: annoyed });
  await expect(page.locator('#mind-mood')).toHaveText('irritated', { timeout: 5000 });
});

test('Event Log shows errors the operator would otherwise never see', async ({ page, request }) => {
  await page.getByRole('button', { name: /Event Log/ }).click();
  await send(request, { type: 'error', text: 'TTS stream failed: test' });
  await expect(page.locator('#event-log-list')).toContainText('TTS stream failed: test');
  await expect(page.getByRole('button', { name: /Event Log/ })).toContainText('1 error');
});
