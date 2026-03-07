import type { VoiceResponse } from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';
import { upsertChatDraft } from '../chat/state.js';

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): BrowserSpeechRecognitionAlternative;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
}

interface BrowserSpeechRecognitionCtor {
  new (): BrowserSpeechRecognition;
}

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
  let speechRecognition: BrowserSpeechRecognition | null = null;
  let speechRecognitionRunning = false;
  let speechRecognitionAvailable = false;
  let lastLiveTranscript = '';
  let manualPressActive = false;
  let recordingMode: 'manual' | 'handsfree' | null = null;
  let recordingStartedAt = 0;
  let speechDetectedAt = 0;
  let silenceDetectedAt = 0;
  let unlockHandlerBound = false;
  const unlockHandler = () => {
    if (audioContext?.state === 'suspended') {
      void audioContext.resume().catch(() => {});
    }
  };

  return {
    async init(): Promise<void> {
      initializeSpeechRecognition();
      bindUnlockHandlers();
      await ensureMicrophone();
      bindKeyboardShortcuts();
    },
    bind(root: HTMLElement): void {
      const enableButton = root.querySelector<HTMLButtonElement>('#voice-enable-mic');
      const recordButton = root.querySelector<HTMLButtonElement>('#voice-record-button');

      if (!enableButton || !recordButton) {
        return;
      }

      enableButton.onclick = async () => {
        await ensureMicrophone();
      };

      recordButton.onpointerdown = async (event) => {
        event.preventDefault();
        manualPressActive = true;
        await startRecording('manual');
      };
      recordButton.onpointerup = (event) => {
        event.preventDefault();
        manualPressActive = false;
        stopRecording('manual');
      };
      recordButton.onpointerleave = () => {
        manualPressActive = false;
        stopRecording('manual');
      };

      if (!bindingsApplied) {
        bindingsApplied = true;
      }
    },
    dispose(): void {
      stopRecording(recordingMode ?? 'manual');
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
      if (speechRecognitionRunning) {
        speechRecognition?.abort();
      }
      unbindUnlockHandlers();
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
      await audioContext.resume().catch(() => {});
      const source = audioContext.createMediaStreamSource(micStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      mediaRecorder = createRecorder(micStream);
      store.setState((current) => ({
        ...current,
        micReady: true,
        micDenied: false,
        listenState: current.audioPlaying
          ? current.listenState
          : (current.voiceHandsFreeEnabled ? 'Hands-free ready' : 'Mic ready'),
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
          listenState: current.voiceHandsFreeEnabled ? 'Hands-free ready' : 'Idle',
        }));
        store.appendLog('error', 'Recorded clip was empty');
      }
    };
    return recorder;
  }

  async function startRecording(mode: 'manual' | 'handsfree'): Promise<void> {
    if (store.getState().recording) {
      return;
    }
    await ensureMicrophone();
    if (!mediaRecorder || mediaRecorder.state === 'recording' || !store.getState().micReady) {
      return;
    }
    if (mode === 'handsfree' && (store.getState().audioPlaying || store.getState().sleeping)) {
      return;
    }

    if (audioContext?.state === 'suspended') {
      await audioContext.resume().catch(() => {});
    }

    chunks = [];
    recordingMode = mode;
    recordingStartedAt = Date.now();
    speechDetectedAt = 0;
    silenceDetectedAt = 0;
    mediaRecorder.start(250);
    startLiveRecognition();
    store.setState((current) => ({
      ...current,
      recording: true,
      listenState: mode === 'handsfree'
        ? 'Listening hands-free...'
        : (speechRecognitionAvailable ? 'Listening… live transcript on' : 'Listening...'),
      liveTranscriptDraft: true,
      liveTranscriptText: lastLiveTranscript || current.liveTranscriptText,
    }));
  }

  function stopRecording(mode: 'manual' | 'handsfree'): void {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') {
      return;
    }
    if (recordingMode && recordingMode !== mode) {
      return;
    }
    store.setState((current) => ({
      ...current,
      recording: false,
      listenState: 'Uploading...',
    }));
    try {
      mediaRecorder.requestData();
    } catch {
      // ignore
    }
    stopLiveRecognition();
    mediaRecorder.stop();
    recordingMode = null;
  }

  async function uploadRecording(blob: Blob): Promise<void> {
    const wakeWord = store.getState().voiceWakeWordEnabled ? 'true' : 'false';
    store.appendLog('info', `Uploading voice clip (${Math.round(blob.size / 1024)} KB)`);
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
      store.appendLog(
        'info',
        `Voice bridge replied ${json.ignored ? 'ignored' : 'ok'}${json.turnId ? ` (${json.turnId.slice(0, 8)})` : ''}`,
      );
      store.setState((current) => ({
        ...upsertChatDraft(current, 'in', json.text ?? ''),
        listenState: json.ignored ? 'Ignored' : 'Thinking...',
        voiceLastTranscript: json.text ?? '',
        currentIncomingText: json.text ?? current.currentIncomingText,
        liveTranscriptText: json.text ?? current.liveTranscriptText,
        liveTranscriptDraft: false,
        ...(json.turnId ? { currentTurnId: json.turnId } : {}),
      }));
      if (json.text) {
        store.appendLog('info', `Voice: ${json.text}`);
      } else {
        store.appendLog('info', 'Voice upload completed with empty transcript');
      }
      lastLiveTranscript = '';
      if (json.ignored) {
        store.setState((current) => ({
          ...current,
          listenState: 'Ignored',
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice upload failed';
      store.setState((current) => ({
        ...current,
        listenState: current.voiceHandsFreeEnabled ? 'Hands-free error' : 'Upload failed',
      }));
      store.appendLog('error', message);
    }
  }

  function initializeSpeechRecognition(): void {
    const recognitionCtor = getSpeechRecognitionCtor();
    if (!recognitionCtor) {
      speechRecognitionAvailable = false;
      return;
    }

    speechRecognitionAvailable = true;
    speechRecognition = new recognitionCtor();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = 'en-US';
    speechRecognition.onresult = (event) => {
      let nextTranscript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result || result.length === 0) {
          continue;
        }
        nextTranscript += result[0]?.transcript ?? result.item(0)?.transcript ?? '';
      }
      const normalized = nextTranscript.trim();
      if (!normalized) {
        return;
      }
      lastLiveTranscript = normalized;
      store.setState((current) => ({
        ...upsertChatDraft(current, 'in', normalized),
        currentIncomingText: normalized,
        liveTranscriptText: normalized,
        liveTranscriptDraft: true,
        voiceLastTranscript: normalized,
      }));
    };
    speechRecognition.onerror = (event) => {
      speechRecognitionRunning = false;
      store.appendLog('error', `Live transcript error: ${event.type}`);
    };
    speechRecognition.onend = () => {
      speechRecognitionRunning = false;
      if (store.getState().recording) {
        startLiveRecognition();
      }
    };
  }

  function startLiveRecognition(): void {
    if (!speechRecognition || speechRecognitionRunning) {
      return;
    }

    try {
      speechRecognition.start();
      speechRecognitionRunning = true;
    } catch {
      // Browsers can throw if start() is called while already active.
    }
  }

  function stopLiveRecognition(): void {
    if (!speechRecognition || !speechRecognitionRunning) {
      return;
    }
    speechRecognitionRunning = false;
    try {
      speechRecognition.stop();
    } catch {
      // ignore
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
      handleHandsFreeVad(rms);
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
      manualPressActive = true;
      void startRecording('manual');
    });

    window.addEventListener('keyup', (event) => {
      if (event.code !== 'Space') {
        return;
      }
      event.preventDefault();
      manualPressActive = false;
      stopRecording('manual');
    });
  }

  function handleHandsFreeVad(rms: number): void {
    const state = store.getState();
    if (!state.voiceHandsFreeEnabled || !state.micReady || state.sleeping || state.audioPlaying || manualPressActive) {
      speechDetectedAt = 0;
      silenceDetectedAt = 0;
      return;
    }

    const gate = Math.max(0.008, state.config?.vadNoiseGate ?? 0.008);
    const startThreshold = Math.max(0.018, gate * 2.5);
    const stopThreshold = Math.max(0.01, gate * 1.5);
    const now = Date.now();

    if (!state.recording) {
      if (state.listenState === 'Uploading...' || state.listenState === 'Thinking...') {
        return;
      }
      if (rms >= startThreshold) {
        speechDetectedAt = speechDetectedAt || now;
        if (now - speechDetectedAt >= 180) {
          speechDetectedAt = 0;
          void startRecording('handsfree');
        }
      } else {
        speechDetectedAt = 0;
      }
      return;
    }

    if (recordingMode !== 'handsfree') {
      return;
    }

    if (now - recordingStartedAt >= 10000) {
      stopRecording('handsfree');
      return;
    }

    if (rms <= stopThreshold) {
      silenceDetectedAt = silenceDetectedAt || now;
      if (now - silenceDetectedAt >= 900) {
        silenceDetectedAt = 0;
        stopRecording('handsfree');
      }
    } else {
      silenceDetectedAt = 0;
    }
  }

  function bindUnlockHandlers(): void {
    if (unlockHandlerBound) {
      return;
    }
    unlockHandlerBound = true;
    window.addEventListener('pointerdown', unlockHandler, true);
    window.addEventListener('keydown', unlockHandler, true);
  }

  function unbindUnlockHandlers(): void {
    if (!unlockHandlerBound) {
      return;
    }
    unlockHandlerBound = false;
    window.removeEventListener('pointerdown', unlockHandler, true);
    window.removeEventListener('keydown', unlockHandler, true);
  }
}

function getSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  const scopedWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };

  return scopedWindow.SpeechRecognition ?? scopedWindow.webkitSpeechRecognition ?? null;
}
