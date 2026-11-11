import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Asked for: switch between answering everything and answering only when called ("hey Tubs"), by
// scene or from the dashboard. Seen live: on the tour, visitors talking among themselves got every word
// answered. With the studio's wake-word switch on, only speech that calls the heads (or a follow-up
// shortly after a reply or the tour's open floor) gets a reply; the night's scene sets the switch and
// can add names that call them.

const service = vi.hoisted(() => ({
  active: false,
  runAssistantTurn: vi.fn(async (): Promise<unknown> => ({ turnId: 't1', reply: { text: 'ok' } })),
  runProactiveTurn: vi.fn(async () => null),
  interruptAssistantTurns: vi.fn(() => null),
  hasActiveAssistantTurn: vi.fn(() => service.active),
}));
vi.mock('../assistant/service.js', () => service);
vi.mock('../processing/speech-service.js', async (original) => ({
  ...(await original<typeof import('../processing/speech-service.js')>()),
  transcribeAudio: async (audio: Buffer) => ({ text: audio.toString('utf8') }),
}));
vi.mock('../observability/conversation-log.js', () => ({ logConversation: async () => {}, logTubsReply: async () => {} }));
vi.mock('../observability/langfuse.js', () => ({ captureTurnTrace: () => {} }));

const { handleApiRequest } = await import('../routes/api.js');
const { studioSettings } = await import('./state.js');
const { noteSceneListen, resetSceneListen } = await import('./listen.js');
const { WAKE_FOLLOW_UP_MS, CONVERSATION_WINDOW_MS, endConversation, isInConversation, openConversation } = await import('../assistant/turns.js');
const { detectWakeWord } = await import('../wake-word.js');

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => { void handleApiRequest(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  studioSettings.enabled = false;
  studioSettings.wakeWord = false;
  resetSceneListen();
  endConversation();
  service.runAssistantTurn.mockClear();
});

const say = async (text: string) => (await (await fetch(`${base}/voice`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: text })).json()) as { ignored?: boolean };

describe('the studio\'s wake word', () => {
  it('with the switch on, answers only speech that calls the heads, then follow-ups for a while', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    studioSettings.enabled = true;
    studioSettings.wakeWord = true;
    expect((await say('so the lamp is red now')).ignored).toBe(true);
    expect(service.runAssistantTurn).not.toHaveBeenCalled();
    expect((await say('hey Tubs, what is this picture?')).ignored).toBeFalsy();
    expect(service.runAssistantTurn).toHaveBeenCalledTimes(1);
    // a follow-up right after needs no wake word
    expect((await say('and who is next to him')).ignored).toBeFalsy();
    expect(service.runAssistantTurn).toHaveBeenCalledTimes(2);
  });

  it('with the switch off, answers everything heard, as before', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    studioSettings.enabled = true;
    expect((await say('so the lamp is red now')).ignored).toBeFalsy();
    expect(service.runAssistantTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps the follow-up window short in wake-word mode, and the open floor opens it', () => {
    studioSettings.enabled = true;
    studioSettings.wakeWord = true;
    openConversation(1_000_000);
    expect(isInConversation(1_000_000 + WAKE_FOLLOW_UP_MS - 1)).toBe(true);
    expect(isInConversation(1_000_000 + WAKE_FOLLOW_UP_MS + 1)).toBe(false);
    studioSettings.wakeWord = false;
    expect(isInConversation(1_000_000 + CONVERSATION_WINDOW_MS - 1)).toBe(true);
  });

  it('tonight\'s names from the scene call the heads too, exactly, never by sound-alike', () => {
    expect(detectWakeWord('hey guide, what is this?').detected).toBe(false);
    expect(detectWakeWord('hey guide, what is this?', ['guide']).detected).toBe(true);
    expect(detectWakeWord('hey guy, what is this?', ['guide']).detected).toBe(false);
    expect(detectWakeWord('hey tubs', ['guide']).detected).toBe(true);
    // the sound-alike rule took "this" for "tubs": "hey, what is this?" woke them
    expect(detectWakeWord('hey look at this').detected).toBe(false);
    expect(detectWakeWord('hey tops').detected).toBe(true);   // a known mishearing of "tubs" still counts
  });

  it('a scene change sets the switch; the dashboard holds until the next scene change; names follow the scene', () => {
    studioSettings.enabled = true;
    expect(noteSceneListen({ wake: true, names: ['guide', 'mini'] })).toBe(true);
    studioSettings.wakeWord = true;   // applied
    expect(studioSettings.wakeNames).toEqual(['guide', 'mini']);
    // the same scene, sent again with every context: nothing changes
    expect(noteSceneListen({ wake: true, names: ['guide', 'mini'] })).toBeNull();
    // the dashboard turns it off: it holds while the scene stays
    studioSettings.wakeWord = false;
    expect(noteSceneListen({ wake: true, names: ['guide', 'mini'] })).toBeNull();
    // the next scene listens to everything, the one after waits for "hey Tubs" again
    expect(noteSceneListen({ wake: false })).toBeNull();   // already off
    expect(studioSettings.wakeNames).toEqual([]);
    expect(noteSceneListen({ wake: true })).toBe(true);
    // an older director sends nothing: nothing changes
    expect(noteSceneListen(undefined)).toBeNull();
    expect(noteSceneListen({ wake: 'yes' })).toBeNull();
  });
});
