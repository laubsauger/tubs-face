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
    const store = createAppStore('test');
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
