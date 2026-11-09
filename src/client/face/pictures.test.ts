import { describe, expect, it } from 'vitest';
import { createStillPictures, fitWithin } from './pictures.js';

// A picture for vision is cut down to VISION_MAX_PX before it leaves the page
// (local models are faster on small pictures and nothing is sent twice the
// size it needs). A studio camera that does not stream gives one picture per
// request: one fetch (or one short WHEP session) per picture, never more,
// never stacked up, and only while the face detector can look at them.

describe('picture size for vision', () => {
  it('keeps the longest side at VISION_MAX_PX, aspect kept', () => {
    expect(fitWithin(1280, 720, 512)).toEqual({ width: 512, height: 288 });
    expect(fitWithin(480, 640, 512)).toEqual({ width: 384, height: 512 });
  });

  it('never enlarges a small picture', () => {
    expect(fitWithin(320, 240, 512)).toEqual({ width: 320, height: 240 });
  });
});

/** A clock the test moves: setTimer queues, run() fires what is due. */
function manualTimers() {
  let now = 0;
  const queue: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > until) break;
        queue.shift();
        now = next.at;
        next.fn();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      now = until;
    },
  };
}

const picture = () => ({ close() {} }) as unknown as ImageBitmap;

describe('pictures from a camera that does not stream', () => {
  it('takes exactly one picture per interval, each one looked at once', async () => {
    const timers = manualTimers();
    let grabs = 0;
    const looked: ImageBitmap[] = [];
    const still = createStillPictures({
      grab: async () => { grabs += 1; return picture(); },
      ready: () => true,
      onPicture: (p) => { looked.push(p); },
      intervalMs: 2000,
      ...timers,
    });
    await timers.advance(6500);
    expect(grabs).toBe(4); // at 0, 2, 4 and 6 s
    expect(looked).toHaveLength(grabs);
    still.stop();
    await timers.advance(10_000);
    expect(grabs).toBe(4);
  });

  it('does not stack requests behind a slow camera', async () => {
    const timers = manualTimers();
    let inFlight = 0;
    let most = 0;
    let release: (() => void) | null = null;
    const still = createStillPictures({
      grab: () => new Promise<ImageBitmap>((resolve) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        release = () => { inFlight -= 1; resolve(picture()); };
      }),
      ready: () => true,
      onPicture: () => {},
      intervalMs: 100,
      ...timers,
    });
    await timers.advance(1000);
    expect(most).toBe(1);
    release!();
    still.stop();
  });

  it('takes none while the face detector cannot look at them', async () => {
    const timers = manualTimers();
    let ready = false;
    let grabs = 0;
    const still = createStillPictures({ grab: async () => { grabs += 1; return picture(); }, ready: () => ready, onPicture: () => {}, intervalMs: 1000, ...timers });
    await timers.advance(5000);
    expect(grabs).toBe(0);
    ready = true;
    await timers.advance(1000);
    expect(grabs).toBe(1);
    still.stop();
  });
});
