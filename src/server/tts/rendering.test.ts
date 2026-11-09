import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

// The face window holds its checks while a voice renders, so Ming always has
// the machine. "Rendering" must start with the text sent to TTS and end with
// its done (not when the socket closes later), over every way a render ends.
const target = vi.hoisted(() => ({ port: 0 }));
vi.mock('../processing/speech-service.js', () => ({
  getTtsProxyTarget: () => ({ hostname: '127.0.0.1', port: target.port, path: '/tts' }),
}));

const { beginRender, isRendering, onRenderingChange } = await import('./rendering.js');
const { openTtsStream } = await import('./stream.js');

let server: WebSocketServer;
beforeAll(async () => {
  server = new WebSocketServer({ port: 0, path: '/tts/stream' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  target.port = (server.address() as { port: number }).port;
  // A speech service that renders one text at a time, 30 ms each.
  server.on('connection', (socket) => {
    let busyUntil = 0;
    socket.on('message', (raw) => {
      const { text } = JSON.parse(String(raw)) as { text: string };
      busyUntil = Math.max(busyUntil, Date.now()) + 30;
      setTimeout(() => {
        socket.send(JSON.stringify({ text, audio: 'UklGRg==', chunk: true }));
        socket.send(JSON.stringify({ text, done: true }));
      }, busyUntil - Date.now());
    });
  });
});
afterAll(() => server.close());

const changes: boolean[] = [];
onRenderingChange((rendering) => changes.push(rendering));

function open() {
  let doneCount = 0;
  const done: Array<() => void> = [];
  const session = openTtsStream({
    onChunk: () => {},
    onSentenceDone: () => {
      doneCount += 1;
      done.shift()?.();
    },
  });
  const nextDone = () => new Promise<void>((resolve) => done.push(resolve));
  return { session, nextDone, get doneCount() { return doneCount; } };
}

describe('rendering', () => {
  it('reports the first render starting and the last one ending, once each', () => {
    changes.length = 0;
    const endA = beginRender();
    const endB = beginRender();
    endA();
    endA();
    expect(isRendering()).toBe(true);
    endB();
    expect(isRendering()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('counts a TTS text from send to done, across texts on one stream', async () => {
    changes.length = 0;
    const tts = open();
    expect(await tts.session.opened).toBe(true);
    expect(isRendering()).toBe(false);
    const first = tts.nextDone();
    const second = tts.nextDone();
    tts.session.send('One.', 'ming:friend');
    tts.session.send('Two.', 'ming:friend');
    expect(isRendering()).toBe(true);
    await first;
    expect(isRendering()).toBe(true);
    await second;
    expect(isRendering()).toBe(false);
    expect(changes).toEqual([true, false]);
    tts.session.close();
  });

  it('ends a render cut short by closing the stream', async () => {
    const tts = open();
    await tts.session.opened;
    tts.session.send('Interrupted.', 'ming:friend');
    expect(isRendering()).toBe(true);
    tts.session.close();
    expect(isRendering()).toBe(false);
  });
});
