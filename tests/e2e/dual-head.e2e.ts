import { expect, test } from '@playwright/test';
import { MOCK, instrumentAudio, received, resetMock, send, speechAudio, tone } from './helpers.js';

// Two-head mode: the main screen and the mini screen each voice their own head.
// Audio for the other head must never play on the wrong screen.
test('each screen plays only its own head in a two-head turn', async ({ context, request }) => {
  await resetMock(request);
  const main = await context.newPage();
  const mini = await context.newPage();
  await instrumentAudio(main);
  await instrumentAudio(mini);
  await main.goto('/');
  await mini.goto('/app-mini.html');
  for (let i = 0; i < 100; i += 1) {
    const { clients } = await (await request.get(`${MOCK}/__test/clients`)).json() as { clients: number };
    if (clients >= 2) break;
    await main.waitForTimeout(100);
  }
  await request.post(`${MOCK}/config`, { data: { dualHeadEnabled: true, dualHeadMode: 'llm_directed' } });
  await main.waitForTimeout(500);
  // With a mini screen open, the main screen shows no mini tile of its own (it would voice Small too).
  await expect(main.locator('#mini-tile')).toHaveCount(0);

  // Ignore the config post above in what the pages sent.
  await request.post(`${MOCK}/__test/reset-received`);
  const turnId = 't-dual';
  await send(request,
    { type: 'turn_start', turnId },
    {
      type: 'turn_script',
      turnId,
      beats: [
        { actor: 'main', action: 'speak', text: 'Main says this.' },
        { actor: 'small', action: 'speak', text: 'Small says that.' },
      ],
      ts: Date.now(),
    },
    { type: 'audio_chunk', audio: tone(700), text: 'Main says this.', turnId, chunkIndex: 0, actor: 'main', beatIndex: 0 },
    { type: 'speak_end', turnId, actor: 'main', text: 'Main says this.', fullText: 'Main says this.' },
    { type: 'audio_chunk', audio: tone(900), text: 'Small says that.', turnId, chunkIndex: 1, actor: 'small', beatIndex: 1 },
    { type: 'speak_end', turnId, actor: 'small', text: 'Small says that.', fullText: 'Small says that.' },
  );

  await expect.poll(async () => (await speechAudio(main)).map((rec) => Math.round(rec.duration * 10) / 10)).toEqual([0.7]);
  await expect.poll(async () => (await speechAudio(mini)).map((rec) => Math.round(rec.duration * 10) / 10)).toEqual([0.9]);

  // Each screen reports its own head's speech start and end.
  await expect.poll(async () => {
    const states = (await received(request)).ws.filter((m) => m.type === 'head_speech_state' && m.turnId === turnId);
    return states.map((m) => `${m.actor}:${m.state}`).sort();
  }, { timeout: 8000 }).toEqual(['main:end', 'main:start', 'small:end', 'small:start']);
  // In two-head mode the server streams each head; the screens must not ask for TTS themselves.
  expect((await received(request)).ws.filter((m) => m.type === 'tts_request')).toHaveLength(0);
});

test.afterEach(async ({ request }) => {
  await resetMock(request);
});
