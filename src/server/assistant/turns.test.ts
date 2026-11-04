import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsServerMessage } from '../../shared/contracts/ws.js';

// The same rules must hold for typed chat, voice and greetings: mute drops
// input, a user turn opens the no-wake-word window, and a pending greeting
// never talks over someone who just spoke.

const service = vi.hoisted(() => ({
  active: false,
  runAssistantTurn: vi.fn(async (): Promise<unknown> => ({ turnId: 't1', reply: { text: 'ok' } })),
  runProactiveTurn: vi.fn(async () => null),
  interruptAssistantTurns: vi.fn(() => null),
  hasActiveAssistantTurn: vi.fn(() => service.active),
}));
vi.mock('./service.js', () => service);
const recorded = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../observability/conversation-log.js', () => ({
  logConversation: async (speaker: string, text: string) => void recorded.lines.push(`${speaker}: ${text}`),
  logTubsReply: async (text: string) => void recorded.lines.push(`TUBS: ${text}`),
}));
vi.mock('../observability/langfuse.js', () => ({ captureTurnTrace: () => {} }));

const { runtimeConfig } = await import('../config/runtime.js');
const { appearancePrompt, cancelAppearanceGreeting, isInConversation, onNewVisitor, onVisitorLeft, scheduleAppearanceGreeting, startUserTurn, CONVERSATION_WINDOW_MS, STILL_TALKING_MS } = await import('./turns.js');
const { buildContents, getVisualContext, pushHistory, updateVisualContext } = await import('./context.js');

function collect() {
  const messages: WsServerMessage[] = [];
  return { messages, broadcast: (message: WsServerMessage) => void messages.push(message), types: () => messages.map((m) => m.type) };
}

describe('turns', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    runtimeConfig.muted = false;
    service.active = false;
    cancelAppearanceGreeting();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    service.runAssistantTurn.mockClear();
    service.runProactiveTurn.mockClear();
  });

  it('drops user input while muted, whatever the source', () => {
    runtimeConfig.muted = true;
    const ws = collect();
    expect(startUserTurn({ text: 'hello', source: 'text', broadcast: ws.broadcast })).toBeNull();
    expect(startUserTurn({ text: 'hello', source: 'voice', broadcast: ws.broadcast })).toBeNull();
    expect(service.runAssistantTurn).not.toHaveBeenCalled();
    expect(ws.types()).not.toContain('incoming');
  });

  it('announces the turn, barges in on the old one and opens the conversation window', async () => {
    const ws = collect();
    vi.setSystemTime(1_000_000);
    await startUserTurn({ text: 'what is that hat', source: 'text', broadcast: ws.broadcast });

    expect(ws.types()).toEqual(['interrupt', 'incoming', 'conversation_mode', 'thinking']);
    // Typed chat shows up instantly; only spoken turns get a filler sound.
    expect(service.runAssistantTurn).toHaveBeenCalledWith('what is that hat', ws.broadcast, expect.anything(), { filler: false });
    // Typed chat counts too: the next spoken line needs no wake word.
    expect(isInConversation(1_000_000 + CONVERSATION_WINDOW_MS - 1)).toBe(true);
    expect(isInConversation(1_000_000 + CONVERSATION_WINDOW_MS + 1)).toBe(false);
  });

  it('writes both sides of the exchange to the conversation log', async () => {
    recorded.lines.length = 0;
    await startUserTurn({ text: 'nice hat', source: 'voice', broadcast: collect().broadcast });
    expect(service.runAssistantTurn).toHaveBeenLastCalledWith('nice hat', expect.any(Function), expect.anything(), { filler: true });
    expect(recorded.lines).toEqual(['USER: nice hat', 'TUBS: ok']);
  });

  it('says a short line out loud when the LLM fails, instead of going silent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.runAssistantTurn.mockRejectedValueOnce(new Error('Gemini API error: quota'));
    const ws = collect();

    await expect(startUserTurn({ text: 'hello?', source: 'voice', broadcast: ws.broadcast })).rejects.toThrow('quota');

    expect(ws.types().slice(-2)).toEqual(['error', 'speak']);
    const speak = ws.messages.at(-1);
    expect(speak?.type === 'speak' && speak.text.length > 0).toBe(true);
  });

  it('cancels a pending appearance greeting when someone speaks first', async () => {
    const ws = collect();
    scheduleAppearanceGreeting('Someone is nearby.', ws.broadcast);
    await startUserTurn({ text: 'hey robot', source: 'voice', broadcast: ws.broadcast });
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.runProactiveTurn).not.toHaveBeenCalled();
  });

  it('skips the greeting if a reply is already running when it fires', async () => {
    const ws = collect();
    scheduleAppearanceGreeting('Someone is nearby.', ws.broadcast);
    service.active = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.runProactiveTurn).not.toHaveBeenCalled();

    service.active = false;
    scheduleAppearanceGreeting('Someone is nearby.', ws.broadcast);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.runProactiveTurn).toHaveBeenCalledWith('Someone is nearby.', ws.broadcast);
  });
  // Visitors come and go all evening. The next one must not hear about the
  // last one's jacket, but a visitor who is still talking off-camera must not
  // lose the thread.
  it('forgets the conversation once the visitor has left, not while they still talk', async () => {
    vi.setSystemTime(2_000_000);
    await startUserTurn({ text: 'nice hat', source: 'voice', broadcast: collect().broadcast });
    pushHistory('user', 'nice hat');
    pushHistory('model', 'Thanks, it is a lid.');
    updateVisualContext('red hoodie', 2_000_000);

    expect(onVisitorLeft(2_000_000 + 5_000)).toBe(false);
    expect(buildContents('next').meta.historyMessages).toBe(2);

    expect(onVisitorLeft(2_000_000 + STILL_TALKING_MS)).toBe(true);
    expect(buildContents('next').meta.historyMessages).toBe(0);
    expect(getVisualContext(2_000_000 + STILL_TALKING_MS)).toBe('');
    expect(isInConversation(2_000_000 + STILL_TALKING_MS)).toBe(false);
  });

  // The face only reports a new visitor when the embedding says it is someone else.
  it('forgets at once when a different person comes into view, even mid-conversation', async () => {
    await startUserTurn({ text: 'nice hat', source: 'voice', broadcast: collect().broadcast });
    pushHistory('user', 'nice hat');
    pushHistory('model', 'It is a lid.');
    onNewVisitor();
    expect(buildContents('hi').meta.historyMessages).toBe(0);
    expect(isInConversation()).toBe(false);
  });

  it('welcomes a returning visitor back instead of greeting them as new', () => {
    expect(appearancePrompt(['Anna'], true, 45_000)).toBe('Anna is back after stepping away for about 45 seconds. React to them coming back, your way.');
    expect(appearancePrompt([], true, 150_000)).toContain('The person you were talking to is back after stepping away for about 3 minutes');
    expect(appearancePrompt(['Anna'], false)).toContain('Greet them by name');
  });
});
