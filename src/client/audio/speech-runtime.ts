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
  handleServerMessage(message: WsServerMessage): void;
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
  let streamingSubtitleText = '';
  let activeSpeechTurnId: string | null = null;
  let activeQueueTurnId: string | null = null;
  let subtitles: SubtitleController = createSubtitleController(null);
  let remoteActorSpeaking = false;
  let remoteActorSpeakingUntil = 0;
  let remoteWaitTimer: number | null = null;
  let reactionResetTimer: number | null = null;
  let speechSafetyTimer: number | null = null;
  let subtitleClearTimer: number | null = null;
  let stopSpeechHandler: ((event: Event) => void) | null = null;
  let lastEmotion: TurnEmotion | null = null;

  return {
    init(): void {
      bindInferenceUnlockHandlers();
      bindStopSpeechHandler();
      store.appendLog('info', 'Speech runtime ready');
    },
    bind(root: HTMLElement): void {
      subtitles = createSubtitleController(root.querySelector<HTMLElement>('#visual-subtitle'));
    },
    handleServerMessage(message: WsServerMessage): void {
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
        case 'audio_chunk':
          void playStreamingAudioChunk(message.audio, message.turnId);
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
    const actor = mode === 'mini' ? 'small' : 'main';
    const includeRemoteWait = Boolean(store.getState().config?.dualHeadEnabled && store.getState().config?.dualHeadMode !== 'off');
    const timeline = buildLocalTurnTimeline(beats, actor, { includeRemoteWait });
    const hasSpeakBeat = timeline.some((item) => item.action === 'speak' && item.text?.trim());
    let promotedReactToSpeak = false;
    for (const item of timeline) {
      if (mode === 'mini' && item.action === 'react') {
        const reactText = item.text?.trim() ?? '';
        if (!hasSpeakBeat && reactText && !promotedReactToSpeak) {
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
        type: item.action,
        ...(item.actor ? { actor: item.actor } : {}),
        ...(item.text?.trim() ? { text: item.text.trim() } : {}),
        ...(item.delayMs !== undefined ? { delayMs: Math.max(120, item.delayMs) } : {}),
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
      applyBeatVisuals(item.text ?? '', item.emotion, false);
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
    applyBeatVisuals(item.text, item.emotion, true);
    startSpeechSafetyTimer();
    void playTts(item.text, item.turnId)
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

  async function playTts(text: string, turnId?: string | null): Promise<void> {
    const effectiveTurnId = turnId ?? store.getState().currentTurnId ?? null;
    activeSpeechTurnId = effectiveTurnId;
    const turnTimer = createTurnTimer({
      side: 'frontend',
      source: 'tts',
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
    });
    turnTimer.mark('TTS queued');
    updatePlaybackState(true, 'Speaking');
    emitHeadSpeechState('start', effectiveTurnId);

    const useBrowserFallback = store.getState().config?.ttsBackend === 'system';
    if (useBrowserFallback) {
      turnTimer.mark('Browser TTS fallback selected');
      await speakWithBrowserTts(text, effectiveTurnId, turnTimer);
      turnTimer.mark('Speech finished');
      turnTimer.log({ title: '[Turn Timing]' });
      return;
    }

    try {
      turnTimer.mark('HTTP /tts started');
      store.setState((current) => pushStreamDebugEntry(current, 'tts_request_start', {
        turnId: effectiveTurnId ?? current.currentTurnId,
        textChars: text.length,
        ts: Date.now(),
      }));
      const response = await fetch('/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/wav, application/octet-stream',
        },
        body: JSON.stringify({
          text,
          voice: mode === 'mini'
            ? store.getState().config?.secondaryVoice
            : store.getState().config?.kokoroVoice,
          ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        }),
      });
      turnTimer.mark(`HTTP /tts completed (${response.status})`);

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

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finalize = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        callback();
      };

      audio.onended = () => {
        finalize(() => {
          turnTimer?.mark('Audio playback ended');
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
      turnTimer?.mark('Audio playback started');
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

  async function playStreamingAudioChunk(audioBase64: string, turnId?: string): Promise<void> {
    clearStreamingFinalizeTimer();
    if (!streamingAudioContext) {
      streamingAudioContext = new AudioContext();
    }
    if (streamingAudioContext.state === 'suspended') {
      await streamingAudioContext.resume();
    }

    const bytes = Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0));
    const audioBuffer = await streamingAudioContext.decodeAudioData(bytes.buffer.slice(0));
    const source = streamingAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(streamingAudioContext.destination);

    const now = streamingAudioContext.currentTime;
    if (streamingNextStartTime < now) {
      streamingNextStartTime = now;
    }

    const effectiveTurnId = turnId ?? store.getState().currentTurnId ?? null;
    if (streamingSessionActive && streamingSessionTurnId && effectiveTurnId && streamingSessionTurnId !== effectiveTurnId) {
      endStreamingSession(streamingSessionTurnId);
    }
    if (!streamingSessionActive) {
      beginStreamingSession(effectiveTurnId);
    }
    updateStreamingSubtitle(store.getState().currentSpeechText || 'Streaming audio');

    store.setState((current) => pushStreamDebugEntry(current, 'audio_chunk_played', {
      turnId: effectiveTurnId ?? current.currentTurnId,
      audioBytes: bytes.byteLength,
      audioDurationSec: audioBuffer.duration,
      ts: Date.now(),
    }));

    streamingActiveNodes += 1;
    source.start(streamingNextStartTime);
    streamingNextStartTime += audioBuffer.duration;
    source.onended = () => {
      streamingActiveNodes = Math.max(0, streamingActiveNodes - 1);
      scheduleStreamingEnd(effectiveTurnId ?? undefined);
    };
  }

  function beginStreamingSession(turnId: string | null): void {
    if (streamingSessionActive) {
      return;
    }
    streamingSessionActive = true;
    streamingSessionTurnId = turnId ?? store.getState().currentTurnId ?? null;
    activeSpeechTurnId = streamingSessionTurnId;
    updatePlaybackState(true, 'Speaking (Stream)');
    emitHeadSpeechState('start', streamingSessionTurnId);
  }

  function endStreamingSession(turnId: string | null): void {
    clearStreamingFinalizeTimer();
    if (!streamingSessionActive) {
      streamingActiveNodes = 0;
      streamingNextStartTime = 0;
      streamingSubtitleText = '';
      streamingSessionTurnId = null;
      return;
    }

    const effectiveTurnId = turnId ?? streamingSessionTurnId ?? store.getState().currentTurnId ?? null;
    streamingSessionActive = false;
    streamingActiveNodes = 0;
    streamingNextStartTime = 0;
    streamingSubtitleText = '';
    streamingSessionTurnId = null;
    finishSpeech(effectiveTurnId);
  }

  function scheduleStreamingEnd(turnId?: string): void {
    clearStreamingFinalizeTimer();
    streamingFinalizeTimer = window.setTimeout(() => {
      if (streamingActiveNodes > 0) {
        return;
      }
      endStreamingSession(turnId ?? null);
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
      subtitles.start(normalized, STREAMING_SUBTITLE_HOLD_SEC);
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
    if (turnId == null || activeSpeechTurnId === turnId) {
      activeSpeechTurnId = null;
    }
    updatePlaybackState(false, 'Idle');
    subtitles.finish();
    emitHeadSpeechState('end', turnId);
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

  function emitHeadSpeechState(state: 'start' | 'end', turnId: string | null): void {
    window.dispatchEvent(new CustomEvent('tubs:head-speech-state', {
      detail: {
        actor: mode === 'mini' ? 'small' : 'main',
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
    streamingSessionTurnId = null;
    streamingSubtitleText = '';
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
    if (message.actor === localActor) {
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
      streamingSubtitleText = '';
      streamingSessionTurnId = null;
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
