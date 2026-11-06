import { beforeAll, describe, expect, it } from 'vitest';
import type { WsServerMessage } from '../../shared/contracts/ws.js';

// Minimal browser surface the handler touches (timers and window events).
beforeAll(() => {
  Object.assign(globalThis, {
    window: Object.assign(globalThis, { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} }),
  });
});

const { createAppStore } = await import('../state/app-state.js');
const { applyServerMessage } = await import('./messages.js');

// A streamed reply arrives one sentence per audio chunk, then speak_end. The
// chat log used to keep only the last chunk, so two-sentence replies lost their
// first sentence.
describe('chat log for streamed replies', () => {
  it('keeps every sentence of a multi-sentence reply', () => {
    const store = createAppStore();
    const send = (message: WsServerMessage) => applyServerMessage(store, message, 'main');

    send({ type: 'turn_start', turnId: 't1' });
    send({ type: 'audio_chunk', audio: '', text: 'Nice hat.', turnId: 't1', chunkIndex: 0 });
    send({ type: 'audio_chunk', audio: '', text: 'Did it come with instructions?', turnId: 't1', chunkIndex: 1 });

    const draft = store.getState().chatEntries.find((entry) => entry.type === 'out' && entry.draft);
    expect(draft?.text).toBe('Nice hat. Did it come with instructions?');

    send({ type: 'speak_end', turnId: 't1', fullText: 'Nice hat. Did it come with instructions?' });

    const replies = store.getState().chatEntries.filter((entry) => entry.type === 'out');
    expect(replies.map((entry) => [entry.text, Boolean(entry.draft)])).toEqual([
      ['Nice hat. Did it come with instructions?', false],
    ]);
  });
});

// The filler ("Um, okay.") plays before the reply. The transcript should keep
// it, marked as a filler so it isn't mistaken for what the model said, and the
// reply must still come through whole after it.
describe('chat log with a filler', () => {
  it('keeps the filler as its own marked entry and the full reply after it', () => {
    const store = createAppStore();
    const send = (message: WsServerMessage) => applyServerMessage(store, message, 'main');

    send({ type: 'turn_start', turnId: 't2' });
    send({ type: 'audio_chunk', audio: '', text: 'Um, okay.', turnId: 't2', filler: true });
    send({ type: 'audio_chunk', audio: '', text: 'Nice hat.', turnId: 't2', chunkIndex: 0 });
    send({ type: 'audio_chunk', audio: '', text: 'Did it come with instructions?', turnId: 't2', chunkIndex: 1 });

    // While it streams, too: the filler must not be mistaken for the first sentence.
    const draft = store.getState().chatEntries.find((entry) => entry.type === 'out' && entry.draft);
    expect(draft?.text).toBe('Nice hat. Did it come with instructions?');

    send({ type: 'speak_end', turnId: 't2', fullText: 'Nice hat. Did it come with instructions?' });

    const replies = store.getState().chatEntries.filter((entry) => entry.type === 'out');
    expect(replies.map((entry) => [entry.text, Boolean(entry.filler), Boolean(entry.draft)])).toEqual([
      ['Um, okay.', true, false],
      ['Nice hat. Did it come with instructions?', false, false],
    ]);
  });

  // With two heads the transcript is built from the beats; the filler has no
  // beat, so without its own entry it would play but never show up.
  it('keeps the filler with two heads too, before the beats', () => {
    const store = createAppStore();
    store.setState((current) => ({ ...current, config: { ...current.config, dualHeadEnabled: true, dualHeadMode: 'llm_directed' } as typeof current.config }));
    const send = (message: WsServerMessage) => applyServerMessage(store, message, 'main');

    send({ type: 'turn_start', turnId: 't3' });
    send({ type: 'audio_chunk', audio: '', text: 'Hmm.', turnId: 't3', actor: 'main', filler: true });
    send({ type: 'speak_end', turnId: 't3', actor: 'main', text: 'Hmm.' });
    send({ type: 'turn_script', turnId: 't3', beats: [{ actor: 'small', action: 'speak', text: 'Nice hat.' }], ts: 1 });
    send({ type: 'audio_chunk', audio: '', text: 'Nice hat.', turnId: 't3', actor: 'small', beatIndex: 0 });

    const replies = store.getState().chatEntries.filter((entry) => entry.type === 'out');
    expect(replies.map((entry) => [entry.actor, entry.text, Boolean(entry.filler)])).toEqual([
      ['main', 'Hmm.', true],
      ['small', 'Nice hat.', false],
    ]);
  });
});
