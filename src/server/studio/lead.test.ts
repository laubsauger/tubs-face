import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetStudioContext, noteStudioContext, studioContextLines } from './context.js';
import { leadOf, noteReplyLead, setLeadSink } from './lead.js';

// Seen live: asked to move on, Small said "Follow the flag to the book wall!" and nothing moved: the
// director still held the floor open. The heads' decision to lead on reaches the director.
describe('the heads lead the gallery tour on', () => {
  afterEach(() => { setLeadSink(null); forgetStudioContext(); vi.restoreAllMocks(); });

  const tour = (step: string) => noteStudioContext({ reason: 'change', heads: {}, people: [], reference: null, ts: 1, tour: { where: 'Gold Frame', step, stop: 1, of: 6, next: 'Book' } }, 1000);

  it('reads "lead": "next" from a reply, and nothing else', () => {
    expect(leadOf('{"beats":[{"actor":"main","action":"speak","text":"Follow the flag!"}],"lead":"next"}')).toBe('next');
    expect(leadOf('```json\n{"lead": "next", "beats": []}\n```')).toBe('next');
    expect(leadOf('{"beats":[{"actor":"main","action":"speak","text":"Follow the flag!"}]}')).toBeNull();
    expect(leadOf('{"beats":[],"lead":"back"}')).toBeNull();
    expect(leadOf('not json "lead": "next" at all')).toBe('next');
  });

  it('tells the director only while the tour runs', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent: number[] = [];
    setLeadSink(() => sent.push(1));
    const reply = '{"beats":[{"actor":"small","action":"speak","text":"Follow the flag to the Book!"}],"lead":"next"}';
    expect(noteReplyLead(reply, 1000)).toBe(false);   // no tour
    tour('floor');
    expect(noteReplyLead(reply, 1500)).toBe(true);
    expect(noteReplyLead('{"beats":[]}', 1600)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('drops a line of the stop they left that still waits for quiet', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { present } = await import('./present.js');
    tour('floor');
    let failed = '';
    void present({ kind: 'floor', where: 'Gold Frame', stop: 1, of: 6, first: false, next: 'Book', piece: { title: 'Boy' } }, { broadcast: () => {}, noteAwake: () => {}, startProactiveTurn: () => {}, busy: () => true }).catch((e: Error) => { failed = e.message; });
    noteReplyLead('{"beats":[],"lead":"next"}', 1500);
    await Promise.resolve();
    expect(failed).toBe('the heads led on');
  });

  it('every reply on the tour hears it decides when the group moves on, and how', () => {
    tour('floor');
    const text = studioContextLines(1500).join('\n');
    expect(text).toContain('You decide when the group moves on');
    expect(text).toContain('add "lead": "next" to your reply object');
    expect(text).not.toContain('brings up the first picture');
    tour('gather');
    expect(studioContextLines(1500).join('\n')).toContain('while the group gathers, it brings up the first picture');
  });
});
