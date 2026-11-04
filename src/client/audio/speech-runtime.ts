import type { TurnBeat, TurnEmotion } from '../../shared/contracts/turn-script.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import type { AppStore } from '../state/app-state.js';
import { pushStreamDebugEntry } from '../chat/state.js';
import { buildLocalTurnTimeline } from '../turn-script.js';
import { createTurnTimer, type TurnTimer } from '../turn-timing.js';
import { createSubtitleController, type SubtitleController } from '../ui/subtitles.js';
import { createQueueRun, type QueueRun } from './queue-run.js';
import { STREAMING_GAP_GRACE_MS, createStreamingSession, type ScheduledChunk, type StreamingSession } from './streaming-session.js';

interface SpeakQueueItem {
  type: 'speak' | 'wait' | 'react' | 'wait_remote';
  actor?: 'main' | 'small';
  text?: string;
  delayMs?: number;
  emotion?: TurnEmotion | null;
  turnId?: string | null;
}

const INTER_UTTERANCE_PAUSE_MS = 220;
const REACTION_PAUSE_MS = 420;
const POST_SPEECH_IDLE_DELAY_MS = 350;
const SUBTITLE_CLEAR_DELAY_MS = 4000;
const REMOTE_SPEECH_STALE_MS = 20_000;
const REMOTE_WAIT_POLL_MS = 90;
const REMOTE_WAIT_MAX_MS = 45_000;
const SPEECH_SAFETY_MAX_MS = 60_000;
const STREAMING_SUBTITLE_HOLD_SEC = 12;

export interface SpeechRuntime {
  init(): void;
  bind(root: HTMLElement): void;
  handleServerMessage(message: WsServerMessage, targetActor?: 'main' | 'small'): void;
  /** Pre-create and unlock the streaming AudioContext during a user gesture. */
  unlockAudio(): void;
  dispose(): void;
}

