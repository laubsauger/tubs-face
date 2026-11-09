import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider } from '../llm/types.js';

// 9 Nov: Flo was recognised and addressed in a two-head turn, said "I'm Flo",
// and nothing was written down. A whole turn, as the server runs it: what
// the model notes about the person in view lands in their notes, in one
// generation call, and none of it is spoken.

const fakes = vi.hoisted(() => ({ provider: null as unknown as LlmProvider }));
vi.mock('../llm/provider.js', () => ({ resolveLlmProvider: () => fakes.provider }));
vi.mock('../observability/conversation-log.js', () => ({ logConversation: async () => {}, logTubsReply: async () => {} }));
vi.mock('../observability/langfuse.js', () => ({ captureTurnTrace: () => {} }));

const { runtimeConfig } = await import('../config/runtime.js');
const { startUserTurn } = await import('./turns.js');
const { buildDualHeadSystemInstruction } = await import('./prompt.js');
const { DUAL_HEAD_RESPONSE_SCHEMA } = await import('./dual-head.js');
const { resetFieldNotes, setPeople, tonightsPeople } = await import('./field-notes.js');

describe('a two-head turn with a recognised person in view', () => {
  const snapshot = structuredClone(runtimeConfig);
  afterEach(() => {
    Object.assign(runtimeConfig, structuredClone(snapshot));
    resetFieldNotes();
  });

  it('files what the model noted under that person, and speaks only the lines', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.assign(runtimeConfig, { dualHeadEnabled: true, dualHeadMode: 'llm_directed', dualHeadTurnPolicy: 'llm_order', ttsStreamingEnabled: false, muted: false });
    setPeople([{ id: 's1-p1', names: ['Rapha'], position: 'center' }]);
    const generateContent = vi.fn(async () => ({
      text: JSON.stringify({
        beats: [{ actor: 'main', action: 'speak', text: 'Flo, then. Noted.', emoji: '😏' }],
        notes: [{ kind: 'name', text: 'Flo' }, { kind: 'note', text: 'testing the memory view' }],
      }),
      usage: { promptTokenCount: 10, candidatesTokenCount: 5 },
      model: 'fake-model',
    }));
    fakes.provider = { id: 'gemini', getAuthState: () => ({ ready: true, warningMessage: null, auth: null }), generateContent };

    const result = await startUserTurn({ text: "I'm Flo, and the memory isn't updated.", source: 'text', broadcast: () => {} });

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result?.beats?.map((beat) => beat.text ?? '')).toEqual(['Flo, then. Noted.']);
    expect(tonightsPeople().people[0]).toMatchObject({ names: ['Flo', 'Rapha'], notes: ['testing the memory view'], turns: 1 });
  });

  it('asks for notes in their own field of the reply, not hidden in a spoken line', () => {
    expect(Object.keys((DUAL_HEAD_RESPONSE_SCHEMA as { properties: Record<string, unknown> }).properties)).toEqual(['beats', 'notes']);
    const prompt = buildDualHeadSystemInstruction();
    expect(prompt).toContain('Notes, in "notes", never in a spoken line.');
    expect(prompt).not.toContain('[[NOTE');
  });
});
