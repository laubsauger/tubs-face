import { expect, test } from '@playwright/test';
import { chunk, instrumentAudio, now, openFace, received, send, speechAudio } from './helpers.js';

// What the audience hears and sees when Tubs talks. Each test scripts the
// server messages a real turn produces and checks the audio that actually
// played, the subtitles, the face's speaking state and what the page reports.

test.beforeEach(async ({ page, request }) => {
  await instrumentAudio(page);
  await openFace(page, request);
});

test('plays a streamed reply sentence by sentence, back to back, then finishes', async ({ page, request }) => {
  await send(request,
    { type: 'turn_start', turnId: 't-stream' },
    chunk('t-stream', 0, 'First line.', 800),
    chunk('t-stream', 1, 'Second line.', 800),
    { type: 'speak_end', turnId: 't-stream', fullText: 'First line. Second line.', emotion: { emoji: '😏' } },
  );

  await expect.poll(async () => (await speechAudio(page)).length).toBe(2);
  const [first, second] = await speechAudio(page);
  // Scheduled back to back: no gap long enough to hear, no overlap.
  expect(second!.startAt).toBeGreaterThanOrEqual(first!.startAt + first!.duration - 0.02);
  expect(second!.startAt).toBeLessThan(first!.startAt + first!.duration + 0.25);

  await expect(page.locator('#visual-face')).toHaveClass(/is-speaking/);
  await expect(page.locator('#visual-subtitle')).toContainText(/line/);

  // Done: speaking state cleared, and the page told the server start then end.
  await expect(page.locator('#visual-face')).not.toHaveClass(/is-speaking/, { timeout: 5000 });
  const states = (await received(request)).ws
    .filter((m) => m.type === 'head_speech_state' && m.turnId === 't-stream')
    .map((m) => m.state);
  expect(states).toEqual(['start', 'end']);
});

test('an interrupt stops the reply at once and drops its late audio', async ({ page, request }) => {
  await send(request,
    { type: 'turn_start', turnId: 't-int' },
    chunk('t-int', 0, 'This is a long first sentence.', 2500),
    chunk('t-int', 1, 'And a long second one.', 2500),
  );
  await expect.poll(async () => (await speechAudio(page)).length).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(500);

  const interruptedAt = await now(page);
  await send(request, { type: 'interrupt', turnId: 't-int', source: 'user' });
  await page.waitForTimeout(150);
  // Audio for the interrupted turn that was still in flight.
  await send(request, chunk('t-int', 2, 'Late audio nobody should hear.', 1500), { type: 'speak_end', turnId: 't-int', fullText: 'x' });
  await page.waitForTimeout(800);

  const audio = await speechAudio(page);
  for (const rec of audio) {
    const silencedAt = rec.stoppedAt ?? rec.endedAt;
    expect(silencedAt, `source ${rec.id} kept playing`).not.toBeNull();
    expect(silencedAt!).toBeLessThan(interruptedAt + 250);
  }
  expect(audio.filter((rec) => rec.calledAt > interruptedAt)).toHaveLength(0);
  await expect(page.locator('#visual-face')).not.toHaveClass(/is-speaking/);
});

test('a new turn cuts off the one still playing', async ({ page, request }) => {
  await send(request, { type: 'turn_start', turnId: 't-old' }, chunk('t-old', 0, 'Old reply that runs long.', 3000));
  await expect.poll(async () => (await speechAudio(page)).length).toBe(1);
  await page.waitForTimeout(400);

  const switchedAt = await now(page);
  await send(request,
    { type: 'interrupt', source: 'user' },
    { type: 'turn_start', turnId: 't-new' },
    chunk('t-new', 0, 'New reply.', 800),
    { type: 'speak_end', turnId: 't-new', fullText: 'New reply.' },
  );

  await expect.poll(async () => (await speechAudio(page)).length).toBe(2);
  const [oldReply, newReply] = await speechAudio(page);
  expect(oldReply!.stoppedAt ?? oldReply!.endedAt).not.toBeNull();
  expect((oldReply!.stoppedAt ?? oldReply!.endedAt)!).toBeLessThan(switchedAt + 300);
  expect(newReply!.calledAt).toBeGreaterThan(switchedAt);
  await expect(page.locator('#visual-subtitle')).toContainText('New reply');
});

test('push-to-talk over Tubs interrupts him and tells the server', async ({ page, request }) => {
  await send(request, { type: 'turn_start', turnId: 't-ptt' }, chunk('t-ptt', 0, 'Talking for a while here.', 3000));
  await expect.poll(async () => (await speechAudio(page)).length).toBe(1);
  await page.waitForTimeout(400);

  const pressedAt = await now(page);
  await page.keyboard.down('Space');
  await page.waitForTimeout(400);
  await page.keyboard.up('Space');

  const [reply] = await speechAudio(page);
  expect(reply!.stoppedAt ?? reply!.endedAt).not.toBeNull();
  expect((reply!.stoppedAt ?? reply!.endedAt)!).toBeLessThan(pressedAt + 300);
  await expect.poll(async () => (await received(request)).ws.some((m) => m.type === 'interrupt')).toBe(true);
});

