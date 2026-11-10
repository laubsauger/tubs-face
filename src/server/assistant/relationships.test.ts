import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// The boss gets playful respect while he is in front of Tubs, and only then:
// the line must go the moment he is not, never outlive the visit (not in the
// history, not in field notes, not after a restart), and never break a turn,
// whatever state the file is in.

const ATTITUDE = 'He is the boss. Be warm and nice to him (playful respect, never grovelling); still yourself.';
const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-relationships-'));
const file = path.join(dir, 'relationships.json');
process.env.TUBS_CONFIG_DIR = dir;
writeFileSync(file, JSON.stringify([{ name: 'Flo', attitude: ATTITUDE }]));

const { runtimeConfig } = await import('../config/runtime.js');
const { RELATIONSHIP_GRACE_MS, forgetRecognised, noteRecognised, relationshipLines } = await import('./relationships.js');
const { buildContents, buildProactiveContents, forgetConversation, pushHistory } = await import('./context.js');
const { fieldNotesSnapshot } = await import('./field-notes.js');

const flo = { names: ['Flo'], position: 'center' as const };
/** What the model gets with this turn's message (not the history before it). */
const thisTurn = (text = 'How do I look?') => JSON.stringify(buildContents(text).contents.at(-1));
const stranger = { names: [], position: 'right' as const };

beforeEach(() => {
  writeFileSync(file, JSON.stringify([{ name: 'Flo', attitude: ATTITUDE }]));
  runtimeConfig.relationshipsEnabled = true;
  forgetRecognised();
  forgetConversation();
});
afterEach(() => vi.restoreAllMocks());

describe('relationships', () => {
  it('give Flo his line with the turn while he is in view, for a reply or a turn Tubs starts', () => {
    noteRecognised([flo]);
    expect(thisTurn()).toContain(`Flo is in front of you. ${ATTITUDE}`);
    expect(JSON.stringify(buildProactiveContents('Person detected').contents.at(-1))).toContain(ATTITUDE);
  });

  it('drop the line as soon as the people in view no longer include him', () => {
    noteRecognised([flo]);
    noteRecognised([stranger]);
    expect(thisTurn()).not.toContain('the boss');
  });

  it('drop it when recognition has not seen him for the grace period (camera stopped or stale)', () => {
    noteRecognised([flo], 0);
    expect(relationshipLines(true, RELATIONSHIP_GRACE_MS - 1)).toHaveLength(1);
    expect(relationshipLines(true, RELATIONSHIP_GRACE_MS + 1)).toEqual([]);
    expect(RELATIONSHIP_GRACE_MS).toBe(10_000);
  });

  it('say which one he is when several people are in view', () => {
    noteRecognised([{ names: ['Flo'], position: 'left' }, stranger]);
    expect(relationshipLines(true)).toEqual([`Flo is in front of you (the one on the left). ${ATTITUDE}`]);
  });

  it('give nothing to a name without an entry', () => {
    noteRecognised([{ names: ['Dimi'], position: 'center' }]);
    expect(relationshipLines(true)).toEqual([]);
  });

  it('give nothing with the toggle off', () => {
    runtimeConfig.relationshipsEnabled = false;
    noteRecognised([flo]);
    expect(thisTurn()).not.toContain('the boss');
  });

  it('never leak into the history or the field notes', () => {
    noteRecognised([flo]);
    expect(thisTurn('Hi Tubs')).toContain('the boss');
    // The turn as a reply stores it: the visitor's words and the reply, nothing else.
    pushHistory('user', 'Hi Tubs');
    pushHistory('model', 'Hey boss.');
    const history = buildContents('How are you?').contents.slice(0, -1);
    expect(history).toHaveLength(2);
    expect(JSON.stringify(history)).not.toContain('the boss');
    expect(JSON.stringify(fieldNotesSnapshot())).not.toContain('the boss');
  });

  it('ignore a broken file safely, saying so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(file, '{ not json');
    noteRecognised([flo]);
    expect(() => buildContents('Hi')).not.toThrow();
    expect(relationshipLines(true)).toEqual([]);
    relationshipLines(true);
    expect(warn).toHaveBeenCalledTimes(1);
    writeFileSync(file, JSON.stringify([{ name: 'Flo' }]));
    expect(relationshipLines(true)).toEqual([]);
  });

  it('start clean after a restart', async () => {
    noteRecognised([flo]);
    vi.resetModules();
    const fresh = await import('./relationships.js');
    expect(fresh.relationshipLines(true)).toEqual([]);
  });
});

describe('relationships over the socket', () => {
  it('end when the page that reported him disconnects, or its camera stops', async () => {
    const { initWebSocketServer } = await import('../ws/server.js');
    const { relationshipLines: lines } = await import('./relationships.js');
    const server = http.createServer();
    initWebSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const open = async () => {
      const socket = new WebSocket(url);
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));
      return socket;
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    const people = (list: unknown[]) => JSON.stringify({ type: 'people', people: list });

    const page = await open();
    page.send(people([{ id: 'v1', names: ['Flo'], position: 'center' }]));
    await settle();
    expect(lines(true)).toHaveLength(1);
    page.send(people([]));
    await settle();
    expect(lines(true), 'camera off').toEqual([]);

    page.send(people([{ id: 'v1', names: ['Flo'], position: 'center' }]));
    await settle();
    expect(lines(true)).toHaveLength(1);
    page.close();
    await settle();
    expect(lines(true), 'page gone').toEqual([]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('the shipped relationships', () => {
  it('know the boss out of the box (config/relationships.json, in git)', async () => {
    const { readFileSync } = await import('node:fs');
    const shipped = JSON.parse(readFileSync(path.resolve(process.cwd(), 'config/relationships.json'), 'utf8')) as unknown;
    const { validateRelationships } = await import('./relationships.js');
    // the operator adds people from the Studio tab (Dimi on 10 Nov); the boss stays first and as shipped
    expect(validateRelationships(shipped)[0]).toEqual({ name: 'Flo', attitude: ATTITUDE });
  });
});
