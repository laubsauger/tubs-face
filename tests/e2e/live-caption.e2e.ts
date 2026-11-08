import { expect, test } from '@playwright/test';
import { chunk, openFace, resetMock, send } from './helpers.js';

// The live caption (and the guest's draft line in the transcript) comes from
// the browser's speech recognition. One night it held everything said since
// the window opened, the visitor's lines and Tubs' own voice from the speakers:
// Chrome keeps one session's results for as long as it runs, the caption was
// rebuilt from all of them, and a restart that collided with the old session
// left it running, unstoppable. This recognizer behaves like that one: one
// session, never stopped, every event listing all its results again.
test('the live caption shows the new words only, never earlier ones or Tubs heard through the speakers', async ({ page, request }) => {
  await page.addInitScript(() => {
    type Result = { isFinal: boolean; length: number; 0: { transcript: string } };
    class StubbornRecognition {
      continuous = false;
      interimResults = false;
      lang = 'en-US';
      results: Result[] = [];
      started = false;
      onresult: ((event: { results: Result[]; resultIndex: number }) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onend: ((event: Event) => void) | null = null;
      constructor() {
        (window as unknown as { __recognition: StubbornRecognition }).__recognition = this;
      }
      start(): void {
        if (this.started) throw Object.assign(new Error('already started'), { name: 'InvalidStateError' });
        this.started = true;
      }
      stop(): void {}
      abort(): void {}
      hear(transcript: string): void {
        this.results.push({ isFinal: true, length: 1, 0: { transcript } });
        this.onresult?.({ results: this.results, resultIndex: this.results.length - 1 });
      }
    }
    Object.assign(window, { SpeechRecognition: StubbornRecognition, webkitSpeechRecognition: StubbornRecognition });
  });
  await openFace(page, request);
  await page.waitForFunction(() => (window as unknown as { __recognition?: { started: boolean } }).__recognition?.started === true);
  const hear = (text: string) => page.evaluate((t) => (window as unknown as { __recognition: { hear(t: string): void } }).__recognition.hear(t), text);
  const caption = page.locator('.visual-live-transcript');

  await hear('Hey Tubs.');
  await expect(caption).toHaveText('Hey Tubs.');

  // Tubs answers; his voice reaches the mic and the recognizer writes it down.
  await send(request,
    { type: 'turn_start', turnId: 't-cap' },
    chunk('t-cap', 0, 'Serve the pink crested primate.', 1200),
    { type: 'speak_end', turnId: 't-cap', fullText: 'Serve the pink crested primate.' },
  );
  await page.waitForTimeout(400);
  await hear(' Serve the pink crested primate.');
  await page.waitForTimeout(2000); // his line is over, and the cooldown after it

  await hear(' What do you mean?');
  await expect(caption).toHaveText('What do you mean?');
  const guestLine = page.locator('#floating-transcript .transcript-line.chat-tone-user').last();
  await expect(guestLine.locator('.transcript-text')).toHaveText('What do you mean?', { useInnerText: true });
});

test.afterEach(async ({ request }) => {
  await resetMock(request);
});