test('a plain speak line is voiced through the TTS stream', async ({ page, request }) => {
  await send(request, { type: 'speak', text: 'Hello from the speaker test.', turnId: 't-speak', ts: Date.now() });

  await expect.poll(async () => (await received(request)).ws.find((m) => m.type === 'tts_request')?.text).toBe('Hello from the speaker test.');
  await expect.poll(async () => (await speechAudio(page)).length).toBe(1);
  await expect(page.locator('#visual-subtitle')).toContainText('speaker test');
  await expect(page.locator('#visual-face')).not.toHaveClass(/is-speaking/, { timeout: 5000 });
});

// Subtitles used to show a sentence the moment its audio arrived (TTS runs
// ahead of playback) and only its last 36 characters, typed out at a fixed
// speed. Now each sentence starts with its audio and pages through.
test('subtitles follow the audio sentence by sentence and page through long ones', async ({ page, request }) => {
  const long = 'This second sentence is long enough that it needs two pages of subtitles to show.';
  await send(request,
    { type: 'turn_start', turnId: 't-sub' },
    chunk('t-sub', 0, 'First line.', 1000),
    chunk('t-sub', 1, long, 2400),
    { type: 'speak_end', turnId: 't-sub', fullText: `First line. ${long}` },
  );
  const subtitle = page.locator('#visual-subtitle');
  await expect(subtitle).toContainText('First line.');
  expect(await subtitle.textContent()).not.toContain('second');

  // Sentence two begins with its first page, not its last.
  await expect(subtitle).toContainText('This second sentence', { timeout: 2000 });
  expect(await subtitle.textContent()).not.toContain('to show.');
  await expect(subtitle).toContainText('to show.', { timeout: 3000 });
});

// Ming streams a whole reply as it renders: several chunks of the same text,
// all but the last flagged `more`, cut wherever the audio was ready, often
// mid-word. They must join without a gap, each played sample for sample as
// sent (resampled one by one, every cut rang and clicked), under one subtitle
// that pages through the reply once: restarted per chunk, it raced through
// the whole reply during the first chunk and then started over.
test('a reply streamed in several chunks plays seamlessly under one subtitle', async ({ page, request }) => {
  const text = 'This reply arrives in three chunks and it needs three pages of subtitles before it ends.';
  await page.evaluate(() => {
    const el = document.querySelector('#visual-subtitle')!;
    const log: Array<{ t: number; text: string }> = [];
    (window as unknown as { __subs: typeof log }).__subs = log;
    new MutationObserver(() => {
      const shown = el.textContent?.trim() ?? '';
      if (shown && shown !== log.at(-1)?.text) log.push({ t: performance.now(), text: shown });
    }).observe(el, { childList: true, subtree: true, characterData: true });
  });

  await send(request, { type: 'turn_start', turnId: 't-ming' }, { ...chunk('t-ming', 0, text, 700), more: true });
  // The rest renders while the first chunk plays.
  await page.waitForTimeout(250);
  await send(request, { ...chunk('t-ming', 1, text, 700), more: true });
  await page.waitForTimeout(250);
  await send(request, chunk('t-ming', 2, text, 1400), { type: 'speak_end', turnId: 't-ming', fullText: text });

  await expect.poll(async () => (await speechAudio(page)).length).toBe(3);
  const audio = await speechAudio(page);
  expect(audio.map((rec) => rec.frames)).toEqual([16_800, 16_800, 33_600]); // 24 kHz, as sent
  for (let i = 1; i < audio.length; i += 1) {
    expect(audio[i]!.startAt).toBeCloseTo(audio[i - 1]!.startAt + audio[i - 1]!.duration, 6);
  }
  await expect(page.locator('#visual-face')).not.toHaveClass(/is-speaking/, { timeout: 6000 });

  const subs = await page.evaluate(() => (window as unknown as { __subs: Array<{ t: number; text: string }> }).__subs);
  const pages = subs.map((entry) => entry.text);
  expect(pages[0]).toMatch(/^This reply/);
  expect(pages.at(-1)).toMatch(/before it ends\.$/);
  expect(new Set(pages).size).toBe(pages.length); // never back to an earlier page
  // The last page comes with the last chunk's audio, not during the first chunk.
  const lastPageAt = (subs.at(-1)!.t - audio[0]!.calledAt) / 1000;
  expect(lastPageAt).toBeGreaterThan(1.4);
  expect(lastPageAt).toBeLessThan(2.8);
});

// A new turn (Manual Beats while Tubs talks) stops the old one. The stop used
// to be written inside a state update that then overwrote it, leaving the
// face "speaking" and the hands-free mic deaf.
test('a new turn stops the one still playing and leaves the face idle', async ({ page, request }) => {
  await send(request, { type: 'turn_start', turnId: 't-old' }, chunk('t-old', 0, 'A long line that keeps going.', 4000));
  const face = page.locator('#visual-face');
  await expect(face).toHaveClass(/is-speaking/);

  await send(request, { type: 'turn_start', turnId: 't-new' });
  await expect(face).not.toHaveClass(/is-speaking/, { timeout: 1500 });
});
