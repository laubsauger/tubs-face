import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmGenerateResult, LlmProvider } from '../llm/types.js';

// In the studio Tubs may start a conversation with someone who is not at his
// window. He calls them first ("Hey, you over by the cinema!"), marked as a
// call-out so it plays while his face is still on its way. Someone who just
// spoke to him gets an answer, never a call-out.

const fakes = vi.hoisted(() => ({ provider: null as unknown as LlmProvider }));
vi.mock('../llm/provider.js', () => ({ resolveLlmProvider: () => fakes.provider }));

const { generateDualHeadProactiveReply, generateDualHeadReply } = await import('./dual-head-reply.js');
const { studioSettings } = await import('../studio/state.js');
const { forgetStudioContext, noteStudioContext } = await import('../studio/context.js');

const script = JSON.stringify({ beats: [
  { actor: 'main', action: 'speak', text: 'I have a theory about your shoes.', emotion: { emoji: '😏', expression: 'smug' } },
  { actor: 'small', action: 'speak', text: 'He has a theory about everything.' },
] });

function provider(): { calls: Array<{ systemInstruction: string }> } {
  const calls: Array<{ systemInstruction: string }> = [];
  fakes.provider = {
    name: 'fake',
    getAuthState: () => ({ ready: true, auth: { kind: 'api-key', apiKey: 'x' } }),
    async generateContent(args: { systemInstruction: string }): Promise<LlmGenerateResult> {
      calls.push({ systemInstruction: args.systemInstruction });
      return { text: script, usage: { promptTokenCount: 10, candidatesTokenCount: 10 }, model: 'fake' };
    },
  } as unknown as LlmProvider;
  return { calls };
}

const venue = {
  theme: null,
  phase: null,
  zones: [{ id: 'cin', name: 'cinema', about: '' }, { id: 'pb', name: 'photobooth', about: '' }],
  windows: [{ id: 'book', name: 'Book', zone: 'pb', about: '' }],
};
const room = (relation: 'here' | 'same-room' | 'next-room' | 'far') => ({
  reason: 'turn',
  heads: { main: { zone: 'pb', window: 'book', near: true, mode: 'idle', speaking: false } },
  people: [{ id: 'p1', zone: 'cin', window: null, relation, distance: null, dwell: 30, engaged: false, with: null }],
  reference: { head: 'main', window: 'book' },
  venue,
  ts: 1,
});

afterEach(() => {
  studioSettings.enabled = false;
  forgetStudioContext();
});

describe('call-outs in the studio', () => {
  it('open a conversation Tubs starts with someone far away, marked as a call-out', async () => {
    const { calls } = provider();
    studioSettings.enabled = true;
    noteStudioContext(room('far'));
    const reply = await generateDualHeadProactiveReply('Someone is in the room, not talking.');
    expect(reply!.beats[0]).toMatchObject({ actor: 'main', action: 'speak', callout: true });
    expect(reply!.beats[0]!.text).toMatch(/cinema/);
    expect(reply!.beats.slice(1).some((beat) => beat.callout)).toBe(false);
    // The model knows it has already called them, so it doesn't call twice.
    expect(calls[0]!.systemInstruction).toContain('You have just called out to them');
  });

  it('call someone in the room next door too', async () => {
    provider();
    studioSettings.enabled = true;
    noteStudioContext(room('next-room'));
    const reply = await generateDualHeadProactiveReply('Someone is in the room, not talking.');
    expect(reply!.beats[0]!.callout).toBe(true);
  });

  it('are left out when someone is right in front of the window', async () => {
    provider();
    studioSettings.enabled = true;
    noteStudioContext({ ...room('far'), people: [...room('far').people, { id: 'p2', zone: 'pb', window: 'book', relation: 'here' as const, distance: 1, dwell: 5, engaged: false, with: null }] });
    const reply = await generateDualHeadProactiveReply('Someone is in the room, not talking.');
    expect(reply!.beats.some((beat) => beat.callout)).toBe(false);
  });

  it('never open a reply to someone who just spoke', async () => {
    provider();
    studioSettings.enabled = true;
    noteStudioContext(room('far'));
    const reply = await generateDualHeadReply('What do you think of my shoes?');
    expect(reply.beats.some((beat) => beat.callout)).toBe(false);
  });

  it('do nothing outside studio mode', async () => {
    provider();
    noteStudioContext(room('far'));
    const reply = await generateDualHeadProactiveReply('Someone is in the room, not talking.');
    expect(reply!.beats.some((beat) => beat.callout)).toBe(false);
  });
});
