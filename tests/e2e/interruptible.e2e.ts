import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { MOCK, chunk, instrumentAudio, now, openFace, received, resetMock, send, speechAudio } from './helpers.js';

// The operator's Interruptible toggle. On (headphones, a quiet room), a
// visitor talking over Tubs cuts him off, hands-free, as push-to-talk does.
// Off (speakers, a crowd), the mic ignores speech while a head talks: with
// speakers it hears Tubs himself, and he would cut himself off.

/** The mic is a tone made in the page (no device opened), silent until the visitor "talks". */
async function fakeVisitor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (constraints) => {
      if (!constraints?.audio || constraints.video) return original(constraints);
      const context = new AudioContext();
      const voice = new GainNode(context, { gain: 0 });
      const tone = new OscillatorNode(context, { frequency: 220 });
      tone.connect(voice);
      tone.start();
      const out = context.createMediaStreamDestination();
      voice.connect(out);
      (window as unknown as { __talk: (on: boolean) => void }).__talk = (on) => voice.gain.setValueAtTime(on ? 0.3 : 0, context.currentTime);
      void context.resume();
      return out.stream;
    };
  });
}

async function tubsTalksThenVisitorTalks(page: Page, request: APIRequestContext, interruptible: boolean): Promise<number> {
  await instrumentAudio(page);
  await fakeVisitor(page);
  await openFace(page, request);
  await request.post(`${MOCK}/config`, { data: { vadModel: 'rms', interruptible } });
  await page.waitForTimeout(300);
  await send(request, { type: 'turn_start', turnId: 't-over' }, chunk('t-over', 0, 'I am going to talk for a good while now.', 3000));
  await expect.poll(async () => (await speechAudio(page)).length).toBe(1);
  await page.waitForTimeout(500);
  await request.post(`${MOCK}/__test/reset-received`);
  const talkedAt = await now(page);
  await page.evaluate(() => (window as unknown as { __talk: (on: boolean) => void }).__talk(true));
  await page.waitForTimeout(900);
  await page.evaluate(() => (window as unknown as { __talk: (on: boolean) => void }).__talk(false));
  return talkedAt;
}

test('with Interruptible on, talking over Tubs cuts him off and tells the server', async ({ page, request }) => {
  const talkedAt = await tubsTalksThenVisitorTalks(page, request, true);
  const [reply] = await speechAudio(page);
  expect(reply!.stoppedAt, 'Tubs stopped').not.toBeNull();
  expect(reply!.stoppedAt!).toBeLessThan(talkedAt + 600);
  await expect.poll(async () => (await received(request)).ws.some((m) => m.type === 'interrupt')).toBe(true);
});

test('with Interruptible off, Tubs talks on and the mic ignores the visitor meanwhile', async ({ page, request }) => {
  await tubsTalksThenVisitorTalks(page, request, false);
  const [reply] = await speechAudio(page);
  expect(reply!.stoppedAt, 'Tubs was not cut off').toBeNull();
  expect((await received(request)).ws.some((m) => m.type === 'interrupt')).toBe(false);
});

// Mini talks in its tile or its own window; the face window only hears that
// Mini started (the server relays each screen's speech state). Talking over
// Mini must cut Mini off too.
test('with Interruptible on, talking over Mini cuts Mini off as well', async ({ page, request }) => {
  await fakeVisitor(page);
  await openFace(page, request);
  await request.post(`${MOCK}/config`, { data: { vadModel: 'rms', interruptible: true } });
  await page.waitForTimeout(300);
  await send(request, { type: 'turn_start', turnId: 't-mini' }, { type: 'head_speech_state', actor: 'small', state: 'start', turnId: 't-mini', ts: Date.now() });
  await page.waitForTimeout(300);
  await request.post(`${MOCK}/__test/reset-received`);
  await page.evaluate(() => (window as unknown as { __talk: (on: boolean) => void }).__talk(true));
  await expect.poll(async () => (await received(request)).ws.some((m) => m.type === 'interrupt'), { timeout: 3000 }).toBe(true);
  await page.evaluate(() => (window as unknown as { __talk: (on: boolean) => void }).__talk(false));
});

test.afterEach(async ({ request }) => {
  await resetMock(request);
});
