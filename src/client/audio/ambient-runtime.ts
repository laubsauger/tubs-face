import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';

const AMBIENT_SRC = '/audio/tubs-robot-ambience-loop.mp3';
const PULSE_INTERVAL_MS = 22_000;
const FADE_IN_MS = 2_000;
const HOLD_MS = 4_000;
const FADE_OUT_MS = 2_500;
const PEAK_GAIN = 0.42;
const DUCKED_GAIN = 0.18;
const BASE_ENVELOPE = 0.5;
const SLEEP_GAIN_FACTOR = 0.72;
const PAUSE_IDLE_DELAY_MS = 600;

export interface AmbientRuntime {
  init(): void;
  toggleEnabled(): Promise<void>;
  dispose(): void;
}

export function createAmbientRuntime(store: AppStore, mode: 'main' | 'mini'): AmbientRuntime {
  let audioEl: HTMLAudioElement | null = null;
  let audioCtx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let sourceNode: MediaElementAudioSourceNode | null = null;
  let usingWebAudio = false;
  let booted = false;
  let active = false;
  let envelope = 0;
  let lastAppliedTarget = -1;
  let pulseToken = 0;
  let pauseTimer: number | null = null;
  let gestureHandler: ((event: Event) => void) | null = null;
  let speechObservedHandler: ((event: Event) => void) | null = null;

  return {
    init(): void {
      if (mode === 'mini') {
        return;
      }
      gestureHandler = (event) => {
        void bootAudio(event.type);
      };
      for (const type of ['click', 'keydown', 'pointerdown', 'touchstart']) {
        document.addEventListener(type, gestureHandler, true);
      }
      speechObservedHandler = () => {
        syncActiveState();
      };
      window.addEventListener('tubs:head-speech-state', speechObservedHandler as EventListener);
      window.addEventListener('tubs:head-speech-observed', speechObservedHandler as EventListener);
      document.addEventListener('visibilitychange', syncActiveState);
    },
    async toggleEnabled(): Promise<void> {
      if (mode !== 'main') {
        return;
      }
      const enabled = !store.getState().ambientAudioEnabled;
      store.setState((current) => ({
        ...current,
        ambientAudioEnabled: enabled,
      }));
      try {
        await postJson('/config', { ambientAudioEnabled: enabled });
      } catch (error) {
        store.appendLog('error', error instanceof Error ? error.message : 'Ambient toggle failed');
      }
      syncActiveState();
    },
    dispose(): void {
      if (gestureHandler) {
        for (const type of ['click', 'keydown', 'pointerdown', 'touchstart']) {
          document.removeEventListener(type, gestureHandler, true);
        }
      }
      if (speechObservedHandler) {
        window.removeEventListener('tubs:head-speech-state', speechObservedHandler as EventListener);
        window.removeEventListener('tubs:head-speech-observed', speechObservedHandler as EventListener);
      }
      document.removeEventListener('visibilitychange', syncActiveState);
      if (pauseTimer != null) {
        window.clearTimeout(pauseTimer);
      }
      pulseToken += 1;
      if (audioEl) {
        audioEl.pause();
        audioEl.src = '';
      }
      if (audioCtx && audioCtx.state !== 'closed') {
        void audioCtx.close().catch(() => {});
      }
    },
  };

  async function bootAudio(reason: string): Promise<void> {
    if (booted) {
      await ensurePlaybackReady(reason);
      return;
    }
    booted = true;
    ensureAudioGraph();
    if (audioEl) {
      audioEl.load();
    }
    await ensurePlaybackReady(reason);
    syncActiveState();
  }

  function ensureAudioGraph(): void {
    if (audioEl) {
      return;
    }
    audioEl = new Audio(AMBIENT_SRC);
    audioEl.loop = true;
    audioEl.preload = 'auto';
    audioEl.volume = 0;

    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      usingWebAudio = false;
      return;
    }

    try {
      audioCtx = new AudioCtx();
      sourceNode = audioCtx.createMediaElementSource(audioEl);
      gainNode = audioCtx.createGain();
      gainNode.gain.value = 0;
      sourceNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      usingWebAudio = true;
      audioEl.volume = 1;
    } catch {
      usingWebAudio = false;
      sourceNode = null;
      gainNode = null;
      audioCtx = null;
    }
  }

  async function ensurePlaybackReady(reason: string): Promise<void> {
    if (!audioEl) {
      return;
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      await audioCtx.resume().catch(() => {});
    }
    if (audioEl.paused) {
      await audioEl.play().catch(() => {
        store.appendLog('info', `Ambient waiting for gesture (${reason})`);
      });
    }
  }

  function shouldBeActive(): boolean {
    const state = store.getState();
    return state.ambientAudioEnabled && !state.config?.muted && !document.hidden;
  }

  function isSpeechActive(): boolean {
    return store.getState().audioPlaying;
  }

  function computeTargetGain(): number {
    if (!active) {
      return 0;
    }
    let peak = isSpeechActive() ? DUCKED_GAIN : PEAK_GAIN;
    if (store.getState().sleeping) {
      peak *= SLEEP_GAIN_FACTOR;
    }
    return envelope * peak;
  }

  function setGain(target: number, durationMs = 0): void {
    const next = clamp01(target);
    if (usingWebAudio && gainNode && audioCtx) {
      const now = audioCtx.currentTime;
      const durationSeconds = Math.max(0, durationMs) / 1000;
      const from = gainNode.gain.value;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(from, now);
      if (durationSeconds > 0) {
        gainNode.gain.linearRampToValueAtTime(next, now + durationSeconds);
      } else {
        gainNode.gain.setValueAtTime(next, now);
      }
      return;
    }
    if (audioEl) {
      audioEl.volume = next;
    }
  }

  function applyTargetGain(durationMs = 180): void {
    const next = computeTargetGain();
    if (Math.abs(next - lastAppliedTarget) < 0.001) {
      return;
    }
    lastAppliedTarget = next;
    setGain(next, durationMs);
  }

  function setEnvelope(nextEnvelope: number, durationMs: number): void {
    envelope = clamp01(nextEnvelope);
    applyTargetGain(durationMs);
  }

  function schedulePauseIfInactive(): void {
    if (pauseTimer != null) {
      window.clearTimeout(pauseTimer);
    }
    if (active || !audioEl) {
      return;
    }
    pauseTimer = window.setTimeout(() => {
      pauseTimer = null;
      if (active || !audioEl || audioEl.paused) {
        return;
      }
      audioEl.pause();
    }, PAUSE_IDLE_DELAY_MS);
  }

  function syncActiveState(): void {
    if (!booted) {
      return;
    }
    const nextActive = shouldBeActive();
    if (nextActive === active) {
      if (active) {
        applyTargetGain(140);
      }
      return;
    }

    active = nextActive;
    if (active) {
      void ensurePlaybackReady('state-change');
      setEnvelope(BASE_ENVELOPE, 300);
      startPulseLoop();
      return;
    }

    stopPulseLoop();
    setEnvelope(0, 220);
    schedulePauseIfInactive();
  }

  function startPulseLoop(): void {
    pulseToken += 1;
    const token = pulseToken;
    void runPulseLoop(token);
  }

  function stopPulseLoop(): void {
    pulseToken += 1;
  }

  async function runPulseLoop(token: number): Promise<void> {
    while (token === pulseToken) {
      await sleep(PULSE_INTERVAL_MS);
      if (token !== pulseToken || !active) {
        return;
      }
      setEnvelope(1, FADE_IN_MS);
      await sleep(FADE_IN_MS + HOLD_MS);
      if (token !== pulseToken || !active) {
        return;
      }
      setEnvelope(BASE_ENVELOPE, FADE_OUT_MS);
      await sleep(FADE_OUT_MS);
    }
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}
