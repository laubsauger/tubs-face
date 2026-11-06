import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import type { LlmGenerateResult, LlmProvider, LlmStreamArgs } from '../llm/types.js';
import type { TtsStreamChunk } from '../tts/stream.js';

// Characterization tests for a full assistant turn: what clients receive over the
// WebSocket, in what order, and what happens when a turn is interrupted. The LLM
// provider and the Python TTS stream are replaced by in-memory fakes.

interface FakeTtsOptions {
  onChunk: (chunk: TtsStreamChunk) => void;
  onSentenceDone: () => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

const fakes = vi.hoisted(() => ({
  provider: null as unknown as LlmProvider,
  ttsSent: [] as string[],
  // When true, TTS accepts text but never answers (a slow or stuck generator).
  ttsHang: false,
  ttsClosed: 0,
  // How TTS answers one text; by default one chunk, then done.
  ttsChunks: null as ((text: string) => TtsStreamChunk[]) | null,
}));

vi.mock('../llm/provider.js', () => ({
  resolveLlmProvider: () => fakes.provider,
}));

vi.mock('../tts/stream.js', () => ({
  openTtsStream(options: FakeTtsOptions) {
    let open = true;
    return {
      opened: Promise.resolve(true),
      send(text: string) {
        fakes.ttsSent.push(text);
        if (fakes.ttsHang) return;
        const chunks = fakes.ttsChunks?.(text);
        if (chunks) {
          // Several chunks for one text (Ming), arriving one by one as they render.
          chunks.forEach((chunk, i) => setTimeout(() => options.onChunk(chunk), i * 5));
          setTimeout(() => options.onSentenceDone(), chunks.length * 5);
          return;
        }
        setTimeout(() => {
          options.onChunk({ text, audio: 'UklGRg==' });
          options.onSentenceDone();
        }, 0);
      },
      close() {
        if (!open) return;
        open = false;
        fakes.ttsClosed += 1;
        setTimeout(() => options.onClose?.(), 0);
      },
      get ready() {
        return open;
      },
      get closed() {
        return !open;
      },
    };
  },
}));

const { runtimeConfig } = await import('../config/runtime.js');
const { hasActiveAssistantTurn, interruptAssistantTurns, runAssistantTurn } = await import('./service.js');
const { buildContents } = await import('./context.js');

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function llmResult(text: string): LlmGenerateResult {
  return { text, usage: { promptTokenCount: 10, candidatesTokenCount: 5 }, model: 'fake-model' };
}

/** Provider whose generateContent answers each call from a queue (string or pending promise). */
function queuedProvider(replies: Array<string | Promise<string>>): LlmProvider {
  return {
    id: 'gemini',
    getAuthState: () => ({ ready: true, warningMessage: null, auth: null }),
    generateContent: vi.fn(async () => llmResult(await (replies.shift() ?? 'Out of lines.'))),
  };
}

/** Provider that streams the given deltas; a Promise in the list pauses the stream until it resolves. */
function streamingProvider(deltas: Array<string | Promise<void>>): LlmProvider {
  return {
    id: 'gemini',
    getAuthState: () => ({ ready: true, warningMessage: null, auth: null }),
    generateContent: vi.fn(async () => llmResult('unused')),
    streamContent: vi.fn(async (args: LlmStreamArgs) => {
      let text = '';
      for (const delta of deltas) {
        if (typeof delta !== 'string') {
          await delta;
          continue;
        }
        if (args.abortSignal?.aborted) break;
        text += delta;
        args.onChunk(delta);
      }
      return { ...llmResult(text), aborted: Boolean(args.abortSignal?.aborted) };
    }),
  };
}

function collect() {
  const messages: WsServerMessage[] = [];
  return {
    messages,
    broadcast: (message: WsServerMessage) => {
      messages.push(message);
    },
    types: () => messages.map((message) => message.type),
    ofType<T extends WsServerMessage['type']>(type: T) {
      return messages.filter((message): message is Extract<WsServerMessage, { type: T }> => message.type === type);
    },
  };
}

describe('assistant turn', () => {
  let configSnapshot: typeof runtimeConfig;

  beforeAll(() => {
    configSnapshot = structuredClone(runtimeConfig);
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fakes.ttsSent.length = 0;
    fakes.ttsHang = false;
    fakes.ttsClosed = 0;
    fakes.ttsChunks = null;
    runtimeConfig.dualHeadEnabled = false;
    runtimeConfig.ttsStreamingEnabled = false;
    interruptAssistantTurns();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(runtimeConfig, configSnapshot);
  });

  describe('sequential (no TTS streaming)', () => {
    it('announces the turn, then speaks it, all under one turnId', async () => {
      fakes.provider = queuedProvider(['You brought snacks or just vibes? 😏']);
      const ws = collect();

      const result = await runAssistantTurn('what are you doing today', ws.broadcast);

      expect(ws.types()).toEqual(['turn_start', 'turn_context', 'speak', 'stats']);
      const [speak] = ws.ofType('speak');
      expect(speak?.turnId).toBe(result.turnId);
      expect(ws.ofType('turn_start')[0]?.turnId).toBe(result.turnId);
      // The emotion emoji drives the face; it must not be spoken.
      expect(speak?.text).toBe('You brought snacks or just vibes?');
      expect(speak?.emotion?.emoji).toBe('😏');
      expect(result.superseded).toBeUndefined();
    });

    it('drops the reply when the user barges in while the model is still thinking', async () => {
      const pending = deferred<string>();
      fakes.provider = queuedProvider([pending.promise]);
      const ws = collect();

      const turn = runAssistantTurn('tell me something weird', ws.broadcast);
      await waitFor(() => vi.mocked(fakes.provider.generateContent).mock.calls.length > 0);
      interruptAssistantTurns();
      pending.resolve('This should never be heard.');
      const result = await turn;

      expect(result.superseded).toBe(true);
      expect(ws.types()).not.toContain('speak');
    });

    it('does not record a superseded reply in history as if it was said', async () => {
      const pending = deferred<string>();
      fakes.provider = queuedProvider([pending.promise]);

      const turn = runAssistantTurn('what is your secret', collect().broadcast);
      await waitFor(() => vi.mocked(fakes.provider.generateContent).mock.calls.length > 0);
      interruptAssistantTurns();
      pending.resolve('My secret is never heard.');
      await turn;

      const said = buildContents('next').contents.map((entry) => entry.parts[0]?.text);
      expect(said).not.toContain('My secret is never heard.');
      expect(said.at(-2)).toContain('[cut off by the visitor]');
    });

    it('lets a newer turn supersede an older one that is still generating', async () => {
      const slow = deferred<string>();
      fakes.provider = queuedProvider([slow.promise, 'Second question wins.']);
      const ws = collect();

      const first = runAssistantTurn('first question here', ws.broadcast);
      await waitFor(() => vi.mocked(fakes.provider.generateContent).mock.calls.length > 0);
      const second = await runAssistantTurn('second question here', ws.broadcast);
      slow.resolve('Stale answer.');
      const firstResult = await first;

      expect(firstResult.superseded).toBe(true);
      expect(ws.ofType('speak').map((message) => [message.turnId, message.text])).toEqual([
        [second.turnId, 'Second question wins.'],
      ]);
    });

    it('clears the active turn when the reply is done, so greetings can run again', async () => {
      fakes.provider = queuedProvider(['Done talking.']);
      await runAssistantTurn('say something short', collect().broadcast);
      expect(hasActiveAssistantTurn()).toBe(false);
    });

    it('keeps a stray [[MARKER]] out of the spoken and shown text', async () => {
      fakes.provider = queuedProvider(['Nice hat, human. [[SHOW_QR]]']);
      const ws = collect();

      await runAssistantTurn('how do I look', ws.broadcast);

      expect(ws.ofType('speak')[0]?.text).toBe('Nice hat, human.');
    });
  });

  describe('streaming (LLM stream to TTS stream)', () => {
    beforeEach(() => {
      runtimeConfig.ttsStreamingEnabled = true;
    });

    it('sends each sentence to TTS as it completes and finishes with speak_end', async () => {
      fakes.provider = streamingProvider(['Nice hat. ', 'Did it come', ' with instructions? 😏']);
      const ws = collect();

      const result = await runAssistantTurn('do you like my hat', ws.broadcast);

      expect(fakes.ttsSent).toEqual(['Nice hat.', 'Did it come with instructions?']);
      expect(ws.ofType('audio_chunk').map((chunk) => chunk.chunkIndex)).toEqual([0, 1]);
      expect(ws.types()).not.toContain('speak');
      const [end] = ws.ofType('speak_end');
      expect(end?.fullText).toBe('Nice hat. Did it come with instructions?');
      expect(end?.emotion?.emoji).toBe('😏');
      expect(ws.types().at(-1)).toBe('stats');
      expect(result.superseded).toBe(false);
    });

    // A cloned Ming voice renders sentence by sentence with the intonation
    // reset at every boundary; the user heard the rhythm break. It gets the
    // whole reply in one piece instead.
    it('sends a Ming voice the whole reply in one piece', async () => {
      const previousVoice = runtimeConfig.kokoroVoice;
      runtimeConfig.kokoroVoice = 'ming:friend';
      try {
        fakes.provider = streamingProvider(['Nice hat. ', 'Did it come', ' with instructions? 😏']);
        const ws = collect();
        await runAssistantTurn('do you like my hat', ws.broadcast);
        expect(fakes.ttsSent).toEqual(['Nice hat. Did it come with instructions?']);
        expect(ws.ofType('speak_end')[0]?.fullText).toBe('Nice hat. Did it come with instructions?');
      } finally {
        runtimeConfig.kokoroVoice = previousVoice;
      }
    });

    // Ming streams the whole reply in chunks so the first sound comes in a few
    // hundred ms instead of after the whole render. The face has to get every
    // chunk, in order, with the feeling and the "more follows" flag that keeps
    // one subtitle across them, and the turn ends after the last one.
    it('passes a Ming reply streamed in several chunks to the face in order, then ends the turn', async () => {
      runtimeConfig.kokoroVoice = 'ming:friend';
      fakes.ttsChunks = (text) => [
        { text, audio: 'QQ==', more: true },
        { text, audio: 'Qg==', more: true },
        { text, audio: 'Qw==' },
      ];
      fakes.provider = streamingProvider(['😤 Oh, ', 'you again. ', 'Great.']);
      const ws = collect();

      await runAssistantTurn('I am back to bother you', ws.broadcast);

      expect(fakes.ttsSent).toEqual(['Oh, you again. Great.']);
      const chunks = ws.ofType('audio_chunk');
      expect(chunks.map((chunk) => [chunk.audio, chunk.chunkIndex, chunk.more ?? false])).toEqual([
        ['QQ==', 0, true],
        ['Qg==', 1, true],
        ['Qw==', 2, false],
      ]);
      expect(chunks.map((chunk) => chunk.text)).toEqual(Array(3).fill('Oh, you again. Great.'));
      expect(chunks.map((chunk) => chunk.emotion?.expression)).toEqual(['angry', 'angry', 'angry']);
      const types = ws.types();
      expect(types.indexOf('speak_end')).toBeGreaterThan(types.lastIndexOf('audio_chunk'));
    });

    // The speech service sends done when Ming dies midway (no Kokoro restart in
    // the middle of a sentence). The turn must end on that, not hang for 30 s.
    it('ends the turn when a streamed Ming reply stops after its first chunk', async () => {
      runtimeConfig.kokoroVoice = 'ming:friend';
      fakes.ttsChunks = (text) => [{ text, audio: 'QQ==', more: true }];
      fakes.provider = streamingProvider(['Nice hat. ', 'Did it come with instructions?']);
      const ws = collect();

      const startedAt = Date.now();
      const result = await runAssistantTurn('do you like my hat', ws.broadcast);

      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(ws.ofType('audio_chunk')).toHaveLength(1);
      expect(ws.ofType('speak_end')[0]?.fullText).toBe('Nice hat. Did it come with instructions?');
      expect(result.superseded).toBe(false);
    });

    // The emoji comes first so the face can show the feeling from the first
    // word; at the end it only arrived once the reply was over.
    it('puts the leading emotion on every audio chunk and keeps it out of speech', async () => {
      fakes.provider = streamingProvider(['😤 Oh, ', 'you again. ', 'Great.']);
      const ws = collect();

      await runAssistantTurn('I am back to bother you', ws.broadcast);

      expect(fakes.ttsSent).toEqual(['Oh, you again.', 'Great.']);
      expect(ws.ofType('audio_chunk').map((chunk) => chunk.emotion?.expression)).toEqual(['angry', 'angry']);
    });

    // The splitter must never see half a note, or TTS reads "NOTE works in marketing".
    it('keeps a note tag out of speech even when it arrives in pieces, and remembers it', async () => {
      const { fieldNotesSnapshot, resetFieldNotes } = await import('./field-notes.js');
      resetFieldNotes();
      fakes.provider = streamingProvider(['😏 Bold. [', '[NOTE: works in marketing, ', 'loves buzzwords. Owns a lanyard]]']);
      await runAssistantTurn('I work in marketing', collect().broadcast);

      expect(fakes.ttsSent.join(' ')).not.toMatch(/NOTE|lanyard|buzzwords/);
      expect(fakes.ttsSent).toEqual(['Bold.']);
      expect(fieldNotesSnapshot().people[0]?.notes).toEqual(['works in marketing', 'loves buzzwords. Owns a lanyard']);
    });

    it('speaks at most two sentences but still reads the emotion emoji at the end', async () => {
      // A normal turn, not one of the occasional bits (which may run to six sentences).
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      fakes.provider = streamingProvider(['One thing. ', 'Two things. ', 'Three things. 😏']);
      const ws = collect();

      await runAssistantTurn('list some things', ws.broadcast);

      expect(fakes.ttsSent).toEqual(['One thing.', 'Two things.']);
      const [end] = ws.ofType('speak_end');
      expect(end?.fullText).toBe('One thing. Two things.');
      expect(end?.emotion?.emoji).toBe('😏');
    });

    // An abort resolves with empty text; it used to fall through to a second,
    // one-call LLM request for a turn nobody was waiting for any more.
    it('does not call the model a second time when interrupted before the first word', async () => {
      const gate = deferred();
      fakes.provider = streamingProvider([gate.promise, 'Too late. ']);
      const ws = collect();

      const turn = runAssistantTurn('tell me about yourself', ws.broadcast);
      await waitFor(() => vi.mocked(fakes.provider.streamContent!).mock.calls.length > 0);
      interruptAssistantTurns();
      gate.resolve();
      const result = await turn;

      expect(result.superseded).toBe(true);
      expect(fakes.provider.generateContent).not.toHaveBeenCalled();
      expect(ws.types()).not.toContain('speak');
    });

    it('closes the TTS stream as soon as the user barges in, instead of waiting for audio nobody hears', async () => {
      fakes.ttsHang = true;
      fakes.provider = streamingProvider(['First line here. ', 'Second line here.']);
      const ws = collect();

      const turn = runAssistantTurn('say two things', ws.broadcast);
      await waitFor(() => fakes.ttsSent.length === 2);
      const interruptedAt = Date.now();
      interruptAssistantTurns();
      const result = await turn;

      // Before, the turn sat on the open TTS socket for up to 30 s.
      expect(Date.now() - interruptedAt).toBeLessThan(500);
      expect(fakes.ttsClosed).toBe(1);
      expect(result.superseded).toBe(true);
      expect(ws.types()).not.toContain('stats');
    });

    it('strips a JSON envelope so only prose reaches TTS', async () => {
      fakes.provider = streamingProvider(['{"text": "', 'Cool shoes. ', 'Very brave."}']);
      const ws = collect();

      await runAssistantTurn('check out my shoes', ws.broadcast);

      expect(fakes.ttsSent).toEqual(['Cool shoes.', 'Very brave.']);
    });

    it('stops sending audio for a turn once the user barges in', async () => {
      const gate = deferred();
      fakes.provider = streamingProvider(['First line here. ', gate.promise, 'Second line here.']);
      const ws = collect();

      const turn = runAssistantTurn('say two things', ws.broadcast);
      await waitFor(() => ws.ofType('audio_chunk').length === 1);
      interruptAssistantTurns();
      gate.resolve();
      const result = await turn;

      expect(result.superseded).toBe(true);
      expect(fakes.ttsSent).toEqual(['First line here.']);
      expect(ws.ofType('audio_chunk')).toHaveLength(1);
      // Clients still get speak_end so they can close the audio session cleanly.
      expect(ws.types()).toContain('speak_end');
      expect(ws.types()).not.toContain('stats');
    });
  });

  describe('dual-head', () => {
    beforeEach(() => {
      runtimeConfig.dualHeadEnabled = true;
      runtimeConfig.dualHeadMode = 'llm_directed';
      runtimeConfig.dualHeadTurnPolicy = 'llm_order';
    });

    it('broadcasts one turn_script with every beat instead of a single speak', async () => {
      fakes.provider = queuedProvider([JSON.stringify({
        beats: [
          { actor: 'main', action: 'speak', text: 'You again?', emoji: '😏' },
          { actor: 'small', action: 'react', emoji: '😄', delayMs: 260 },
          { actor: 'small', action: 'speak', text: 'Bring snacks next time.' },
        ],
      })]);
      const ws = collect();

      const result = await runAssistantTurn('hello again friends', ws.broadcast);

      expect(ws.types()).toEqual(['turn_start', 'turn_context', 'turn_script', 'stats']);
      const [script] = ws.ofType('turn_script');
      expect(script?.turnId).toBe(result.turnId);
      expect(script?.beats.map((beat) => `${beat.actor}:${beat.action}`)).toEqual(['main:speak', 'small:react', 'small:speak']);
      expect(result.reply.text).toBe('You again? Bring snacks next time.');
    });

    // Two-head turns wait ~2 s for the reply, so they need the filler most.
    // It is main's voice, so main's head says it; its speak_end lets main's
    // face stop talking when it ends, as Mini may have the first line.
    it('starts a voice turn with the filler on main\'s head, ended before the beats', async () => {
      const { prepareFillers } = await import('./fillers.js');
      expect(await prepareFillers(runtimeConfig.kokoroVoice)).toBe(true);
      runtimeConfig.ttsStreamingEnabled = true;
      fakes.provider = queuedProvider([JSON.stringify({
        beats: [{ actor: 'small', action: 'speak', text: 'Mini goes first.' }],
      })]);
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0); // this turn gets a filler
      const ws = collect();

      const result = await runAssistantTurn('nice hat', ws.broadcast, undefined, { filler: true });

      const [filler, fillerEnd] = ws.messages.slice(1, 3);
      expect(filler).toMatchObject({ type: 'audio_chunk', actor: 'main', filler: true, turnId: result.turnId });
      expect(fillerEnd).toMatchObject({ type: 'speak_end', actor: 'main', turnId: result.turnId });
      const beatAudio = ws.ofType('audio_chunk').filter((message) => !message.filler);
      expect(beatAudio.map((message) => message.actor)).toEqual(['small']);
    });
  });
});
