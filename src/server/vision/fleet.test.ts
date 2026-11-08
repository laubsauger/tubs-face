import { describe, expect, it } from 'vitest';
import { FLEET_REFRESH_MS, createFleetResolver } from './fleet.js';

// VISION_BASE_URL=fleet:vision: the vision model runs on whichever studio box
// the hub ranks first, moves on when that box fails, and survives the hub
// itself going away.

type Handler = (url: string) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return handler(url);
    }) as typeof fetch,
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const providers = [
  { id: 'linux-monster/vision', serverBase: 'http://linux-monster:11434' },
  { id: 'eeg-msi/vision', serverBase: 'http://eeg-msi:11434' },
];

describe('fleet:vision', () => {
  it('takes the provider the hub ranks first', async () => {
    const { fetch } = fakeFetch(() => json({ providers }));
    const fleet = createFleetResolver({ hub: 'http://hub:4310', fetch, log: () => {} });
    expect(await fleet.resolve()).toBe('http://linux-monster:11434/v1');
  });

  it('asks the hub for healthy vision providers only', async () => {
    const { fetch, calls } = fakeFetch(() => json({ providers }));
    await createFleetResolver({ hub: 'http://hub:4310/', fetch, log: () => {} }).resolve();
    expect(calls[0]).toBe('http://hub:4310/api/fleet/providers?kind=vision&healthy=1');
  });

  it('moves to the next one when a call fails', async () => {
    const { fetch } = fakeFetch(() => json({ providers }));
    const fleet = createFleetResolver({ hub: 'http://hub:4310', fetch, log: () => {} });
    const first = await fleet.resolve();
    fleet.fail(first!);
    expect(await fleet.resolve()).toBe('http://eeg-msi:11434/v1');
  });

  it('keeps the last good URL while the hub is down', async () => {
    let hubUp = true;
    let now = 0;
    const { fetch } = fakeFetch(() => {
      if (!hubUp) throw new TypeError('fetch failed');
      return json({ providers });
    });
    const fleet = createFleetResolver({ hub: 'http://hub:4310', fetch, now: () => now, log: () => {} });
    expect(await fleet.resolve()).toBe('http://linux-monster:11434/v1');
    hubUp = false;
    now += FLEET_REFRESH_MS + 1;
    expect(await fleet.resolve()).toBe('http://linux-monster:11434/v1');
  });

  it('prefers a studio-LAN address that answers from here', async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.startsWith('http://hub')) return json({ providers: [{ id: 'a', serverBase: 'https://a.ts.net:11434', lanBases: ['http://10.0.0.9:11434', 'http://192.168.1.5:11434'] }] });
      if (url.startsWith('http://10.0.0.9')) throw new TypeError('unreachable');
      return new Response('not found', { status: 404 });
    });
    const fleet = createFleetResolver({ hub: 'http://hub:4310', fetch, log: () => {} });
    expect(await fleet.resolve()).toBe('http://192.168.1.5:11434/v1');
  });

  it('asks the hub again every 5 minutes', async () => {
    let now = 0;
    let ranked = providers;
    const { fetch } = fakeFetch(() => json({ providers: ranked }));
    const fleet = createFleetResolver({ hub: 'http://hub:4310', fetch, now: () => now, log: () => {} });
    expect(await fleet.resolve()).toBe('http://linux-monster:11434/v1');
    ranked = [providers[1]!, providers[0]!];
    now += 60_000;
    expect(await fleet.resolve()).toBe('http://linux-monster:11434/v1');
    now += FLEET_REFRESH_MS;
    expect(await fleet.resolve()).toBe('http://eeg-msi:11434/v1');
  });
});
