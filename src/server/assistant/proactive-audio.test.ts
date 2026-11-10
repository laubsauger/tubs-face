import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WsServerMessage } from '../../shared/contracts/ws.js';

// Seen live: every proactive line (the gallery tour's welcome, picture, floor and "follow the flag",
// greetings, the screening's commentary) was written and never heard. In two-head mode with server
// TTS streaming the face pages do not voice a turn_script themselves (speech-runtime enqueueTurnScript);
// a reply's beats were streamed, a proactive turn's were not. Now they are, and the turn lasts until
// they have played.

const played = vi.hoisted(() => ({ beats: [] as unknown[], resolve: null as null | (() => void) }));
vi.mock('./dual-head.js', async (original) => ({ ...(await original<typeof import('./dual-head.js')>()), shouldUseDualHeadDirectedMode: () => true }));
vi.mock('./dual-head-reply.js', () => ({
  generateDualHeadReply: vi.fn(),
  generateDualHeadProactiveReply: vi.fn(async () => ({
    beats: [{ actor: 'main', action: 'speak', text: 'Follow my flag to the Book!' }, { actor: 'small', action: 'speak', text: 'Keep up.' }],
    fullText: 'Follow my flag to the Book! Keep up.', model: 'fake', latencyMs: 1, source: 'llm', emotion: null,
    contextMeta: { mode: 'dual', historyMessages: 0, historyChars: 0, imageAttached: false }, tokens: { in: 1, out: 1 }, costUsd: 0,
  })),
}));
vi.mock('./dual-head-playback.js', () => ({
  startEarlyBeat: () => null,
  streamDualHeadBeatAudio: vi.fn((beats: unknown[]) => { played.beats.push(...beats); return new Promise<void>((resolve) => { played.resolve = resolve; }); }),
}));

const { runtimeConfig } = await import('../config/runtime.js');
const { runProactiveTurn, hasActiveAssistantTurn } = await import('./service.js');

describe('a proactive two-head turn', () => {
  afterEach(() => { played.beats = []; played.resolve = null; runtimeConfig.ttsStreamingEnabled = true; });

  it('streams its lines\' audio, as a reply does, and lasts until they have played', async () => {
    runtimeConfig.ttsStreamingEnabled = true;
    const sent: WsServerMessage[] = [];
    let done = false;
    const turn = runProactiveTurn('[Gallery tour; no visitor said this] You are done at the Gold Frame.', (m) => sent.push(m)).then(() => { done = true; });
    await vi.waitFor(() => expect(played.beats).toHaveLength(2));
    expect(sent.map((m) => m.type)).toContain('turn_script');
    expect(done).toBe(false);
    expect(hasActiveAssistantTurn()).toBe(true);   // a visitor's reply waits; the tour's next line too
    played.resolve?.();
    await turn;
    expect(done).toBe(true);
  });

  it('leaves the voicing to the pages when the server does not stream TTS', async () => {
    runtimeConfig.ttsStreamingEnabled = false;
    await runProactiveTurn('hello', () => {});
    expect(played.beats).toHaveLength(0);
  });
});
