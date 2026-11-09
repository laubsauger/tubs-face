import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// The studio's mediamtx lets the face pages publish only with a login (user
// `tubs`). The password lives in a local file: the face pages get the header
// they need, and it shows up nowhere else: not in GET /studio, /config, the
// log, or what other pages receive.

const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-site-auth-'));
const SECRET = 'pa55-not-for-logs';
const loginFile = path.join(dir, 'site-login.json');
writeFileSync(loginFile, JSON.stringify({ user: 'tubs', pass: SECRET }));
const header = `Basic ${Buffer.from(`tubs:${SECRET}`).toString('base64')}`;

describe('reading the login file', () => {
  it('takes JSON, user:pass or two lines, and says what is wrong without the secret', async () => {
    const { loginHeader } = await import('./site-auth.js');
    const at = (name: string, content: string) => {
      const file = path.join(dir, name);
      writeFileSync(file, content);
      process.env.TUBS_STUDIO_SITE_AUTH = file;
      return loginHeader('TUBS_STUDIO_SITE_AUTH');
    };
    expect(at('a.json', JSON.stringify({ username: 'tubs', password: SECRET }))).toEqual({ header });
    expect(at('b.txt', `tubs:${SECRET}\n`)).toEqual({ header });
    expect(at('c.txt', `tubs\n${SECRET}\n`)).toEqual({ header });
    const broken = at('d.txt', 'just one word');
    expect(broken).toMatchObject({ problem: expect.stringContaining('holds no user and password') });
    process.env.TUBS_STUDIO_SITE_AUTH = path.join(dir, 'missing.json');
    expect(loginHeader('TUBS_STUDIO_SITE_AUTH')).toMatchObject({ problem: expect.stringContaining('is missing') });
    delete process.env.TUBS_STUDIO_SITE_AUTH;
    expect(loginHeader('TUBS_STUDIO_SITE_AUTH')).toBeNull();
  });
});

describe('the login on the wire', () => {
  let server: http.Server;
  let base = '';
  const logged: string[] = [];

  beforeAll(async () => {
    process.env.TUBS_STUDIO_SITE_AUTH = loginFile;
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
    const { handleApiRequest } = await import('../routes/api.js');
    const { initWebSocketServer } = await import('../ws/server.js');
    server = http.createServer((request, response) => void handleApiRequest(request, response));
    initWebSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    delete process.env.TUBS_STUDIO_SITE_AUTH;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const firstStudioConfig = async (query: string) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws${query}`);
    const message = await new Promise<Record<string, unknown>>((resolve) => {
      socket.on('message', (raw) => {
        const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
        if (parsed.type === 'studio_config') resolve(parsed);
      });
    });
    socket.close();
    return message;
  };

  it('goes to the studio face pages, and to nobody else', async () => {
    expect((await firstStudioConfig('?studio=main')).siteAuth).toEqual({ publish: header });
    const { studioSettings } = await import('../studio/state.js');
    studioSettings.enabled = true;
    try {
      const other = await firstStudioConfig('');
      expect(other.type).toBe('studio_config');
      expect(other.siteAuth).toBeUndefined();
    } finally {
      studioSettings.enabled = false;
    }
  });

  it('never shows in GET /studio, /config or the log', async () => {
    const encoded = header.slice('Basic '.length);
    for (const route of ['/studio', '/config', '/health']) {
      const body = await (await fetch(`${base}${route}`)).text();
      expect(body, route).not.toContain(SECRET);
      expect(body, route).not.toContain(encoded);
    }
    expect(logged.join('\n')).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(encoded);
  });

  it('a missing login file is an error for each head in GET /studio', async () => {
    process.env.TUBS_STUDIO_SITE_AUTH = path.join(dir, 'gone.json');
    const { studioSettings } = await import('../studio/state.js');
    studioSettings.enabled = true;
    try {
      const studio = (await (await fetch(`${base}/studio`)).json()) as { actors: Array<{ id: string; error?: string }> };
      expect(studio.actors.map((actor) => actor.error)).toEqual([expect.stringContaining('TUBS_STUDIO_SITE_AUTH'), expect.stringContaining('TUBS_STUDIO_SITE_AUTH')]);
    } finally {
      studioSettings.enabled = false;
      process.env.TUBS_STUDIO_SITE_AUTH = loginFile;
    }
  });
});
