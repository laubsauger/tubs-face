import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import { PRESENT_WAIT_MAX_MS, parsePresent, present, presentContext, type PresentRequest } from './present.js';

const req: PresentRequest = {
  where: 'Big Wall', stop: 2, of: 5, first: false, next: 'Book',
  piece: {
    title: 'Watts and D.T. Suzuki at a tea table', date: '1951', by: 'Contemporaries of Watts',
    text: 'Two men at a low table with tea bowls.', facts: [['Pictured', 'Alan Watts, D. T. Suzuki']], tags: ['tea', 'zen'],
  },
};

// The gallery tour: the director pulls a picture up and Tubs must tell about that very picture,
// from what the archive knows, where the heads stand, and lead on to the next stop.
describe('studio present (the gallery tour)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('wakes both heads and starts one turn about the picture, at once when the heads are quiet', async () => {
    const sent: WsServerMessage[] = [];
    const turns: string[] = [];
    let awake = false;
    await present(req, { broadcast: (m) => sent.push(m), noteAwake: () => { awake = true; }, startProactiveTurn: (c) => turns.push(c), busy: () => false });
    expect(awake).toBe(true);
    expect(sent).toEqual([{ type: 'wake' }]);
    expect(turns).toEqual([presentContext(req)]);
  });

  // Seen live: visitors talk to Tubs during the tour; a proactive line is dropped while a reply is being
  // made, so the picture came up and nobody said anything about it. It waits for the reply instead.
  it('waits while a reply is made or a head talks, then starts; the director hears when it started', async () => {
    vi.useFakeTimers();
    let busy = true;
    const turns: string[] = [];
    let started = false;
    const p = present(req, { broadcast: () => {}, noteAwake: () => {}, startProactiveTurn: (c) => turns.push(c), busy: () => busy }).then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(8000);
    expect(turns).toEqual([]);
    expect(started).toBe(false);
    busy = false;
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(turns).toEqual([presentContext(req)]);
    expect(started).toBe(true);
  });

  it('gives up when the heads stay busy too long, and a newer picture replaces one still waiting', async () => {
    vi.useFakeTimers();
    const turns: string[] = [];
    const deps = { broadcast: () => {}, noteAwake: () => {}, startProactiveTurn: (c: string) => turns.push(c), busy: () => true };
    const old = present(req, deps);
    const replaced = expect(old).rejects.toThrow('newer picture');
    const newer = present({ ...req, piece: { title: 'Another' } }, deps);
    await replaced;
    const gaveUp = expect(newer).rejects.toThrow('busy');
    await vi.advanceTimersByTimeAsync(PRESENT_WAIT_MAX_MS + 1000);
    await gaveUp;
    expect(turns).toEqual([]);
  });

  it('tells the turn the picture, what the archive knows, where they are and where they go next', () => {
    const c = presentContext(req);
    expect(c).toContain('no visitor said this');
    expect(c).toContain('"Watts and D.T. Suzuki at a tea table", 1951, from the series "Contemporaries of Watts"');
    expect(c).toContain('Two men at a low table');
    expect(c).toContain('Pictured: Alan Watts, D. T. Suzuki');
    expect(c).toContain('Big Wall (stop 2 of 5)');
    expect(c).toContain('on to the Book');
    // the archive is real: nothing made up
    expect(c).toContain('never invent dates, places or names');
    expect(c).not.toContain('open the tour');
    expect(presentContext({ ...req, first: true })).toContain('open the tour');
    expect(presentContext({ ...req, next: null })).not.toContain('inviting everyone on');
  });

  it('takes only a request with a picture and a place, clipped', () => {
    expect(parsePresent({})).toBe('present needs piece.title');
    expect(parsePresent({ piece: { title: 'x' } })).toBe('present needs where');
    const r = parsePresent({ where: 'Book', piece: { title: 't'.repeat(500), text: 'x'.repeat(2000), facts: [['a', 'b'], 'junk', ['c']], tags: ['a', 3] }, stop: -1, first: 'yes' });
    expect(typeof r).toBe('object');
    const ok = r as PresentRequest;
    expect(ok.piece.title).toHaveLength(120);
    expect(ok.piece.text).toHaveLength(400);
    expect(ok.piece.facts).toEqual([['a', 'b']]);
    expect(ok.piece.tags).toEqual(['a']);
    expect(ok.stop).toBe(1);
    expect(ok.first).toBe(false);
    expect(ok.next).toBeNull();
  });
});
