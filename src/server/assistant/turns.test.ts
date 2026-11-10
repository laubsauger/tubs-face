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
const { APPEARANCE_GREETING_COOLDOWN_MS, appearancePrompt, cancelAppearanceGreeting, startProactiveTurn, isInConversation, onNewVisitor, onVisitorLeft, scheduleAppearanceGreeting, startUserTurn, CONVERSATION_WINDOW_MS, STILL_TALKING_MS } = await import('./turns.js');
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
  // Recognition flicker, or a second tab with the camera on, can report the
  // same person arriving again and again. Tubs greets once, not every few seconds.
  it('greets at most once per cooldown window', async () => {
    const ws = collect();
    vi.setSystemTime(Date.now() + 10 * APPEARANCE_GREETING_COOLDOWN_MS); // clear of greetings in earlier tests
    scheduleAppearanceGreeting('Known person nearby: Flo.', ws.broadcast);
    await vi.advanceTimersByTimeAsync(2000);
    scheduleAppearanceGreeting('Known person nearby: Flo.', ws.broadcast);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.runProactiveTurn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(APPEARANCE_GREETING_COOLDOWN_MS);
    scheduleAppearanceGreeting('Someone new is nearby.', ws.broadcast);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.runProactiveTurn).toHaveBeenCalledTimes(2);
    expect(service.runProactiveTurn).toHaveBeenLastCalledWith('Someone new is nearby.', ws.broadcast);
  });

  // Seen live: on the gallery tour every newcomer got a greeting and every new face wiped the
  // conversation, so the guide kept losing the thread. While the director says a tour runs, neither.
  it('on the gallery tour: no arrival greetings, and a new face does not wipe the conversation', async () => {
    const { noteStudioContext, forgetStudioContext } = await import('../studio/context.js');
    const ws = collect();
    vi.setSystemTime(Date.now() + 30 * APPEARANCE_GREETING_COOLDOWN_MS); // clear of the greetings in earlier tests
    noteStudioContext({ reason: 'change', heads: {}, people: [], reference: null, ts: Date.now(), tour: { where: 'Book', step: 'present', stop: 2, of: 5, next: 'Immersive' } });
    scheduleAppearanceGreeting('Someone new is nearby.', ws.broadcast);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.runProactiveTurn).not.toHaveBeenCalled();
    const log = vi.spyOn(console, 'log');
    onNewVisitor();
    expect(log.mock.calls.some((c) => String(c[0]).includes('conversation kept (gallery tour)'))).toBe(true);
    log.mockRestore();
    // the tour over (a context without it): greetings again
    forgetStudioContext();
    scheduleAppearanceGreeting('Someone new is nearby.', ws.broadcast);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.runProactiveTurn).toHaveBeenCalledTimes(1);
  });

  it('clears the thinking face when a proactive line produces nothing', async () => {
    const ws = collect();
    service.runProactiveTurn.mockResolvedValueOnce(null);
    startProactiveTurn('Someone is nearby.', ws.broadcast);
    await vi.waitFor(() => expect(ws.types()).toContain('expression'));
    expect(ws.types()).toEqual(['interrupt', 'thinking', 'expression']);
  });

  it('never kills a reply that is still being generated for a proactive line', () => {
    const ws = collect();
    service.active = true;
    startProactiveTurn('Someone is nearby.', ws.broadcast);
    expect(ws.types()).toEqual([]);
    expect(service.runProactiveTurn).not.toHaveBeenCalled();
  });

  it('clears group and camera-off notes when a new visitor replaces the old one', async () => {
    const notes = await import('./field-notes.js');
    notes.resetFieldNotes();
    notes.recordFieldNotes('[[NOTE: wears a red hoodie]]');
    onNewVisitor();
    expect(notes.fieldNotesSnapshot().people).toEqual([]);
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

// "Mini cuts off Main": a line Tubs starts on his own (a proactive line, an
// appearance greeting) interrupted the turn still playing, whose generation
// was over but whose audio was not, and cut its line off mid-word. Measured
// on a test instance: the line playing when a proactive line came was cut
// (1.19 s of 2.10 s heard), and the turn's last two lines never played. It
// now waits for the heads to fall quiet; someone speaking still comes first.
describe('a line Tubs starts on his own', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    runtimeConfig.muted = false;
    service.active = false;
    service.runProactiveTurn.mockClear();
    service.interruptAssistantTurns.mockClear();
    const heads = await import('./heads.js');
    heads.resetHeads();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits until both heads are quiet, never cutting a line still playing', async () => {
    const heads = await import('./heads.js');
    const { messages, broadcast } = collect();
    vi.setSystemTime(100_000);
    heads.noteHeadSpeaking('small', true);
    startProactiveTurn('Someone new is nearby and has not spoken.', broadcast);
    await vi.advanceTimersByTimeAsync(3000);
    expect(messages.filter((m) => m.type === 'interrupt')).toEqual([]);
    expect(service.runProactiveTurn).not.toHaveBeenCalled();
    // Small's line ends; the other head's answer could still be on its way, so a breath more.
    heads.noteHeadSpeaking('small', false);
    await vi.advanceTimersByTimeAsync(heads.QUIET_AFTER_SPEECH_MS - 500);
    expect(service.runProactiveTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.runProactiveTurn).toHaveBeenCalledTimes(1);
  });

  it('waits for audio just sent that has not started yet, and gives way to someone speaking', async () => {
    const heads = await import('./heads.js');
    const { broadcast } = collect();
    vi.setSystemTime(200_000);
    heads.noteAudioSent();
    startProactiveTurn('A stranger is standing there silently.', broadcast);
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.runProactiveTurn).not.toHaveBeenCalled();
    // A visitor speaks meanwhile: their turn, and the waiting line is dropped.
    startUserTurn({ text: 'Hello there', source: 'text', broadcast });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.runProactiveTurn).not.toHaveBeenCalled();
  });
});
