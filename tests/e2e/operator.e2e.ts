import { expect, test } from '@playwright/test';
import { chunk, openFace, received, send } from './helpers.js';

// Operator tools used during a session. They live in the dock beside the face,
// one tab at a time.
test.beforeEach(async ({ page, request }) => {
  await openFace(page, request);
});

const tab = (page: import('@playwright/test').Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) });

test('Manual Beats sends a typed line to the server as a beat script', async ({ page, request }) => {
  await tab(page, 'Controls').click();
  await page.locator('#manual-beat-text').fill('Happy opening night, humans.');
  await page.locator('#manual-beats-send').click();

  await expect.poll(async () => {
    const post = (await received(request)).http.find((entry) => entry.path === '/turn-script/manual');
    const beats = (post?.body as { beats?: Array<{ actor?: string; action?: string; text?: string }> } | undefined)?.beats;
    return beats?.[0];
  }).toMatchObject({ actor: 'main', action: 'speak', text: 'Happy opening night, humans.' });
});

test('Controls > Speak sends the line for Tubs to say', async ({ page, request }) => {
  await tab(page, 'Controls').click();
  await page.getByPlaceholder('Line for Tubs to say').fill('Testing one two.');
  await page.locator('#action-speak').click();

  await expect.poll(async () => (await received(request)).http.find((entry) => entry.path === '/speak')?.body).toMatchObject({ text: 'Testing one two.' });
});

// The operator could not see Tubs's mood or any error: both panels were hidden.
test('Mind shows the mood in words after an annoyed reply', async ({ page, request }) => {
  await tab(page, 'Mind').click();
  const annoyed = { emoji: '😤', expression: 'angry', impulse: { pos: 0.24, neg: 0.56, arousal: 0.82 } };
  await send(request, { type: 'turn_start', turnId: 't-mind' }, { ...chunk('t-mind', 0, 'Oh, you again.', 600), emotion: annoyed });
  await expect(page.locator('#mind-mood')).toHaveText('irritated', { timeout: 5000 });
});

test('Event Log shows errors the operator would otherwise never see', async ({ page, request }) => {
  await tab(page, 'Log').click();
  const errorsBefore = await page.locator('#event-log-list li.text-rose-300').count();
  await send(request, { type: 'error', text: 'TTS stream failed: test' });
  await expect(page.locator('#event-log-list')).toContainText('TTS stream failed: test');
  const errors = errorsBefore + 1;
  await expect(page.locator('#dock-panel-log .panel-header')).toContainText(`${errors} error`);
  // Seen at a glance on the rail, without opening the tab.
  await tab(page, 'Chat').click();
  await expect(tab(page, 'Log').locator('.dock-rail-badge')).toHaveText(String(errors));
});

test('Mind shows the field notes on the visitor in front of Tubs', async ({ page, request }) => {
  await tab(page, 'Mind').click();
  await send(request, {
    type: 'field_notes',
    people: [
      { id: 'a', position: 'left', names: ['Anna'], returning: true, notes: ['works in marketing'] },
      { id: 'b', position: 'right', names: [], returning: false, notes: ['owns three phones'] },
    ],
    groupNotes: ['came as a couple'],
    quotes: ['AI art is real art'],
  });
  const notes = page.locator('#mind-notes');
  await expect(notes).toContainText('Left · Anna · back again');
  await expect(notes).toContainText('works in marketing');
  await expect(notes).toContainText('Right · stranger');
  await expect(notes).toContainText('The group: came as a couple');
  await expect(page.locator('#mind-quotes')).toContainText('AI art is real art');
});

// Without camera snapshots there is nothing to enroll from; the operator sees why.
test('an enroll request without face snapshots is logged, not silently dropped', async ({ page, request }) => {
  await tab(page, 'Log').click();
  await send(request, { type: 'enroll_request', personId: 'p-none', name: 'Dana' });
  await expect(page.locator('#event-log-list')).toContainText('Auto onboarding: no face snapshots for Dana');
});
