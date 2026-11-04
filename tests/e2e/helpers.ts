import type { APIRequestContext, Page } from '@playwright/test';

export const MOCK = 'http://127.0.0.1:39010';

export interface AudioRecord {
  id: number;
  duration: number;
  /** Sample frames in the buffer, and the rate of the context it plays in. */
  frames: number;
  contextRate: number;
  /** AudioContext time the source was scheduled to start. */
  startAt: number;
  /** performance.now() when start() was called, and when it stopped or ended. */
  calledAt: number;
  stoppedAt: number | null;
  endedAt: number | null;
}

/**
 * Records every AudioBufferSourceNode the page starts, so a test can see what
 * actually played and when it stopped. Installed before the app's scripts.
 */
export async function instrumentAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: AudioRecord[] = [];
    (window as unknown as { __audio: AudioRecord[] }).__audio = log;
    const proto = AudioBufferSourceNode.prototype;
    const originalStart = proto.start;
    const originalStop = proto.stop;
    let nextId = 0;
    proto.start = function start(this: AudioBufferSourceNode & { __rec?: AudioRecord }, when = 0, ...rest: number[]) {
      const ctx = this.context as AudioContext;
      const rec: AudioRecord = {
        id: nextId++,
        duration: this.buffer?.duration ?? 0,
        frames: this.buffer?.length ?? 0,
        contextRate: ctx.sampleRate,
        startAt: when || ctx.currentTime,
        calledAt: performance.now(),
        stoppedAt: null,
        endedAt: null,
      };
      if (!this.loop) log.push(rec);
      this.__rec = rec;
      this.addEventListener('ended', () => {
        rec.endedAt ??= performance.now();
      });
      return originalStart.call(this, when, ...rest);
    };
    proto.stop = function stop(this: AudioBufferSourceNode & { __rec?: AudioRecord }, ...args: number[]) {
      if (this.__rec) this.__rec.stoppedAt ??= performance.now();
      return originalStop.apply(this, args);
    };
  });
}

/** Speech chunks only: the unlock blip and other tiny buffers are ignored. */
export async function speechAudio(page: Page): Promise<AudioRecord[]> {
  return page.evaluate(() => (window as unknown as { __audio: AudioRecord[] }).__audio.filter((rec) => rec.duration >= 0.3));
}

export async function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

export async function resetMock(request: APIRequestContext): Promise<void> {
  await request.post(`${MOCK}/__test/reset`);
}

export async function send(request: APIRequestContext, ...messages: unknown[]): Promise<void> {
  await request.post(`${MOCK}/__test/send`, { data: messages });
}

export async function received(request: APIRequestContext): Promise<{ ws: Array<Record<string, unknown>>; http: Array<{ method: string; path: string; body: unknown }> }> {
  return (await request.get(`${MOCK}/__test/received`)).json();
}

/** Opens the main face and waits until its WebSocket is connected to the mock. */
export async function openFace(page: Page, request: APIRequestContext): Promise<void> {
  await resetMock(request);
  await page.goto('/');
  for (let i = 0; i < 100; i += 1) {
    const { clients } = await (await request.get(`${MOCK}/__test/clients`)).json() as { clients: number };
    if (clients > 0) break;
    await page.waitForTimeout(100);
  }
  await page.locator('#visual-face').waitFor();
  await resetMock(request);
}

/** A mono 24 kHz tone, base64 WAV, shaped like a Kokoro audio chunk. */
export function tone(durationMs: number): string {
  const rate = 24_000;
  const samples = Math.round((rate * durationMs) / 1000);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), 44 + i * 2);
  }
  return buffer.toString('base64');
}

export const chunk = (turnId: string, chunkIndex: number, text: string, ms: number) => ({
  type: 'audio_chunk', audio: tone(ms), text, turnId, chunkIndex,
});