export function createSpeechRuntime(store: AppStore, mode: 'main' | 'mini'): SpeechRuntime {
  const queue: SpeakQueueItem[] = [];
  let audioElement: HTMLAudioElement | null = null;
  let disposed = false;
  let pendingInferencePlayback: { blob: Blob; turnId: string | null } | null = null;
  let streamingAudioContext: AudioContext | null = null;
  // The turn whose streamed audio is playing; it owns its sources and timers.
  let streamSession: StreamingSession | null = null;
  // speak_end with no audio: lets a waiting playTts move on after a grace period.
  let pendingEndTimer: number | null = null;
  let streamingSubtitleText = '';
  let activeSpeechTurnId: string | null = null;
  let activeSpeechActor: 'main' | 'small' | null = null;
  let activeQueueTurnId: string | null = null;
  let subtitles: SubtitleController = createSubtitleController(null);
  let remoteActorSpeaking = false;
  let remoteActorSpeakingUntil = 0;
  let reactionResetTimer: number | null = null;
  let speechSafetyTimer: number | null = null;
  let subtitleClearTimer: number | null = null;
  let stopSpeechHandler: ((event: Event) => void) | null = null;
  let lastEmotion: TurnEmotion | null = null;
  // Beat metadata from turn_script for syncing expressions with server-streamed audio
  let pendingBeatMeta: Array<{
    index: number;
    actor: 'main' | 'small';
    action: string;
    emotion: TurnEmotion | null;
    text: string;
  }> = [];
  let lastStreamingBeatIndex = -1;

  // The running pass over the queue. Cancelling it ends every pause and wait it
  // is in, so nothing from an interrupted item can release the queue later.
  let queueRun: QueueRun | null = null;
  // Turns the user barged in on. Audio already in flight for them is dropped.
  const interruptedTurnIds = new Set<string>();

  return {
    init(): void {
      bindInferenceUnlockHandlers();
      bindStopSpeechHandler();
      store.appendLog('info', 'Speech runtime ready');
    },
    bind(root: HTMLElement): void {
      subtitles = createSubtitleController(root.querySelector<HTMLElement>('#visual-subtitle'));
    },
    handleServerMessage(message: WsServerMessage, targetActor?: 'main' | 'small'): void {
      if (disposed) {
        return;
      }
      const localActor: 'main' | 'small' = targetActor ?? (mode === 'mini' ? 'small' : 'main');
      const dualHeadActive = Boolean(store.getState().config?.dualHeadEnabled && store.getState().config?.dualHeadMode !== 'off');

      switch (message.type) {
        case 'speak':
          if (mode === 'mini') {
            return;
          }
          enqueueSpeak(message.text, message.turnId);
          return;
        case 'turn_script':
          enqueueTurnScript(message.beats, message.turnId);
          return;
        case 'speak_chunk':
          if (mode === 'mini') {
            return;
          }
          enqueueSpeak(message.text, message.turnId);
          return;
        case 'audio_chunk':
          if (message.actor && message.actor !== localActor) {
            return;
          }
          if (mode === 'mini' && !message.actor) {
            return;
          }
          if (message.turnId && interruptedTurnIds.has(message.turnId)) {
            return;
          }
          try {
            console.log(`[STREAM-v2] chunk_in #${message.chunkIndex ?? '?'} | len=${message.audio?.length ?? 0} | turn=${message.turnId ?? '?'} | actor=${message.actor ?? '-'} | beat=${message.beatIndex ?? '-'} | session=${Boolean(streamSession)} | t=${Date.now()}`);
            // Sync expressions when beat changes (server-streamed dual-head)
            if (message.beatIndex != null && message.beatIndex !== lastStreamingBeatIndex) {
              lastStreamingBeatIndex = message.beatIndex;
              applyStreamingBeatExpression(message.beatIndex, message.actor);
            }
            playStreamingAudioChunk(message.audio, message.turnId, message.actor, message.text);
          } catch (err) {
            console.error('[Stream] playStreamingAudioChunk THREW:', err);
          }
          return;
        case 'speak_end':
          if (message.actor && message.actor !== localActor) {
            return;
          }
          if (message.turnId && interruptedTurnIds.has(message.turnId)) {
            return;
          }
          scheduleStreamingEnd(message.turnId);
          return;
        case 'sleep':
          stopAllPlayback();
          return;
        case 'interrupt':
          interruptTurn(message.turnId ?? null);
          return;
        case 'head_speech_state':
          handleRemoteHeadSpeechState(message);
          return;
        default:
          return;
      }
    },
    unlockAudio(): void {
      // iOS Safari requires AudioContext creation + resume + buffer playback all
      // within the same user-gesture call stack. We also play a tiny silent WAV
      // via HTMLAudioElement as a second unlock vector (some WebKit builds need it).
      if (!streamingAudioContext) {
        streamingAudioContext = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }
      if (streamingAudioContext.state === 'suspended') {
        void streamingAudioContext.resume();
      }
      try {
        const silentBuffer = streamingAudioContext.createBuffer(1, 1, streamingAudioContext.sampleRate);
        const src = streamingAudioContext.createBufferSource();
        src.buffer = silentBuffer;
        src.connect(streamingAudioContext.destination);
        src.start();
      } catch {
        // ignore — best-effort unlock
      }
      // Fallback: play a tiny silent WAV via <audio> element (helps unlock on
      // some iOS/WebKit versions that gate Web Audio on HTMLMediaElement playback).
      try {
        const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
        const el = new Audio(silentWav);
        el.volume = 0.01;
        void el.play().catch(() => { /* ignore */ });
      } catch {
        // ignore
      }
      console.log('[Spectator] Audio unlocked — AudioContext state:', streamingAudioContext.state);
    },
    dispose(): void {
      disposed = true;
      stopAllPlayback();
      detachStopSpeechHandler();
      if (streamingAudioContext && streamingAudioContext.state !== 'closed') {
        void streamingAudioContext.close().catch(() => { });
      }
    },
  };

  function enqueueSpeak(text: string, turnId?: string | null): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    queue.push({
      type: 'speak',
      text: normalized,
      ...(turnId !== undefined ? { turnId } : {}),
    });
    processQueue();
  }

  function enqueueTurnScript(beats: TurnBeat[], turnId?: string): void {
    const isDualHead = Boolean(store.getState().config?.dualHeadEnabled && store.getState().config?.dualHeadMode !== 'off');
    const serverStreaming = Boolean(store.getState().config?.ttsStreamingEnabled);

    const actor = mode === 'mini' ? 'small' : 'main';
    if (serverStreaming) {
      pendingBeatMeta = beats
        .map((beat, i) => ({ beat, i }))
        .filter(({ beat }) => (beat.actor === 'small' ? 'small' : 'main') === actor)
        .map(({ beat, i }) => ({
          index: i,
          actor,
          action: beat.action,
          emotion: beat.emotion ?? null,
          text: beat.text ?? '',
        }));
    } else {
      pendingBeatMeta = [];
    }
    if (isDualHead && serverStreaming) {
      // In dual-head streaming mode the server already serializes the beat audio.
      // Running local scripted beat previews here makes the faces race ahead and
      // appear to speak on top of each other before their audio actually arrives.
      processQueue();
      return;
    }

    const timeline = buildLocalTurnTimeline(beats, actor, {
      includeRemoteWait: isDualHead,
      voiceAllActors: mode === 'main' && !isDualHead,
    });
    // When mini has no WS sender, local speak beats must stay visual-only if
    // audio is expected to arrive from the server.
    const suppressTts = mode === 'mini' && serverStreaming;
    const hasSpeakBeat = !suppressTts && timeline.some((item) => item.action === 'speak' && item.text?.trim());
    let promotedReactToSpeak = false;
    for (const item of timeline) {
      // When main is handling our beats, demote speak to react (visual only)
      const effectiveAction = (suppressTts && item.action === 'speak') ? 'react' : item.action;
      if (mode === 'mini' && effectiveAction === 'react') {
        const reactText = item.text?.trim() ?? '';
        if (!hasSpeakBeat && reactText && !promotedReactToSpeak && !suppressTts) {
          promotedReactToSpeak = true;
          queue.push({
            type: 'speak',
            text: reactText,
            ...(item.emotion ? { emotion: item.emotion } : {}),
            ...(turnId !== undefined ? { turnId } : {}),
          });
          continue;
        }
      }
      queue.push({
        type: effectiveAction,
        ...(item.actor ? { actor: item.actor } : {}),
        ...(item.text?.trim() ? { text: item.text.trim() } : {}),
        ...(item.delayMs !== undefined ? { delayMs: Math.max(120, item.delayMs) } : (suppressTts && effectiveAction === 'react' ? { delayMs: REACTION_PAUSE_MS } : {})),
        ...(item.emotion ? { emotion: item.emotion } : {}),
        ...(turnId !== undefined ? { turnId } : {}),
      });
    }
    processQueue();
  }

  /** Start working through the queue, or nudge a running pass that is waiting. */
  function processQueue(): void {
    if (disposed) {
      return;
    }
    if (queueRun) {
      queueRun.wake();
      return;
    }
    if (queue.length === 0) {
      lastEmotion = null;
      return;
    }
    const run = createQueueRun();
    queueRun = run;
    void drainQueue(run).finally(() => {
      if (queueRun === run) {
        queueRun = null;
      }
    });
  }

  function cancelQueueRun(): void {
    queueRun?.cancel();
    queueRun = null;
  }

  async function drainQueue(run: QueueRun): Promise<void> {
    while (!run.cancelled) {
      const item = queue.shift();
      if (!item) {
        break;
      }
      activeQueueTurnId = item.turnId ?? null;
      await playQueueItem(item, run);
      if (!run.cancelled) {
        activeQueueTurnId = null;
      }
    }
    if (!run.cancelled) {
      lastEmotion = null;
    }
  }

  async function playQueueItem(item: SpeakQueueItem, run: QueueRun): Promise<void> {
    if (item.type === 'wait' || item.type === 'wait_remote') {
      if (mode === 'mini') {
        subtitles.stop();
      }
      if (item.type === 'wait') {
        await run.pause(item.delayMs ?? 320);
      } else {
        await waitForRemoteActor(run);
      }
      return;
    }

    if (item.type === 'react') {
      // Don't change main face expression for small actor's react beats
      if (!(item.actor === 'small' && mode === 'main')) {
        applyBeatVisuals(item.text ?? '', item.emotion, false);
      }
      if (mode === 'mini') {
        const subtitlesEnabled = store.getState().config?.secondarySubtitleEnabled !== false;
        if (subtitlesEnabled && item.text?.trim()) {
          subtitles.start(item.text.trim(), Math.max(450, item.delayMs ?? REACTION_PAUSE_MS) / 1000);
        } else {
          subtitles.stop();
        }
      }
      await run.pause(item.delayMs ?? REACTION_PAUSE_MS);
      if (!run.cancelled) {
        store.setState((current) => ({
          ...current,
          currentReactionEmoji: '',
          currentExpression: current.sleeping ? 'sleep' : 'idle',
        }));
      }
      return;
    }

    if (!item.text) {
      return;
    }

    lastEmotion = item.emotion ?? null;
    clearSubtitleClearTimer();
    // Show text in subtitle immediately as preview before audio loads
    subtitles.setText(item.text);
    // For small beats in main mode, only update subtitle — don't change main face expression
    if (item.actor === 'small' && mode === 'main') {
      store.setState((current) => ({
        ...current,
        subtitleText: item.text ?? '',
      }));
    } else {
      applyBeatVisuals(item.text, item.emotion, true);
    }
    startSpeechSafetyTimer();
    try {
      await playTts(item.text, item.turnId, item.actor, run);
    } catch (error) {
      store.appendLog('error', error instanceof Error ? error.message : 'Speech playback failed');
      if (!run.cancelled) {
        finishSpeech(item.turnId ?? null);
      }
    } finally {
      clearSpeechSafetyTimer();
    }
    await run.pause(INTER_UTTERANCE_PAUSE_MS);
  }

  async function playTts(text: string, turnId?: string | null, actor?: 'main' | 'small', run?: QueueRun): Promise<void> {
    const effectiveTurnId = turnId ?? store.getState().currentTurnId ?? null;
    activeSpeechTurnId = effectiveTurnId;
    activeSpeechActor = actor ?? (mode === 'mini' ? 'small' : 'main');
    // When main plays a small beat, don't set audioPlaying on this window —
    // the mini window drives its own face via the head_speech_state signal.
    const isLocalBeat = !(mode === 'main' && activeSpeechActor === 'small');
    const turnTimer = createTurnTimer({
      side: 'frontend',
      source: 'tts',
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
    });
    turnTimer.mark('TTS queued');

    const useBrowserFallback = store.getState().config?.ttsBackend === 'system';
    if (useBrowserFallback) {
      if (isLocalBeat) updatePlaybackState(true, 'Speaking');
      emitHeadSpeechState('start', effectiveTurnId, actor);
      turnTimer.mark('Browser TTS fallback selected');
      await speakWithBrowserTts(text, effectiveTurnId, turnTimer);
      turnTimer.mark('Speech finished');
      turnTimer.log({ title: '[Turn Timing]' });
      return;
    }

    // Streaming TTS via WS: send a tts_request and wait for audio_chunk + speak_end
    const useWsStreaming = store.getState().config?.ttsStreamingEnabled === true;
    if (useWsStreaming) {
      const endWsTtsSpan = turnTimer.span('WS TTS Stream');
      store.setState((current) => pushStreamDebugEntry(current, 'tts_ws_request', {
        turnId: effectiveTurnId ?? current.currentTurnId,
        textChars: text.length,
        ts: Date.now(),
      }));

      // Send TTS request via custom event (bootstrap wires this to wsClient.send)
      const voice = (mode === 'mini' || actor === 'small')
        ? store.getState().config?.secondaryVoice
        : store.getState().config?.kokoroVoice;
      console.log(`[Stream] playTts sending tts_request | turnId=${effectiveTurnId} | text="${text.slice(0, 50)}" | voice=${voice ?? 'default'}`);
      window.dispatchEvent(new CustomEvent('tubs:tts-request', {
        detail: {
          text,
          voice: voice || undefined,
          turnId: effectiveTurnId ?? undefined,
        },
      }));

      // Wait until the streamed audio has played (speak_end + last chunk), the
      // queue run is cancelled by an interrupt, or the safety timeout.
      await new Promise<void>((resolve) => {
        let safety = 0;
        const done = () => {
          window.removeEventListener('tubs:tts-stream-done', onStreamDone as EventListener);
          window.clearTimeout(safety);
          resolve();
        };
        const onStreamDone = (event: Event) => {
          const msg = (event as CustomEvent<{ turnId?: string }>).detail;
          if (!effectiveTurnId || msg?.turnId === effectiveTurnId) {
            done();
          }
        };
        window.addEventListener('tubs:tts-stream-done', onStreamDone as EventListener);
        run?.onCancel(done);
        safety = window.setTimeout(() => {
          console.warn(`[Stream] WS TTS safety timeout (${SPEECH_SAFETY_MAX_MS}ms) — forcing resolve | turnId=${effectiveTurnId}`);
          done();
        }, SPEECH_SAFETY_MAX_MS);
      });
      endWsTtsSpan();
      turnTimer.mark('Speech finished');
      turnTimer.log({ title: '[Turn Timing]' });
      return;
    }

    // Non-streaming: HTTP /tts fetch
    if (isLocalBeat) updatePlaybackState(true, 'Speaking');
    emitHeadSpeechState('start', effectiveTurnId, actor);
    try {
      store.setState((current) => pushStreamDebugEntry(current, 'tts_request_start', {
        turnId: effectiveTurnId ?? current.currentTurnId,
        textChars: text.length,
        ts: Date.now(),
      }));
      const endTtsHttpSpan = turnTimer.span('HTTP /tts');
      const response = await fetch('/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/wav, application/octet-stream',
        },
        body: JSON.stringify({
          text,
          voice: (mode === 'mini' || actor === 'small')
            ? store.getState().config?.secondaryVoice
            : store.getState().config?.kokoroVoice,
          ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        }),
      });
      endTtsHttpSpan();

      if (!response.ok) {
        store.setState((current) => pushStreamDebugEntry(current, 'tts_request_error', {
          turnId: effectiveTurnId ?? current.currentTurnId,
          status: response.status,
          statusText: response.statusText,
          ts: Date.now(),
        }));
        const detail = await readTtsErrorDetail(response);
        turnTimer.mark('TTS request failed');
        turnTimer.log({ title: '[Turn Timing]' });
        throw new Error(`TTS failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`);
      }

      store.setState((current) => pushStreamDebugEntry(current, 'tts_request_complete', {
        turnId: effectiveTurnId ?? current.currentTurnId,
        status: response.status,
        ts: Date.now(),
      }));
      const blob = await response.blob();
      turnTimer.mark('TTS body received');
      if (blob.size < 100) {
        turnTimer.mark('TTS response empty');
        turnTimer.log({ title: '[Turn Timing]' });
        throw new Error('TTS response was empty');
      }

      try {
        await playBlob(blob, effectiveTurnId, turnTimer);
        turnTimer.mark('Speech finished');
        turnTimer.log({ title: '[Turn Timing]' });
      } catch (error) {
        pendingInferencePlayback = {
          blob,
          turnId: effectiveTurnId,
        };
        turnTimer.mark('Audio playback failed');
        turnTimer.log({ title: '[Turn Timing]' });
        throw error instanceof Error
          ? new Error(`Inference audio playback failed: ${error.message}`)
          : new Error('Inference audio playback failed');
      }
    } catch (error) {
      if (!String(error instanceof Error ? error.message : '').includes('TTS failed:')
        && !String(error instanceof Error ? error.message : '').includes('playback failed')) {
        turnTimer.mark('TTS pipeline failed');
        turnTimer.log({ title: '[Turn Timing]' });
      }
      throw error instanceof Error ? error : new Error('TTS failed');
    }
  }

  async function playBlob(blob: Blob, turnId: string | null, turnTimer?: TurnTimer): Promise<void> {
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    if (mode === 'mini') {
      audio.volume = Math.max(0, Math.min(1.2, store.getState().config?.secondaryAudioGain ?? 1));
    }
    audioElement = audio;
    const subtitlesEnabled = mode === 'mini'
      ? store.getState().config?.secondarySubtitleEnabled !== false
      : true;
    if (subtitlesEnabled) {
      subtitles.start(store.getState().currentSpeechText || '', audio);
    } else {
      subtitles.stop();
    }

    const endPlaybackSpan = turnTimer?.span('Audio Playback');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finalize = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        endPlaybackSpan?.();
        callback();
      };

      audio.onended = () => {
        finalize(() => {
          cleanupAudio(objectUrl, audio, turnId);
          resolve();
        });
      };
      audio.onerror = () => {
        finalize(() => {
          turnTimer?.mark('Audio playback error');
          cleanupAudio(objectUrl, audio, turnId);
          reject(new Error('Audio playback failed'));
        });
      };

      audio.play().catch((error) => {
        finalize(() => {
          turnTimer?.mark('Audio playback blocked');
          cleanupAudio(objectUrl, audio, turnId);
          reject(error instanceof Error ? error : new Error('Audio playback failed'));
        });
      });
    });
  }

  async function speakWithBrowserTts(text: string, turnId: string | null, turnTimer?: TurnTimer): Promise<void> {
    const subtitlesEnabled = mode === 'mini'
      ? store.getState().config?.secondarySubtitleEnabled !== false
      : true;
    if (subtitlesEnabled) {
      subtitles.start(text);
    } else {
      subtitles.stop();
    }
    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => {
        turnTimer?.mark('Browser speech ended');
        finishSpeech(turnId);
        resolve();
      };
      utterance.onerror = () => {
        turnTimer?.mark('Browser speech error');
        finishSpeech(turnId);
        reject(new Error('Speech synthesis failed'));
      };
      turnTimer?.mark('Browser speech started');
      speechSynthesis.speak(utterance);
    });
  }

  function getStreamingContext(): Promise<AudioContext> {
    streamingAudioContext ??= new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    return Promise.resolve(streamingAudioContext);
  }

  function playStreamingAudioChunk(audioBase64: string, turnId?: string, actor?: 'main' | 'small', text?: string): void {
    const effectiveTurnId = turnId ?? store.getState().currentTurnId ?? null;
    const effectiveActor = actor ?? (mode === 'mini' ? 'small' : 'main');
    clearPendingEndTimer();
    // A chunk from a different turn ends the old session and silences its audio.
    if (streamSession?.turnId && effectiveTurnId && streamSession.turnId !== effectiveTurnId) {
      endStreamingSession(streamSession.turnId);
    }
    const session = streamSession ?? beginStreamingSession(effectiveTurnId, effectiveActor);
    updateStreamingSubtitle(text || store.getState().currentSpeechText || 'Streaming audio');
    session.addChunk(audioBase64);
  }

  function beginStreamingSession(turnId: string | null, actor?: 'main' | 'small'): StreamingSession {
    lastStreamingBeatIndex = -1;
    const sessionTurnId = turnId ?? store.getState().currentTurnId ?? null;
    const session = createStreamingSession({
      turnId: sessionTurnId,
      getContext: getStreamingContext,
      decode: (context, audioBase64) => {
        const bytes = Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0));
        return context.decodeAudioData(bytes.buffer.slice(0));
      },
      onFinished: () => {
        if (streamSession === session) {
          endStreamingSession(sessionTurnId);
        }
      },
      onChunkScheduled: (_chunk, buffer) => {
        store.setState((current) => pushStreamDebugEntry(current, 'audio_chunk_played', {
          turnId: sessionTurnId ?? current.currentTurnId,
          audioBytes: buffer.length,
          audioDurationSec: buffer.duration,
          ts: Date.now(),
        }));
      },
      onError: (message) => store.appendLog('error', `Stream ${message}`),
      log: (message) => console.log(`[Stream] ${message}`),
    });
    streamSession = session;
    activeSpeechTurnId = sessionTurnId;
    activeSpeechActor = actor ?? (mode === 'mini' ? 'small' : 'main');
    const isLocalBeat = !(mode === 'main' && activeSpeechActor === 'small');
    console.log(`[Stream] session begin | turn=${sessionTurnId} | actor=${activeSpeechActor}`);
    if (isLocalBeat) updatePlaybackState(true, 'Speaking (Stream)');
    emitHeadSpeechState('start', sessionTurnId, activeSpeechActor);
    return session;
  }

  function endStreamingSession(turnId: string | null): void {
    const session = streamSession;
    const effectiveTurnId = turnId ?? session?.turnId ?? store.getState().currentTurnId ?? null;
    if (session) {
      logStreamingTimeline(session.scheduled);
    }
    resetStreamingAudio();
    if (session) {
      finishSpeech(effectiveTurnId);
    }
    // Signal any waiting playTts that streaming is done.
    window.dispatchEvent(new CustomEvent('tubs:tts-stream-done', {
      detail: { turnId: effectiveTurnId },
    }));
  }

  /** Apply expression/head_speech_state when a new beat starts in server-streamed dual-head audio. */
  function applyStreamingBeatExpression(beatIndex: number, actor?: 'main' | 'small'): void {
    const beatMeta = pendingBeatMeta.find((b) => b.index === beatIndex);
    const effectiveActor = actor ?? beatMeta?.actor ?? (mode === 'mini' ? 'small' : 'main');
    const isLocalBeat = !(mode === 'main' && effectiveActor === 'small');

    // Emit head_speech_state for the new actor so mini face syncs
    emitHeadSpeechState('start', streamSession?.turnId ?? null, effectiveActor);
    activeSpeechActor = effectiveActor;

    if (beatMeta?.emotion) {
      lastEmotion = beatMeta.emotion;
    }

    if (isLocalBeat) {
      updatePlaybackState(true, 'Speaking (Stream)');
      const expression = beatMeta?.emotion?.expression ?? 'speaking';
      store.setState((current) => ({
        ...current,
        currentExpression: expression,
        ...(beatMeta?.text ? { currentSpeechText: beatMeta.text, subtitleText: beatMeta.text } : {}),
      }));
    } else {
      // Small beat on main — only update subtitle, not main face
      if (beatMeta?.text) {
        store.setState((current) => ({
          ...current,
          subtitleText: beatMeta.text,
        }));
      }
    }
  }

  function logStreamingTimeline(chunks: readonly ScheduledChunk[]): void {
    if (chunks.length === 0) {
      return;
    }
    const first = chunks[0]!;
    const last = chunks[chunks.length - 1]!;
    const lines = [`[Streaming Audio Timeline] ${chunks.length} chunk(s)`];
    let overlaps = 0;
    chunks.forEach((chunk, i) => {
      const previous = i > 0 ? chunks[i - 1]! : null;
      const gap = previous ? chunk.scheduledAt - (previous.scheduledAt + previous.duration) : 0;
      if (previous && gap < -0.001) overlaps += 1;
      lines.push(`  #${chunk.index} decoded +${((chunk.decodedAt - first.decodedAt) / 1000).toFixed(3)}s | at ${chunk.scheduledAt.toFixed(3)}s | ${chunk.duration.toFixed(3)}s | gap ${previous ? gap.toFixed(3) : '-'}s`);
    });
    if (overlaps > 0) {
      lines.push(`  ! ${overlaps} overlapping chunk(s)`);
    }
    const totalDuration = chunks.reduce((sum, chunk) => sum + chunk.duration, 0);
    lines.push(`  Total audio ${totalDuration.toFixed(3)}s | decode span ${((last.decodedAt - first.decodedAt) / 1000).toFixed(3)}s`);
    console.log(lines.join('\n'));
  }

  function scheduleStreamingEnd(turnId?: string): void {
    if (streamSession && (!turnId || !streamSession.turnId || streamSession.turnId === turnId)) {
      streamSession.markEnd();
      return;
    }
    // speak_end with no audio (TTS failed, nothing to say): release a waiting playTts.
    clearPendingEndTimer();
    pendingEndTimer = window.setTimeout(() => {
      pendingEndTimer = null;
      if (!streamSession) {
        endStreamingSession(turnId ?? null);
      }
    }, STREAMING_GAP_GRACE_MS);
  }

  function updateStreamingSubtitle(text: string): void {
    const normalized = String(text || '').trim();
    if (!normalized || normalized === streamingSubtitleText) {
      return;
    }
    streamingSubtitleText = normalized;
    const subtitlesEnabled = mode === 'mini'
      ? store.getState().config?.secondarySubtitleEnabled !== false
      : true;
    if (subtitlesEnabled) {
      subtitles.streamSentence(normalized);
    } else {
      subtitles.stop();
    }
  }

  function clearPendingEndTimer(): void {
    if (pendingEndTimer == null) {
      return;
    }
    window.clearTimeout(pendingEndTimer);
    pendingEndTimer = null;
  }

  function cleanupAudio(objectUrl: string, audio: HTMLAudioElement, turnId: string | null): void {
    if (audioElement === audio) {
      audioElement = null;
    }
    URL.revokeObjectURL(objectUrl);
    finishSpeech(turnId);
  }

  function finishSpeech(turnId: string | null): void {
    clearSpeechSafetyTimer();
    const endActor = activeSpeechActor;
    const wasLocalBeat = !(mode === 'main' && endActor === 'small');
    if (turnId == null || activeSpeechTurnId === turnId) {
      activeSpeechTurnId = null;
      activeSpeechActor = null;
    }
    if (wasLocalBeat) updatePlaybackState(false, 'Idle');
    subtitles.finish();
    emitHeadSpeechState('end', turnId, endActor ?? undefined);
    scheduleSubtitleClear();
    const settledExpression = lastEmotion?.expression ?? null;
    window.setTimeout(() => {
      const state = store.getState();
      if (state.audioPlaying || state.sleeping) {
        return;
      }
      if (settledExpression && (state.currentExpression === 'speaking' || state.currentExpression === settledExpression)) {
        store.setState((current) => ({
          ...current,
          currentExpression: settledExpression,
        }));
        return;
      }
      if (state.currentExpression !== 'speaking') {
        return;
      }
      store.setState((current) => ({
        ...current,
        currentExpression: current.sleeping ? 'sleep' : 'idle',
      }));
    }, POST_SPEECH_IDLE_DELAY_MS);
  }

  function scheduleSubtitleClear(): void {
    clearSubtitleClearTimer();
    subtitleClearTimer = window.setTimeout(() => {
      subtitleClearTimer = null;
      const state = store.getState();
      if (state.audioPlaying) {
        return;
      }
      subtitles.stop();
      store.setState((current) => ({
        ...current,
        subtitleText: '',
        currentSpeechText: '',
      }));
    }, SUBTITLE_CLEAR_DELAY_MS);
  }

  function clearSubtitleClearTimer(): void {
    if (subtitleClearTimer != null) {
      window.clearTimeout(subtitleClearTimer);
      subtitleClearTimer = null;
    }
  }

  function updatePlaybackState(speaking: boolean, listenState: string): void {
    store.setState((current) => ({
      ...current,
      audioPlaying: speaking,
      listenState,
    }));
  }

  function emitHeadSpeechState(state: 'start' | 'end', turnId: string | null, actorOverride?: 'main' | 'small'): void {
    const detail = {
      actor: actorOverride ?? (mode === 'mini' ? 'small' : 'main'),
      state,
      turnId,
      ts: Date.now(),
    };
    window.dispatchEvent(new CustomEvent('tubs:head-speech-state', {
      detail,
    }));
    window.dispatchEvent(new CustomEvent('tubs:any-head-speech-state', {
      detail,
    }));
  }

  /** Silences scheduled streaming audio and resets chunk ordering for the next session. */
  function resetStreamingAudio(): void {
    clearPendingEndTimer();
    streamSession?.stop();
    streamSession = null;
    streamingSubtitleText = '';
    pendingBeatMeta = [];
    lastStreamingBeatIndex = -1;
  }

  function stopAllPlayback(): void {
    queue.length = 0;
    cancelQueueRun();
    lastEmotion = null;
    activeQueueTurnId = null;
    activeSpeechTurnId = null;
    pendingInferencePlayback = null;
    clearSpeechSafetyTimer();
    resetStreamingAudio();
    remoteActorSpeaking = false;
    remoteActorSpeakingUntil = 0;
    clearReactionResetTimer();
    if (audioElement) {
      audioElement.pause();
      audioElement.src = '';
      audioElement = null;
    }
    speechSynthesis.cancel();
    subtitles.stop();
    finishSpeech(store.getState().currentTurnId);
  }

  function bindStopSpeechHandler(): void {
    if (stopSpeechHandler) {
      return;
    }
    stopSpeechHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ turnId?: string | null }>).detail;
      interruptTurn(detail?.turnId ?? null);
    };
    window.addEventListener('tubs:stop-speech', stopSpeechHandler as EventListener);
  }

  function detachStopSpeechHandler(): void {
    if (!stopSpeechHandler) {
      return;
    }
    window.removeEventListener('tubs:stop-speech', stopSpeechHandler as EventListener);
    stopSpeechHandler = null;
  }

  function bindInferenceUnlockHandlers(): void {
    const replayPendingInferenceAudio = () => {
      const pending = pendingInferencePlayback;
      if (!pending || audioElement || disposed) {
        return;
      }

      pendingInferencePlayback = null;
      void playBlob(pending.blob, pending.turnId).catch((error) => {
        pendingInferencePlayback = pending;
        store.appendLog(
          'error',
          error instanceof Error
            ? `Inference audio still blocked: ${error.message}`
            : 'Inference audio still blocked',
        );
      });
    };

    window.addEventListener('pointerdown', replayPendingInferenceAudio);
    window.addEventListener('keydown', replayPendingInferenceAudio);
  }

  function applyBeatVisuals(text: string, emotion: TurnEmotion | null | undefined, speaking: boolean): void {
    const nextReactionEmoji = !speaking ? (emotion?.emoji ?? '') : '';
    store.setState((current) => ({
      ...current,
      currentSpeechText: text,
      subtitleText: text,
      currentReactionEmoji: nextReactionEmoji,
      currentExpression: emotion?.expression ?? (speaking ? 'speaking' : current.currentExpression),
    }));
    if (!speaking) {
      clearReactionResetTimer();
      if (nextReactionEmoji) {
        reactionResetTimer = window.setTimeout(() => {
          reactionResetTimer = null;
          store.setState((current) => ({
            ...current,
            currentReactionEmoji: '',
          }));
        }, 1100);
      }
    }
  }

  function handleRemoteHeadSpeechState(message: Extract<WsServerMessage, { type: 'head_speech_state' }>): void {
    const localActor = mode === 'mini' ? 'small' : 'main';
    const isLocalEcho = message.actor === localActor
      && activeSpeechActor === localActor
      && (
        !message.turnId
        || activeSpeechTurnId === message.turnId
        || activeQueueTurnId === message.turnId
      );

    // If another window signals it is speaking for our actor,
    // suppress our own TTS to avoid double playback.
    // In main mode, head_speech_state for actor 'main' is our own echo — ignore it.
    if (message.actor === localActor) {
      if (isLocalEcho) {
        return;
      }
      if (mode === 'mini' && message.state === 'start') {
        // Only mini should defer to another window claiming its actor
        if (store.getState().audioPlaying) {
          stopAllPlayback();
        }
        demoteQueueSpeakToReact();
      }
      return;
    }

    if (message.state === 'start') {
      window.dispatchEvent(new CustomEvent('tubs:any-head-speech-state', {
        detail: {
          actor: message.actor,
          state: message.state,
          turnId: message.turnId ?? null,
          ts: message.ts,
          durationMs: message.durationMs,
        },
      }));
      markRemoteActorSpeaking(true, message.ts, message.durationMs);
      return;
    }
    window.dispatchEvent(new CustomEvent('tubs:any-head-speech-state', {
      detail: {
        actor: message.actor,
        state: message.state,
        turnId: message.turnId ?? null,
        ts: message.ts,
        durationMs: message.durationMs,
      },
    }));
    markRemoteActorSpeaking(false, message.ts);
    // A queue pass waiting for the other head re-checks right away.
    queueRun?.wake();
  }

  function demoteQueueSpeakToReact(): void {
    const visualOnly: SpeakQueueItem[] = [];
    for (const item of queue) {
      if (item.type === 'speak') {
        visualOnly.push({
          ...item,
          type: 'react',
          delayMs: item.delayMs ?? REACTION_PAUSE_MS,
        });
      } else {
        visualOnly.push(item);
      }
    }
    queue.length = 0;
    queue.push(...visualOnly);
    if (visualOnly.length > 0) {
      processQueue();
    }
  }

  function markRemoteActorSpeaking(isSpeaking: boolean, ts = Date.now(), durationMs?: number): void {
    remoteActorSpeaking = Boolean(isSpeaking);
    if (!remoteActorSpeaking) {
      remoteActorSpeakingUntil = 0;
      return;
    }
    const timeoutMs = durationMs && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs + 500
      : REMOTE_SPEECH_STALE_MS;
    remoteActorSpeakingUntil = ts + timeoutMs;
  }

  function isRemoteActorSpeakingNow(): boolean {
    if (!remoteActorSpeaking) {
      return false;
    }
    if (Date.now() > remoteActorSpeakingUntil) {
      remoteActorSpeaking = false;
      remoteActorSpeakingUntil = 0;
      return false;
    }
    return true;
  }

  /**
   * Two-head mode without server streaming: wait until the other head has
   * started and finished its line (or never started within the limit).
   */
  async function waitForRemoteActor(run: QueueRun): Promise<void> {
    const startedAt = Date.now();
    let sawStart = false;
    while (!run.cancelled) {
      const remoteSpeaking = isRemoteActorSpeakingNow();
      sawStart ||= remoteSpeaking;
      const timedOut = !sawStart && Date.now() - startedAt >= REMOTE_WAIT_MAX_MS;
      if ((sawStart && !remoteSpeaking) || timedOut) {
        return;
      }
      await run.pause(REMOTE_WAIT_POLL_MS, { wakeable: true });
    }
  }

  function clearReactionResetTimer(): void {
    if (reactionResetTimer == null) {
      return;
    }
    window.clearTimeout(reactionResetTimer);
    reactionResetTimer = null;
  }

  function startSpeechSafetyTimer(): void {
    clearSpeechSafetyTimer();
    speechSafetyTimer = window.setTimeout(() => {
      speechSafetyTimer = null;
      store.appendLog('error', 'Speech safety timeout; forcing queue advance');
      stopAllPlayback();
      processQueue();
    }, SPEECH_SAFETY_MAX_MS);
  }

  function clearSpeechSafetyTimer(): void {
    if (speechSafetyTimer == null) {
      return;
    }
    window.clearTimeout(speechSafetyTimer);
    speechSafetyTimer = null;
  }

  function rememberInterruptedTurn(turnId: string | null): void {
    if (!turnId) return;
    interruptedTurnIds.add(turnId);
    if (interruptedTurnIds.size > 32) {
      const oldest = interruptedTurnIds.values().next().value;
      if (oldest !== undefined) interruptedTurnIds.delete(oldest);
    }
  }

  function interruptTurn(turnId: string | null): void {
    const targetTurnId = turnId ?? null;
    const beforeLength = queue.length;
    if (targetTurnId) {
      const remaining = queue.filter((item) => item.turnId == null || item.turnId !== targetTurnId);
      queue.length = 0;
      queue.push(...remaining);
    } else {
      queue.length = 0;
    }

    const shouldStopActive =
      targetTurnId == null
      || activeQueueTurnId === targetTurnId
      || activeSpeechTurnId === targetTurnId
      || streamSession?.turnId === targetTurnId;

    if (shouldStopActive) {
      const stoppedTurnIds = targetTurnId ? [targetTurnId] : [activeQueueTurnId, activeSpeechTurnId, streamSession?.turnId ?? null];
      for (const id of stoppedTurnIds) {
        rememberInterruptedTurn(id);
      }
      cancelQueueRun();
      lastEmotion = null;
      activeQueueTurnId = null;
      pendingInferencePlayback = null;
      clearSpeechSafetyTimer();
      resetStreamingAudio();
      activeSpeechTurnId = null;
      remoteActorSpeaking = false;
      remoteActorSpeakingUntil = 0;
      clearReactionResetTimer();
      if (audioElement) {
        audioElement.pause();
        audioElement.src = '';
        audioElement = null;
      }
      speechSynthesis.cancel();
      subtitles.stop();
      store.setState((current) => ({
        ...current,
        currentSpeechText: '',
        subtitleText: '',
        currentReactionEmoji: '',
      }));
      updatePlaybackState(false, 'Interrupted');
      if (store.getState().currentTurnId === targetTurnId || targetTurnId == null) {
        emitHeadSpeechState('end', targetTurnId ?? store.getState().currentTurnId);
      }
    }

    if (beforeLength > 0 || shouldStopActive) {
      window.setTimeout(() => {
        processQueue();
      }, 0);
    }
  }
}

async function readTtsErrorDetail(response: Response): Promise<string> {
  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json() as { error?: string };
      return String(payload?.error || '').trim();
    }
    return (await response.text()).trim();
  } catch {
    return '';
  }
}
