import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { initWebSocketServer } from './server.js';
import { resetStudioReports, studioSettings, toStudioResponse } from '../studio/state.js';
import { forgetStudioContext, studioContextLines } from '../studio/context.js';

// The director talks to tubs-face over the same /ws as every page. Its
// messages must only ever reach the studio face pages, and only while studio
// mode is on; with it off the normal app sees nothing new. What the pages
// report goes to everyone (the director listens like any client).

let server: http.Server;
let port = 0;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  server = http.createServer();
  initWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  studioSettings.enabled = false;
  resetStudioReports();
  forgetStudioContext();
});

interface Client {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  send(message: unknown): void;
  types(): string[];
}

async function connect(query = ''): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  sockets.push(socket);
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    messages,
    send: (message) => socket.send(JSON.stringify(message)),
    types: () => messages.map((message) => String(message.type)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
const studioTypes = (client: Client) => client.types().filter((type) => type.startsWith('studio_'));
const look = { type: 'studio_look', actor: 'main', gaze: [0.4, 0.1] };
const presence = { type: 'studio_presence', actor: 'small', present: true, people: 2 };
const state = { type: 'studio_state', actor: 'main', speaking: true, expr: 'happy', mood: { pos: 0.6, neg: 0, arousal: 0.4 }, ts: 1 };

describe('studio messages on /ws', () => {
  it('change nothing while studio mode is off: no relay, nothing new for the normal pages', async () => {
    const director = await connect();
    const operator = await connect();
    const page = await connect('?studio=main');
    director.send(look);
    director.send(presence);
    page.send(state);
    await settle();
    expect(studioTypes(operator)).toEqual([]);
    expect(studioTypes(director)).toEqual([]);
    // The face page only learns that studio mode is off.
    expect(page.messages.filter((m) => String(m.type).startsWith('studio_'))).toEqual([
      expect.objectContaining({ type: 'studio_config', enabled: false }),
    ]);
  });

  it('pass the director\'s look and presence to the face pages only, while studio mode is on', async () => {
    studioSettings.enabled = true;
    const director = await connect();
    const operator = await connect();
    const main = await connect('?studio=main');
    const small = await connect('?studio=small');
    director.send(look);
    director.send(presence);
    await settle();
    for (const page of [main, small]) {
      expect(page.messages).toEqual(expect.arrayContaining([
        { type: 'studio_look', actor: 'main', gaze: [0.4, 0.1] },
        { type: 'studio_presence', actor: 'small', present: true, people: 2 },
      ]));
    }
    expect(studioTypes(operator).filter((type) => type !== 'studio_config')).toEqual([]);
    expect(studioTypes(director).filter((type) => type !== 'studio_config')).toEqual([]);
  });

  it('send a face page\'s studio_state to everyone, and only a face page\'s', async () => {
    studioSettings.enabled = true;
    const director = await connect();
    const main = await connect('?studio=main');
    main.send(state);
    director.send({ ...state, expr: 'angry' }); // not a face page: dropped
    await settle();
    expect(director.messages.filter((m) => m.type === 'studio_state')).toEqual([state]);
  });

  it('count a head as publishing only while its page says so and is connected', async () => {
    studioSettings.enabled = true;
    const main = await connect('?studio=main');
    main.send({ type: 'studio_status', actor: 'main', publishing: true, mic: { source: 'site:mic-room', listening: true } });
    await settle();
    expect(toStudioResponse().actors[0]).toEqual({ id: 'main', stream: 'tubs-main', publishing: true });
    expect(toStudioResponse().mic).toEqual({ source: 'site:mic-room', listening: true });
    main.socket.close();
    await settle();
    expect(toStudioResponse().actors[0]).toMatchObject({ publishing: false, error: 'face page not connected' });
  });

  // Captions come from the page that plays the head's voice, on its playback
  // clock. With studio mode off nobody gets one; another page (or the director)
  // can't put words in a head's mouth.
  it('pass a head\'s caption to everyone, only from that head\'s page and only while studio mode is on', async () => {
    const caption = { type: 'studio_caption', actor: 'main', turnId: 't1', text: 'Nice hat.', spoken: 4, done: false, ts: 1 };
    const director = await connect();
    const main = await connect('?studio=main');
    const small = await connect('?studio=small');
    main.send(caption);
    await settle();
    expect(director.types()).not.toContain('studio_caption');

    studioSettings.enabled = true;
    main.send(caption);
    small.send(caption); // small's page speaking for main: dropped
    director.send({ ...caption, text: 'Not said.' });
    await settle();
    expect(director.messages.filter((m) => m.type === 'studio_caption')).toEqual([caption]);
    expect(small.messages.filter((m) => m.type === 'studio_caption')).toEqual([caption]);
  });

  it('take the director\'s studio_context only while studio mode is on, and only from the director', async () => {
    const context = {
      type: 'studio_context', reason: 'turn',
      heads: { main: { zone: 'cinema', window: 'book', near: true, mode: 'engaged', speaking: false } },
      people: [{ id: 'p1', zone: 'cinema', window: 'book', relation: 'here', distance: 1, dwell: 30, engaged: true, with: 'main' }],
      reference: { head: 'main', window: 'book' }, ts: 1,
    };
    const director = await connect();
    const page = await connect('?studio=main');
    director.send(context);
    await settle();
    expect(studioContextLines().join(' ')).not.toContain('behind the book');

    studioSettings.enabled = true;
    page.send({ ...context, heads: { main: { ...context.heads.main, window: 'mirror' } } });
    await settle();
    expect(studioContextLines().join(' ')).not.toContain('mirror');
    director.send(context);
    await settle();
    expect(studioContextLines().join(' ')).toContain('You are behind the book, next to the cinema.');
  });

  it('do not let one head\'s page report for the other', async () => {
    studioSettings.enabled = true;
    const main = await connect('?studio=main');
    main.send({ type: 'studio_status', actor: 'small', publishing: true });
    await settle();
    expect(toStudioResponse().actors[1]).toMatchObject({ id: 'small', publishing: false });
  });
});
