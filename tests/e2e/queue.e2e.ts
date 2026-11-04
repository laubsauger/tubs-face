import { expect, test } from '@playwright/test';
import { MOCK, instrumentAudio, now, openFace, received, send, speechAudio } from './helpers.js';

// The spoken-line queue: scripted beats (Manual Beats, turn scripts in
// single-head mode) and plain speak lines play one after another, with the
// scripted pauses, and an interrupt drops whatever is still queued.

type Received = Record<string, unknown> & { receivedAt: number };

async function ttsRequests(request: Parameters<typeof received>[0]): Promise<Received[]> {
  return (await received(request)).ws.filter((m) => m.type === 'tts_request') as Received[];
}

test.beforeEach(async ({ page, request }) => {
  await instrumentAudio(page);
  await openFace(page, request);
});

test('a beat script plays in order, waiting out each line and the pause between', async ({ page, request }) => {
  await send(request, {
    type: 'turn_script',
    turnId: 't-script',
    beats: [
      { actor: 'main', action: 'speak', text: 'First beat.' },
      { actor: 'main', action: 'react', emoji: '😏', delayMs: 600 },
      { actor: 'main', action: 'speak', text: 'Second beat.' },
    ],
    ts: Date.now(),
  });

  await expect.poll(async () => (await ttsRequests(request)).map((m) => m.text), { timeout: 8000 }).toEqual(['First beat.', 'Second beat.']);
  const [first, second] = await ttsRequests(request);
  // The mock answers each line with 900 ms of audio; then the 600 ms react pause.
  expect(second!.receivedAt - first!.receivedAt).toBeGreaterThanOrEqual(900 + 600 - 100);

  await expect.poll(async () => (await speechAudio(page)).length).toBe(2);
  const [a, b] = await speechAudio(page);
  expect(b!.calledAt).toBeGreaterThanOrEqual(a!.calledAt + a!.duration * 1000 - 50);
});

test('a small-head line in single-head mode is voiced with the small voice', async ({ request }) => {
  const config = await (await request.get(`${MOCK}/config`)).json() as { secondaryVoice: string; kokoroVoice: string };
  await send(request, {
    type: 'turn_script',
    turnId: 't-small',
    beats: [{ actor: 'small', action: 'speak', text: 'Tiny voice here.' }],
    ts: Date.now(),
  });

  await expect.poll(async () => (await ttsRequests(request))[0]?.voice).toBe(config.secondaryVoice);
  expect(config.secondaryVoice).not.toBe(config.kokoroVoice);
});

test('an interrupt drops the rest of a running script', async ({ page, request }) => {
  await send(request, {
    type: 'turn_script',
    turnId: 't-cut',
    beats: [
      { actor: 'main', action: 'speak', text: 'Line one.' },
      { actor: 'main', action: 'speak', text: 'Line two.' },
      { actor: 'main', action: 'speak', text: 'Line three.' },
    ],
    ts: Date.now(),
  });
  await expect.poll(async () => (await speechAudio(page)).length).toBe(1);

  const interruptedAt = await now(page);
  await send(request, { type: 'interrupt', turnId: 't-cut', source: 'user' });
  await page.waitForTimeout(2500);

  expect((await ttsRequests(request)).map((m) => m.text)).toEqual(['Line one.']);
  const audio = await speechAudio(page);
  expect(audio).toHaveLength(1);
  expect((audio[0]!.stoppedAt ?? audio[0]!.endedAt)!).toBeLessThan(interruptedAt + 250);
  await expect(page.locator('#visual-face')).not.toHaveClass(/is-speaking/);
});

test('two speak lines sent together play one after the other', async ({ page, request }) => {
  await send(request,
    { type: 'speak', text: 'Number one.', turnId: 't-q1', ts: Date.now() },
    { type: 'speak', text: 'Number two.', turnId: 't-q2', ts: Date.now() },
  );

  await expect.poll(async () => (await ttsRequests(request)).map((m) => m.text), { timeout: 8000 }).toEqual(['Number one.', 'Number two.']);
  const [first, second] = await ttsRequests(request);
  expect(second!.receivedAt - first!.receivedAt).toBeGreaterThanOrEqual(900 - 100);
  await expect.poll(async () => (await speechAudio(page)).length).toBe(2);
  const [a, b] = await speechAudio(page);
  expect(b!.calledAt).toBeGreaterThanOrEqual(a!.calledAt + a!.duration * 1000 - 50);
});

test('after an interrupt the next line plays right away', async ({ page, request }) => {
  await send(request, { type: 'speak', text: 'This line gets cut off.', turnId: 't-a', ts: Date.now() });
  await expect.poll(async () => (await speechAudio(page)).length).toBe(1);
  await send(request, { type: 'interrupt', turnId: 't-a', source: 'user' });
  await page.waitForTimeout(200);

  const sentAt = Date.now();
  await send(request, { type: 'speak', text: 'Fresh line.', turnId: 't-b', ts: Date.now() });
  // Before, the abandoned line's wait could hold the queue for up to 60 s.
  await expect.poll(async () => (await ttsRequests(request)).find((m) => m.text === 'Fresh line.')?.receivedAt ?? 0, { timeout: 3000 }).toBeGreaterThan(0);
  const fresh = (await ttsRequests(request)).find((m) => m.text === 'Fresh line.')!;
  expect(fresh.receivedAt - sentAt).toBeLessThan(1000);
  await expect.poll(async () => (await speechAudio(page)).length).toBe(2);
});

