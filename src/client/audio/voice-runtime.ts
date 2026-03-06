import type { VoiceResponse } from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';

export interface VoiceRuntime {
  init(): Promise<void>;
  bind(root: HTMLElement): void;
  dispose(): void;
}

export function createVoiceRuntime(store: AppStore): VoiceRuntime {
  let micStream: MediaStream | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let analyser: AnalyserNode | null = null;
  let audioContext: AudioContext | null = null;
  let levelRaf = 0;
  let chunks: Blob[] = [];
  let bindingsApplied = false;
  let keyHandlersBound = false;

  return {
    async init(): Promise<void> {
      await ensureMicrophone();
      bindKeyboardShortcuts();
    },
    bind(root: HTMLElement): void {
      const enableButton = root.querySelector<HTMLButtonElement>('#voice-enable-mic');
      const recordButton = root.querySelector<HTMLButtonElement>('#voice-record-button');
      const wakeWordToggle = root.querySelector<HTMLInputElement>('#voice-wakeword-toggle');

      if (!enableButton || !recordButton || !wakeWordToggle) {
        return;
      }

      enableButton.onclick = async () => {
        await ensureMicrophone();
      };

      wakeWordToggle.checked = store.getState().voiceWakeWordEnabled;
      wakeWordToggle.onchange = () => {
        store.setState((current) => ({
          ...current,
          voiceWakeWordEnabled: wakeWordToggle.checked,
        }));
      };

      recordButton.onpointerdown = async (event) => {
        event.preventDefault();
        await startRecording();
      };
      recordButton.onpointerup = (event) => {
        event.preventDefault();
        stopRecording();
      };
      recordButton.onpointerleave = () => {
        stopRecording();
      };

      if (!bindingsApplied) {
        bindingsApplied = true;
      }
    },
    dispose(): void {
      stopRecording();
      if (levelRaf) {
        window.cancelAnimationFrame(levelRaf);
      }
      for (const track of micStream?.getTracks() ?? []) {
        track.stop();
      }
      micStream = null;
      if (audioContext && audioContext.state !== 'closed') {
        void audioContext.close().catch(() => {});
      }
    },
  };

  async function ensureMicrophone(): Promise<void> {
    if (micStream) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      store.setState((current) => ({
        ...current,
        micDenied: true,
        listenState: 'Mic unavailable',
      }));
      store.appendLog('error', 'Microphone requires getUserMedia support');
      return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(micStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      mediaRecorder = createRecorder(micStream);
      store.setState((current) => ({
        ...current,
        micReady: true,
        micDenied: false,
        listenState: current.audioPlaying ? current.listenState : 'Mic ready',
      }));
      store.appendLog('info', 'Microphone ready');
      startMeterLoop();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Microphone access denied';
      store.setState((current) => ({
        ...current,
        micReady: false,
        micDenied: true,
        listenState: 'Mic denied',
      }));
      store.appendLog('error', message);
    }
  }

  function createRecorder(stream: MediaStream): MediaRecorder {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      chunks = [];
      if (blob.size > 0) {
        void uploadRecording(blob);
      } else {
        store.setState((current) => ({
          ...current,
          recording: false,
          listenState: 'Idle',
        }));
      }
    };
    return recorder;
  }

  async function startRecording(): Promise<void> {
    if (store.getState().recording) {
      return;
    }
    await ensureMicrophone();
    if (!mediaRecorder || mediaRecorder.state === 'recording' || !store.getState().micReady) {
      return;
    }

    if (audioContext?.state === 'suspended') {
      await audioContext.resume().catch(() => {});
    }

    chunks = [];
    mediaRecorder.start();
    store.setState((current) => ({
      ...current,
      recording: true,
      listenState: 'Listening...',
    }));
  }

  function stopRecording(): void {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') {
      return;
    }
    mediaRecorder.stop();
    store.setState((current) => ({
      ...current,
      recording: false,
      listenState: 'Uploading...',
    }));
  }

  async function uploadRecording(blob: Blob): Promise<void> {
    const wakeWord = store.getState().voiceWakeWordEnabled ? 'true' : 'false';
    try {
      const response = await fetch(`/voice?wakeWord=${wakeWord}`, {
        method: 'POST',
        body: blob,
        headers: {
          'Content-Type': blob.type || 'audio/webm',
        },
      });
      const json = await response.json() as VoiceResponse & { turnId?: string; error?: string };
      if (!response.ok) {
        throw new Error(json.error || `${response.status} ${response.statusText}`);
      }
      store.setState((current) => ({
        ...current,
        listenState: json.ignored ? 'Ignored' : 'Thinking...',
        voiceLastTranscript: json.text ?? '',
        liveTranscriptText: json.text ?? current.liveTranscriptText,
        liveTranscriptDraft: false,
      }));
      if (json.text) {
        store.appendLog('info', `Voice: ${json.text}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice upload failed';
      store.setState((current) => ({
        ...current,
        listenState: 'Upload failed',
      }));
      store.appendLog('error', message);
    }
  }

  function startMeterLoop(): void {
    if (!analyser) {
      return;
    }
    const samples = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (!analyser) {
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / samples.length);
      store.setState((current) => ({
        ...current,
        micLevel: Math.max(0, Math.min(1, rms * 8)),
      }));
      levelRaf = window.requestAnimationFrame(tick);
    };
    if (!levelRaf) {
      levelRaf = window.requestAnimationFrame(tick);
    }
  }

  function bindKeyboardShortcuts(): void {
    if (keyHandlersBound) {
      return;
    }
    keyHandlersBound = true;

    window.addEventListener('keydown', (event) => {
      if (event.repeat || event.code !== 'Space') {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) {
        return;
      }
      event.preventDefault();
      void startRecording();
    });

    window.addEventListener('keyup', (event) => {
      if (event.code !== 'Space') {
        return;
      }
      event.preventDefault();
      stopRecording();
    });
  }
}
