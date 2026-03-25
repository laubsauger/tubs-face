import type { TurnBeat, TurnEmotion } from '../../shared/contracts/turn-script.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import type { AppStore } from '../state/app-state.js';
import { pushStreamDebugEntry } from '../chat/state.js';
import { buildLocalTurnTimeline } from '../turn-script.js';
import { createTurnTimer, type TurnTimer } from '../turn-timing.js';
import { createSubtitleController, type SubtitleController } from '../ui/subtitles.js';

interface SpeakQueueItem {
  type: 'speak' | 'wait' | 'react' | 'wait_remote';
  actor?: 'main' | 'small';
  text?: string;
  delayMs?: number;
  emotion?: TurnEmotion | null;
  turnId?: string | null;
  waitRemoteStartedAt?: number;
  waitRemoteSawStart?: boolean;
}

const INTER_UTTERANCE_PAUSE_MS = 220;
const REACTION_PAUSE_MS = 420;
const POST_SPEECH_IDLE_DELAY_MS = 350;
const SUBTITLE_CLEAR_DELAY_MS = 4000;
const REMOTE_SPEECH_STALE_MS = 20_000;
const REMOTE_WAIT_POLL_MS = 90;
const REMOTE_WAIT_MAX_MS = 45_000;
const SPEECH_SAFETY_MAX_MS = 60_000;
const STREAMING_GAP_GRACE_MS = 280;
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
  let processing = false;
  let disposed = false;
  let pendingInferencePlayback: { blob: Blob; turnId: string | null } | null = null;
  let streamingAudioContext: AudioContext | null = null;
  let streamingNextStartTime = 0;
  let streamingActiveNodes = 0;
  let streamingFinalizeTimer: number | null = null;
  let streamingSessionActive = false;
  let streamingSessionTurnId: string | null = null;
  let streamingSpeakEndReceived = false;
  let streamingChunkLog: Array<{
    idx: number;
    decodedAt: number;
    scheduledAt: number;
    duration: number;
    ctxTime: number;
    activeNodes: number;
  }> = [];
  let streamingSubtitleText = '';
  let activeSpeechTurnId: string | null = null;
  let activeSpeechActor: 'main' | 'small' | null = null;
  let activeQueueTurnId: string | null = null;
  let subtitles: SubtitleController = createSubtitleController(null);
  let remoteActorSpeaking = false;
  let remoteActorSpeakingUntil = 0;
  let remoteWaitTimer: number | null = null;
  let reactionResetTimer: number | null = null;
  let mainHandlingOurBeats = false;
  let mainWindowLastSeenAt = 0;
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

  // Decoded buffers waiting to be scheduled, keyed by chunk index.
  // Chunks decode in parallel but schedule in order.
  let pendingBuffers: Map<number, { buffer: AudioBuffer; turnId: string | null }> = new Map();
  let nextScheduleIdx = 0;
  let chunkReceiveCount = 0;

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
          // When targeting a specific actor (spectator), skip chunks for other actors
          if (targetActor && message.actor && message.actor !== targetActor) {
            return;
          }
          try {
            console.log(`[STREAM-v2] chunk_in #${message.chunkIndex ?? '?'} | len=${message.audio?.length ?? 0} | turn=${message.turnId ?? '?'} | actor=${message.actor ?? '-'} | beat=${message.beatIndex ?? '-'} | session=${streamingSessionActive} | rxCount=${chunkReceiveCount} | t=${Date.now()}`);
            // Sync expressions when beat changes (server-streamed dual-head)
            if (message.beatIndex != null && message.beatIndex !== lastStreamingBeatIndex) {
              lastStreamingBeatIndex = message.beatIndex;
              applyStreamingBeatExpression(message.beatIndex, message.actor);
            }
            playStreamingAudioChunk(message.audio, message.turnId, message.actor);
          } catch (err) {
            console.error('[Stream] playStreamingAudioChunk THREW:', err);
          }
          return;
        case 'speak_end':
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

    // In main mode with dual-head, play ALL actors' beats (small uses secondary voice)
    if (mode === 'main' && isDualHead) {
      // When server TTS streaming is enabled, audio arrives via audio_chunk
      // messages — skip speak beats here (they'd cause double playback).
      // Store beat metadata so audio_chunk handler can sync expressions.
      if (serverStreaming) {
        pendingBeatMeta = beats.map((beat, i) => ({
          index: i,
          actor: (beat.actor === 'small' ? 'small' : 'main') as 'main' | 'small',
          action: beat.action,
          emotion: beat.emotion ?? null,
          text: beat.text ?? '',
        }));
      }
      for (const beat of beats) {
        if (!beat) continue;
        const beatActor = beat.actor === 'small' ? 'small' : 'main';
        if (beat.action === 'speak' && beat.text?.trim()) {
          if (serverStreaming) continue; // audio comes via audio_chunk
          queue.push({
            type: 'speak',
            actor: beatActor,
            text: beat.text.trim(),
            ...(beat.emotion ? { emotion: beat.emotion } : {}),
            ...(turnId !== undefined ? { turnId } : {}),
          });
        } else if (beat.action === 'react') {
          queue.push({
            type: 'react',
            actor: beatActor,
            text: beat.text ?? '',
            ...(beat.emotion ? { emotion: beat.emotion } : {}),
            ...(beat.delayMs !== undefined ? { delayMs: Math.max(120, beat.delayMs) } : {}),
            ...(turnId !== undefined ? { turnId } : {}),
          });
        } else if (beat.action === 'wait' && beat.delayMs) {
          queue.push({
            type: 'wait',
            delayMs: Math.max(120, Math.min(8000, beat.delayMs)),
            ...(turnId !== undefined ? { turnId } : {}),
          });
        }
      }
      processQueue();
      return;
    }

    const actor = mode === 'mini' ? 'small' : 'main';
    const timeline = buildLocalTurnTimeline(beats, actor, { includeRemoteWait: false });
    // When server TTS streaming is enabled and we're in mini mode, audio arrives
    // via audio_chunk — skip speak beats to avoid trying to generate TTS we can't send
    // (spectators have no WS sender wired up, so tts_request events go nowhere).
    const suppressTts = mode === 'mini' && (isMainWindowActive() || serverStreaming);
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

  function processQueue(): void {
    clearSpeechSafetyTimer();
    if (processing || disposed) {
      return;
    }

    if (queue.length === 0) {
      lastEmotion = null;
      return;
    }

    const item = queue.shift();
    if (!item) {
      return;
    }
    activeQueueTurnId = item.turnId ?? null;

    if (item.type === 'wait') {
      processing = true;
      if (mode === 'mini') {
        subtitles.stop();
      }
      window.setTimeout(() => {
        activeQueueTurnId = null;
        processing = false;
        processQueue();
      }, item.delayMs ?? 320);
      return;
    }

    if (item.type === 'wait_remote') {
      processing = true;
      if (mode === 'mini') {
        subtitles.stop();
      }
      if (waitForRemoteActor(item)) {
        activeQueueTurnId = null;
        processing = false;
        processQueue();
      }
      return;
    }

    if (item.type === 'react') {
      processing = true;
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
      window.setTimeout(() => {
        store.setState((current) => ({
          ...current,
          currentReactionEmoji: '',
          currentExpression: current.sleeping ? 'sleep' : 'idle',
        }));
        activeQueueTurnId = null;
        processing = false;
        processQueue();
      }, item.delayMs ?? REACTION_PAUSE_MS);
      return;
    }

    if (!item.text) {
      activeQueueTurnId = null;
      processQueue();
      return;
    }

    processing = true;
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
    void playTts(item.text, item.turnId, item.actor)
      .catch((error) => {
        store.appendLog('error', error instanceof Error ? error.message : 'Speech playback failed');
        finishSpeech(item.turnId ?? null);
      })
      .finally(() => {
        window.setTimeout(() => {
          activeQueueTurnId = null;
          processing = false;
          processQueue();
        }, INTER_UTTERANCE_PAUSE_MS);
      });
  }

  async function playTts(text: string, turnId?: string | null, actor?: 'main' | 'small'): Promise<void> {
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

      // Wait for streaming playback to complete via speak_end
      await new Promise<void>((resolve) => {
        const onStreamDone = (event: Event) => {
          const msg = (event as CustomEvent<{ turnId?: string }>).detail;
          console.log(`[Stream] tts-stream-done event | eventTurnId=${msg?.turnId ?? '?'} | waitingFor=${effectiveTurnId}`);
          if (!effectiveTurnId || msg?.turnId === effectiveTurnId) {
            window.removeEventListener('tubs:tts-stream-done', onStreamDone as EventListener);
            resolve();
          }
        };
        window.addEventListener('tubs:tts-stream-done', onStreamDone as EventListener);
        // Safety timeout
        setTimeout(() => {
          console.warn(`[Stream] WS TTS safety timeout (${SPEECH_SAFETY_MAX_MS}ms) — forcing resolve | turnId=${effectiveTurnId}`);
          window.removeEventListener('tubs:tts-stream-done', onStreamDone as EventListener);
          resolve();
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

  function playStreamingAudioChunk(audioBase64: string, turnId?: string, actor?: 'main' | 'small'): void {
    const idx = chunkReceiveCount++;
    const effectiveTurnId = turnId ?? store.getState().currentTurnId ?? null;
    const effectiveActor = actor ?? (mode === 'mini' ? 'small' : 'main');

    clearStreamingFinalizeTimer();

    // Start session immediately on first chunk (synchronous, before any async work)
    if (streamingSessionActive && streamingSessionTurnId && effectiveTurnId && streamingSessionTurnId !== effectiveTurnId) {
      endStreamingSession(streamingSessionTurnId);
    }
    if (!streamingSessionActive) {
      beginStreamingSession(effectiveTurnId, effectiveActor);
    }
    updateStreamingSubtitle(store.getState().currentSpeechText || 'Streaming audio');

    // Fire-and-forget decode — scheduleReadyChunks() handles ordering
    void decodeAndQueue(audioBase64, idx, effectiveTurnId).catch((error) => {
      store.appendLog('error', `Chunk #${idx} decode failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  }

  async function decodeAndQueue(audioBase64: string, idx: number, turnId: string | null): Promise<void> {
    if (!streamingAudioContext) {
      streamingAudioContext = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (streamingAudioContext.state === 'suspended') {
      await streamingAudioContext.resume();
    }

    const bytes = Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0));
    const audioBuffer = await streamingAudioContext.decodeAudioData(bytes.buffer.slice(0));

    console.log(`[Stream] chunk #${idx} decoded | duration=${audioBuffer.duration.toFixed(3)}s | bytes=${bytes.byteLength}`);

    pendingBuffers.set(idx, { buffer: audioBuffer, turnId });
    scheduleReadyChunks();
  }

  /** Schedule decoded buffers in order. Only advances when the next index is ready. */
  function scheduleReadyChunks(): void {
    if (!streamingAudioContext) return;

    while (pendingBuffers.has(nextScheduleIdx)) {
      const entry = pendingBuffers.get(nextScheduleIdx)!;
      pendingBuffers.delete(nextScheduleIdx);
      const chunkIdx = nextScheduleIdx;
      nextScheduleIdx++;

      const now = streamingAudioContext.currentTime;
      if (streamingNextStartTime < now) {
        streamingNextStartTime = now;
      }

      const source = streamingAudioContext.createBufferSource();
      source.buffer = entry.buffer;
      source.connect(streamingAudioContext.destination);

      const scheduledAt = streamingNextStartTime;
      streamingActiveNodes += 1;
      source.start(streamingNextStartTime);
      streamingNextStartTime += entry.buffer.duration;

      console.log(`[Stream] chunk #${chunkIdx} scheduled | at=${scheduledAt.toFixed(3)} | dur=${entry.buffer.duration.toFixed(3)} | next=${streamingNextStartTime.toFixed(3)} | ctxNow=${now.toFixed(3)} | active=${streamingActiveNodes}`);

      streamingChunkLog.push({
        idx: chunkIdx,
        decodedAt: performance.now(),
        scheduledAt,
        duration: entry.buffer.duration,
        ctxTime: now,
        activeNodes: streamingActiveNodes,
      });

      store.setState((current) => pushStreamDebugEntry(current, 'audio_chunk_played', {
        turnId: entry.turnId ?? current.currentTurnId,
        audioBytes: entry.buffer.length,
        audioDurationSec: entry.buffer.duration,
        ts: Date.now(),
      }));

      let chunkEnded = false;
      const onChunkEnd = () => {
        if (chunkEnded) return;
        chunkEnded = true;
        streamingActiveNodes = Math.max(0, streamingActiveNodes - 1);
        console.log(`[Stream] chunk #${chunkIdx} ended | remaining=${streamingActiveNodes} | speakEndReceived=${streamingSpeakEndReceived}`);
        if (streamingActiveNodes === 0) {
          if (streamingSpeakEndReceived) {
            console.log(`[Stream] last chunk done after speak_end — finalizing`);
            endStreamingSession(entry.turnId);
          } else {
            // All audio finished but no speak_end yet — schedule a grace period
            // in case speak_end is in-flight, then force-finalize
            console.log(`[Stream] all audio done but no speak_end — scheduling grace finalize`);
            streamingFinalizeAttempts = 0;
            tryFinalizeStreaming(entry.turnId);
          }
        }
      };
      source.onended = onChunkEnd;
      // Safety: if the AudioContext is suspended (e.g. iOS autoplay policy),
      // onended will never fire. Set a fallback timeout that accounts for both
      // the wait until the chunk is scheduled to start AND its playback duration.
      const waitUntilStartMs = Math.max(0, (scheduledAt - now) * 1000);
      const safetyMs = waitUntilStartMs + entry.buffer.duration * 1000 + 3000;
      window.setTimeout(() => {
        if (!chunkEnded) {
          console.warn(`[Stream] chunk #${chunkIdx} safety timeout (${safetyMs.toFixed(0)}ms) — onended never fired, ctx.state=${streamingAudioContext?.state ?? '?'}`);
          onChunkEnd();
        }
      }, safetyMs);
    }
  }

  function beginStreamingSession(turnId: string | null, actor?: 'main' | 'small'): void {
    if (streamingSessionActive) {
      return;
    }
    streamingSessionActive = true;
    streamingSpeakEndReceived = false;
    streamingChunkLog = [];
    lastStreamingBeatIndex = -1;
    // Don't reset pendingBuffers/nextScheduleIdx/chunkReceiveCount here —
    // the first chunk already incremented chunkReceiveCount before calling us.
    // These are reset in endStreamingSession/stopAllPlayback instead.
    streamingSessionTurnId = turnId ?? store.getState().currentTurnId ?? null;
    activeSpeechTurnId = streamingSessionTurnId;
    activeSpeechActor = actor ?? (mode === 'mini' ? 'small' : 'main');
    const isLocalBeat = !(mode === 'main' && activeSpeechActor === 'small');
    console.log(`[Stream] session begin | turn=${streamingSessionTurnId} | actor=${activeSpeechActor} | ctxTime=${streamingAudioContext?.currentTime?.toFixed(3) ?? '?'}`);
    if (isLocalBeat) updatePlaybackState(true, 'Speaking (Stream)');
    emitHeadSpeechState('start', streamingSessionTurnId, activeSpeechActor);
  }

  function endStreamingSession(turnId: string | null): void {
    clearStreamingFinalizeTimer();
    if (!streamingSessionActive) {
      console.log(`[Stream] endStreamingSession called but no active session — dispatching tts-stream-done anyway`);
      streamingActiveNodes = 0;
      streamingNextStartTime = 0;
      streamingSubtitleText = '';
      streamingSessionTurnId = null;
      // Still dispatch done event so playTts doesn't hang for 60s
      const effectiveTurnId = turnId ?? store.getState().currentTurnId ?? null;
      window.dispatchEvent(new CustomEvent('tubs:tts-stream-done', {
        detail: { turnId: effectiveTurnId },
      }));
      return;
    }

    logStreamingTimeline();

    const effectiveTurnId = turnId ?? streamingSessionTurnId ?? store.getState().currentTurnId ?? null;
    streamingSessionActive = false;
    streamingSpeakEndReceived = false;
    streamingActiveNodes = 0;
    streamingNextStartTime = 0;
    streamingSubtitleText = '';
    streamingSessionTurnId = null;
    pendingBuffers = new Map();
    nextScheduleIdx = 0;
    chunkReceiveCount = 0;
    pendingBeatMeta = [];
    lastStreamingBeatIndex = -1;
    finishSpeech(effectiveTurnId);

    // Signal any waiting playTts that streaming is done
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
    emitHeadSpeechState('start', streamingSessionTurnId, effectiveActor);
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

  function logStreamingTimeline(): void {
    if (streamingChunkLog.length === 0) {
      return;
    }

    const chunks = streamingChunkLog.slice();
    streamingChunkLog = [];

    const first = chunks[0]!;
    const last = chunks[chunks.length - 1]!;
    const firstDecoded = first.decodedAt;
    const lines: string[] = [];
    lines.push(`[Streaming Audio Timeline] ${chunks.length} chunk(s)`);
    lines.push(`  #  | Decoded    | Sched @    | Duration  | Ctx Time   | Nodes | Gap`);
    lines.push(`-----+------------+------------+-----------+------------+-------+--------`);

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const decodedRel = ((c.decodedAt - firstDecoded) / 1000).toFixed(3);
      const schedAt = c.scheduledAt.toFixed(3);
      const dur = c.duration.toFixed(3);
      const ctx = c.ctxTime.toFixed(3);
      const prev = i > 0 ? chunks[i - 1]! : null;
      const gap = prev
        ? (c.scheduledAt - (prev.scheduledAt + prev.duration)).toFixed(3)
        : '—';
      lines.push(
        `  ${String(c.idx).padStart(2)} | ${decodedRel.padStart(10)}s | ${schedAt.padStart(10)}s | ${dur.padStart(9)}s | ${ctx.padStart(10)}s | ${String(c.activeNodes).padStart(5)} | ${String(gap).padStart(6)}s`,
      );
    }

    // Check for overlaps: any chunk scheduled before previous chunk ends?
    let overlaps = 0;
    let allStartAtSameTime = true;
    for (let i = 1; i < chunks.length; i++) {
      const cur = chunks[i]!;
      const prev = chunks[i - 1]!;
      const prevEnd = prev.scheduledAt + prev.duration;
      if (cur.scheduledAt < prevEnd - 0.001) {
        overlaps++;
      }
      if (Math.abs(cur.scheduledAt - first.scheduledAt) > 0.01) {
        allStartAtSameTime = false;
      }
    }
    if (overlaps > 0) {
      lines.push(`  ⚠ ${overlaps} overlapping chunk(s) detected!`);
    }
    if (allStartAtSameTime && chunks.length > 1) {
      lines.push(`  ⚠ All chunks scheduled at same time — serialization broken!`);
    }

    const totalDuration = chunks.reduce((sum, c) => sum + c.duration, 0);
    const wallTime = (last.decodedAt - firstDecoded) / 1000;
    lines.push(`  Total audio: ${totalDuration.toFixed(3)}s | Wall decode time: ${wallTime.toFixed(3)}s`);

    console.log(lines.join('\n'));
  }

  function scheduleStreamingEnd(turnId?: string): void {
    streamingSpeakEndReceived = true;
    streamingFinalizeAttempts = 0;
    const pendingDecodes = chunkReceiveCount - nextScheduleIdx;
    console.log(`[Stream] speak_end received | activeNodes=${streamingActiveNodes} | pendingDecodes=${pendingDecodes} | sessionActive=${streamingSessionActive} | ctxTime=${streamingAudioContext?.currentTime?.toFixed(3) ?? '?'} | nextStart=${streamingNextStartTime.toFixed(3)}`);
    tryFinalizeStreaming(turnId ?? null);
  }

  let streamingFinalizeAttempts = 0;
  const FINALIZE_MAX_ATTEMPTS = 40; // ~40 * 280ms ≈ 11s hard limit

  function tryFinalizeStreaming(turnId: string | null): void {
    clearStreamingFinalizeTimer();
    streamingFinalizeTimer = window.setTimeout(() => {
      streamingFinalizeTimer = null;
      streamingFinalizeAttempts += 1;

      // Hard cap: force-end after max attempts regardless of pending state
      if (streamingFinalizeAttempts >= FINALIZE_MAX_ATTEMPTS) {
        const pendingDecodes = chunkReceiveCount - nextScheduleIdx;
        console.warn(`[Stream] forcing session end after ${streamingFinalizeAttempts} attempts | activeNodes=${streamingActiveNodes} | pendingDecodes=${pendingDecodes}`);
        endStreamingSession(turnId);
        return;
      }

      const pendingDecodes = chunkReceiveCount - nextScheduleIdx;
      if (pendingDecodes > 0) {
        console.log(`[Stream] ${pendingDecodes} chunk(s) still decoding — retrying finalize (attempt ${streamingFinalizeAttempts})`);
        tryFinalizeStreaming(turnId);
        return;
      }
      if (streamingActiveNodes > 0) {
        console.log(`[Stream] ${streamingActiveNodes} node(s) still playing — retrying (attempt ${streamingFinalizeAttempts})`);
        tryFinalizeStreaming(turnId);
        return;
      }
      console.log(`[Stream] finalizing session`);
      endStreamingSession(turnId);
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

  function clearStreamingFinalizeTimer(): void {
    if (streamingFinalizeTimer == null) {
      return;
    }
    window.clearTimeout(streamingFinalizeTimer);
    streamingFinalizeTimer = null;
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
    window.dispatchEvent(new CustomEvent('tubs:head-speech-state', {
      detail: {
        actor: actorOverride ?? (mode === 'mini' ? 'small' : 'main'),
        state,
        turnId,
        ts: Date.now(),
      },
    }));
  }

  function stopAllPlayback(): void {
    queue.length = 0;
    processing = false;
    lastEmotion = null;
    activeQueueTurnId = null;
    activeSpeechTurnId = null;
    pendingInferencePlayback = null;
    clearSpeechSafetyTimer();
    clearRemoteWaitTimer();
    clearStreamingFinalizeTimer();
    streamingActiveNodes = 0;
    streamingNextStartTime = 0;
    streamingSessionActive = false;
    streamingSpeakEndReceived = false;
    streamingSessionTurnId = null;
    streamingSubtitleText = '';
    pendingBuffers = new Map();
    nextScheduleIdx = 0;
    chunkReceiveCount = 0;
    pendingBeatMeta = [];
    lastStreamingBeatIndex = -1;
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

  function isMainWindowActive(): boolean {
    return mode === 'mini' && mainWindowLastSeenAt > 0 && (Date.now() - mainWindowLastSeenAt) < 60_000;
  }

  function handleRemoteHeadSpeechState(message: Extract<WsServerMessage, { type: 'head_speech_state' }>): void {
    const localActor = mode === 'mini' ? 'small' : 'main';

    // Track main window liveness from any head_speech_state it sends
    if (mode === 'mini' && (message.actor === 'main' || message.actor === 'small')) {
      mainWindowLastSeenAt = Date.now();
      mainHandlingOurBeats = true;
    }

    // If another window signals it is speaking for our actor,
    // suppress our own TTS to avoid double playback.
    // In main mode, head_speech_state for actor 'main' is our own echo — ignore it.
    if (message.actor === localActor) {
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
      markRemoteActorSpeaking(true, message.ts, message.durationMs);
      return;
    }
    markRemoteActorSpeaking(false, message.ts);
    if (!store.getState().audioPlaying && queue.length > 0) {
      clearRemoteWaitTimer();
      window.setTimeout(() => {
        processQueue();
      }, 0);
    }
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
    if (!processing && visualOnly.length > 0) {
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

  function waitForRemoteActor(item: SpeakQueueItem): boolean {
    const now = Date.now();
    if (!item.waitRemoteStartedAt) {
      item.waitRemoteStartedAt = now;
      item.waitRemoteSawStart = false;
    }
    const remoteSpeaking = isRemoteActorSpeakingNow();
    if (remoteSpeaking) {
      item.waitRemoteSawStart = true;
    }
    const elapsed = now - item.waitRemoteStartedAt;
    const timedOut = !item.waitRemoteSawStart && elapsed >= REMOTE_WAIT_MAX_MS;
    const done = (item.waitRemoteSawStart && !remoteSpeaking) || timedOut;
    if (done) {
      return true;
    }
    queue.unshift(item);
    clearRemoteWaitTimer();
    remoteWaitTimer = window.setTimeout(() => {
      remoteWaitTimer = null;
      activeQueueTurnId = null;
      processing = false;
      processQueue();
    }, REMOTE_WAIT_POLL_MS);
    return false;
  }

  function clearRemoteWaitTimer(): void {
    if (remoteWaitTimer == null) {
      return;
    }
    window.clearTimeout(remoteWaitTimer);
    remoteWaitTimer = null;
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
      || streamingSessionTurnId === targetTurnId;

    if (shouldStopActive) {
      processing = false;
      lastEmotion = null;
      activeQueueTurnId = null;
      pendingInferencePlayback = null;
      clearSpeechSafetyTimer();
      clearRemoteWaitTimer();
      clearStreamingFinalizeTimer();
      streamingActiveNodes = 0;
      streamingNextStartTime = 0;
      streamingSessionActive = false;
      streamingSpeakEndReceived = false;
      streamingSubtitleText = '';
      streamingSessionTurnId = null;
      pendingBuffers = new Map();
      nextScheduleIdx = 0;
      chunkReceiveCount = 0;
      pendingBeatMeta = [];
      lastStreamingBeatIndex = -1;
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
