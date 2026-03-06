import type { TurnBeat, TurnEmotion } from '../../shared/contracts/turn-script.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import type { AppStore } from '../state/app-state.js';
import { pushStreamDebugEntry } from '../chat/state.js';
import { createSubtitleController, type SubtitleController } from '../ui/subtitles.js';

interface SpeakQueueItem {
  type: 'speak' | 'wait' | 'react';
  text?: string;
  delayMs?: number;
  emotion?: TurnEmotion | null;
  turnId?: string | null;
}

const INTER_UTTERANCE_PAUSE_MS = 220;
const STREAMING_GAP_GRACE_MS = 280;

export interface SpeechRuntime {
  init(): void;
  bind(root: HTMLElement): void;
  handleServerMessage(message: WsServerMessage): void;
  dispose(): void;
}

export function createSpeechRuntime(store: AppStore): SpeechRuntime {
  const queue: SpeakQueueItem[] = [];
  let audioElement: HTMLAudioElement | null = null;
  let processing = false;
  let disposed = false;
  let streamingAudioContext: AudioContext | null = null;
  let streamingNextStartTime = 0;
  let streamingActiveNodes = 0;
  let streamingFinalizeTimer: number | null = null;
  let subtitles: SubtitleController = createSubtitleController(null);

  return {
    init(): void {
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
        default:
          return;
      }
    },
    dispose(): void {
      disposed = true;
      stopAllPlayback();
      if (streamingAudioContext && streamingAudioContext.state !== 'closed') {
        void streamingAudioContext.close().catch(() => {});
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
    for (const beat of beats) {
      if (beat.actor !== 'main') {
        continue;
      }
      if (beat.action === 'wait') {
        queue.push({
          type: 'wait',
          delayMs: Math.max(120, beat.delayMs ?? 320),
          ...(turnId !== undefined ? { turnId } : {}),
        });
        continue;
      }
      if (beat.action !== 'speak' || !beat.text?.trim()) {
        if (beat.action === 'react') {
          queue.push({
            type: 'react',
            ...(beat.text?.trim() ? { text: beat.text.trim() } : {}),
            delayMs: Math.max(120, beat.delayMs ?? 420),
            ...(beat.emotion ? { emotion: beat.emotion } : {}),
            ...(turnId !== undefined ? { turnId } : {}),
          });
        }
        continue;
      }
      queue.push({
        type: 'speak',
        text: beat.text.trim(),
        ...(beat.emotion ? { emotion: beat.emotion } : {}),
        ...(turnId !== undefined ? { turnId } : {}),
      });
    }
    processQueue();
  }

  function processQueue(): void {
    if (processing || queue.length === 0 || disposed) {
      return;
    }

    const item = queue.shift();
    if (!item) {
      return;
    }

    if (item.type === 'wait') {
      processing = true;
      window.setTimeout(() => {
        processing = false;
        processQueue();
      }, item.delayMs ?? 320);
      return;
    }

    if (item.type === 'react') {
      processing = true;
      applyBeatVisuals(item.text ?? '', item.emotion, false);
      window.setTimeout(() => {
        store.setState((current) => ({
          ...current,
          currentExpression: current.sleeping ? 'sleep' : 'idle',
        }));
        processing = false;
        processQueue();
      }, item.delayMs ?? 420);
      return;
    }

    if (!item.text) {
      processQueue();
      return;
    }

    processing = true;
    applyBeatVisuals(item.text, item.emotion, true);
    void playTts(item.text, item.turnId)
      .catch((error) => {
        store.appendLog('error', error instanceof Error ? error.message : 'Speech playback failed');
      })
      .finally(() => {
        window.setTimeout(() => {
          processing = false;
          processQueue();
        }, INTER_UTTERANCE_PAUSE_MS);
      });
  }

  async function playTts(text: string, turnId?: string | null): Promise<void> {
    updatePlaybackState(true, 'Speaking');
    emitHeadSpeechState('start', turnId ?? null);

    const useBrowserFallback = store.getState().config?.ttsBackend === 'system';
    if (useBrowserFallback) {
      await speakWithBrowserTts(text, turnId ?? null);
      return;
    }

    const response = await fetch('/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/wav, application/octet-stream',
      },
      body: JSON.stringify({
        text,
        voice: store.getState().config?.kokoroVoice,
      }),
    });

    if (!response.ok) {
      throw new Error(`TTS failed: ${response.status} ${response.statusText}`);
    }

    const blob = await response.blob();
    if (blob.size < 100) {
      throw new Error('TTS response was empty');
    }

    await playBlob(blob, turnId ?? null);
  }

  async function playBlob(blob: Blob, turnId: string | null): Promise<void> {
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    audioElement = audio;
    subtitles.start(store.getState().currentSpeechText || '', audio);

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
          cleanupAudio(objectUrl, audio, turnId);
          resolve();
        });
      };
      audio.onerror = () => {
        finalize(() => {
          cleanupAudio(objectUrl, audio, turnId);
          reject(new Error('Audio playback failed'));
        });
      };

      audio.play().catch((error) => {
        finalize(() => {
          cleanupAudio(objectUrl, audio, turnId);
          reject(error instanceof Error ? error : new Error('Audio playback failed'));
        });
      });
    });
  }

  async function speakWithBrowserTts(text: string, turnId: string | null): Promise<void> {
    subtitles.start(text);
    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => {
        finishSpeech(turnId);
        resolve();
      };
      utterance.onerror = () => {
        finishSpeech(turnId);
        reject(new Error('Speech synthesis failed'));
      };
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

    updatePlaybackState(true, 'Speaking (Stream)');
    emitHeadSpeechState('start', turnId ?? null);
    subtitles.start(store.getState().currentSpeechText || 'Streaming audio');

    const bytes = Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0));
    const audioBuffer = await streamingAudioContext.decodeAudioData(bytes.buffer.slice(0));
    store.setState((current) => pushStreamDebugEntry(current, 'audio_chunk_played', {
      turnId: turnId ?? current.currentTurnId,
      audioBytes: bytes.byteLength,
      audioDurationSec: audioBuffer.duration,
      ts: Date.now(),
    }));
    const source = streamingAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(streamingAudioContext.destination);

    const now = streamingAudioContext.currentTime;
    if (streamingNextStartTime < now) {
      streamingNextStartTime = now;
    }

    streamingActiveNodes += 1;
    source.start(streamingNextStartTime);
    streamingNextStartTime += audioBuffer.duration;
    source.onended = () => {
      streamingActiveNodes = Math.max(0, streamingActiveNodes - 1);
      scheduleStreamingEnd(turnId);
    };
  }

  function scheduleStreamingEnd(turnId?: string): void {
    clearStreamingFinalizeTimer();
    streamingFinalizeTimer = window.setTimeout(() => {
      if (streamingActiveNodes > 0) {
        return;
      }
      finishSpeech(turnId ?? null);
      streamingNextStartTime = 0;
    }, STREAMING_GAP_GRACE_MS);
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
    updatePlaybackState(false, 'Idle');
    subtitles.finish();
    emitHeadSpeechState('end', turnId);
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
        actor: 'main',
        state,
        turnId,
        ts: Date.now(),
      },
    }));
  }

  function stopAllPlayback(): void {
    queue.length = 0;
    processing = false;
    clearStreamingFinalizeTimer();
    streamingActiveNodes = 0;
    streamingNextStartTime = 0;
    if (audioElement) {
      audioElement.pause();
      audioElement.src = '';
      audioElement = null;
    }
    speechSynthesis.cancel();
    subtitles.stop();
    finishSpeech(store.getState().currentTurnId);
  }

  function applyBeatVisuals(text: string, emotion: TurnEmotion | null | undefined, speaking: boolean): void {
    store.setState((current) => ({
      ...current,
      currentSpeechText: text,
      subtitleText: text,
      currentExpression: emotion?.expression ?? (speaking ? 'speaking' : current.currentExpression),
    }));
  }
}
