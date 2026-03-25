import type { VoiceResponse } from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';
import { upsertChatDraft } from '../chat/state.js';
import { createVadProvider, type VadModelId, type VadProvider } from './vad/index.js';

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
  new(): BrowserSpeechRecognition;
}

export interface VoiceRuntime {
  init(): Promise<void>;
  enableMic(): Promise<void>;
  startManualRecording(): Promise<void>;
  stopManualRecording(): void;
  dispose(): void;
}

export function createVoiceRuntime(store: AppStore): VoiceRuntime {
  const HANDSFREE_START_HOLD_MS = 45;
  const HANDSFREE_STOP_SILENCE_MS = 900;
  const SPEECH_CAPTURE_COOLDOWN_MS = 650;
  const HEAD_SPEECH_STALE_MS = 20_000;
  let micStream: MediaStream | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let analyser: AnalyserNode | null = null;
  let audioContext: AudioContext | null = null;
  let levelRaf = 0;
  let chunks: Blob[] = [];
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
  let lastSpeechStart = 0;
  let lastSpeechStop = 0;
  let lastVoiceDetectedAt = 0;
  let vadProvider: VadProvider | null = null;
  let vadModelId: VadModelId = 'rms';
  let unlockHandlerBound = false;
  let discardPendingRecording = false;
  let anyHeadSpeechHandler: ((event: Event) => void) | null = null;
  let speechCaptureBlockedUntil = 0;
  const speakingActors = new Map<'main' | 'small', number>();
  const unlockHandler = () => {
    if (audioContext?.state === 'suspended') {
      void audioContext.resume().catch(() => { });
    }
  };

  return {
    async init(): Promise<void> {
      initializeSpeechRecognition();
      bindUnlockHandlers();
      bindHeadSpeechObserver();
      await ensureMicrophone();
      bindKeyboardShortcuts();
      store.subscribeSelector(
        (s) => `${s.voiceHandsFreeEnabled}:${s.audioPlaying}:${s.sleeping}:${s.micReady}`,
        () => {
          syncPassiveLiveRecognition();
        },
        { fireImmediately: true },
      );
      // Hot-switch VAD model when config changes
      store.subscribeSelector(
        (s) => s.config?.vadModel,
        () => {
          if (audioContext) {
            void ensureVadProvider(audioContext.sampleRate);
          }
        },
        { fireImmediately: false },
      );
    },
    enableMic(): Promise<void> {
      return ensureMicrophone();
    },
    async startManualRecording(): Promise<void> {
      manualPressActive = true;
      await startRecording('manual');
    },
    stopManualRecording(): void {
      manualPressActive = false;
      stopRecording('manual');
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
        void audioContext.close().catch(() => { });
      }
      if (speechRecognitionRunning) {
        speechRecognition?.abort();
      }
      vadProvider?.dispose();
      vadProvider = null;
      unbindHeadSpeechObserver();
      speakingActors.clear();
      speechCaptureBlockedUntil = 0;
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
      await audioContext.resume().catch(() => { });
      const source = audioContext.createMediaStreamSource(micStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      mediaRecorder = createRecorder(micStream);
      await ensureVadProvider(audioContext.sampleRate);
      store.setState((current) => ({
        ...current,
        micReady: true,
        micDenied: false,
        listenState: current.audioPlaying
          ? current.listenState
          : (current.voiceHandsFreeEnabled ? passiveListenState() : 'Mic ready'),
      }));
      store.appendLog('info', 'Microphone ready');
      syncPassiveLiveRecognition();
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
      const shouldDiscard = discardPendingRecording;
      discardPendingRecording = false;
      if (shouldDiscard) {
        lastLiveTranscript = '';
        store.setState((current) => ({
          ...current,
          recording: false,
          currentIncomingText: '',
          liveTranscriptText: '',
          liveTranscriptDraft: false,
          voiceLastTranscript: '',
          listenState: current.voiceHandsFreeEnabled ? passiveListenState() : 'Idle',
        }));
        store.appendLog('info', 'Discarded mic capture during local speech playback');
        syncPassiveLiveRecognition();
        return;
      }
      if (blob.size > 0) {
        void uploadRecording(blob);
      } else {
        store.setState((current) => ({
          ...current,
          recording: false,
          listenState: current.voiceHandsFreeEnabled ? passiveListenState() : 'Idle',
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
    if (mode === 'handsfree' && (store.getState().audioPlaying || store.getState().sleeping || isSpeechCaptureBlocked())) {
      return;
    }

    const state = store.getState();
    if (state.audioPlaying || state.currentSpeechText || state.currentTurnId) {
      window.dispatchEvent(new CustomEvent('tubs:stop-speech', {
        detail: {
          turnId: state.currentTurnId ?? null,
          source: 'voice_barge_in',
        },
      }));
      window.dispatchEvent(new CustomEvent('tubs:request-interrupt', {
        detail: {
          turnId: state.currentTurnId ?? null,
        },
      }));
    }

    if (audioContext?.state === 'suspended') {
      await audioContext.resume().catch(() => { });
    }

    chunks = [];
    recordingMode = mode;
    recordingStartedAt = Date.now();
    if (mode === 'manual') {
      lastSpeechStart = recordingStartedAt;
    }
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

  function stopRecording(mode: 'manual' | 'handsfree', options?: { discard?: boolean }): void {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') {
      return;
    }
    if (recordingMode && recordingMode !== mode) {
      return;
    }
    if (options?.discard) {
      discardPendingRecording = true;
    }

    store.setState((current) => ({
      ...current,
      recording: false,
      listenState: options?.discard
        ? (current.voiceHandsFreeEnabled ? passiveListenState() : 'Idle')
        : 'Uploading...',
    }));
    try {
      mediaRecorder.requestData();
    } catch {
      // ignore
    }
    stopLiveRecognition();
    mediaRecorder.stop();
    lastSpeechStop = Date.now();
    recordingMode = null;
  }

  async function uploadRecording(blob: Blob): Promise<void> {
    const wakeWord = store.getState().voiceWakeWordEnabled ? 'true' : 'false';
    const qs = new URLSearchParams({
      wakeWord,
      startedAt: String(lastSpeechStart),
      stoppedAt: String(lastSpeechStop),
    }).toString();
    store.appendLog('info', `Uploading voice clip (${Math.round(blob.size / 1024)} KB)`);
    try {
      const response = await fetch(`/voice?${qs}`, {
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
        ...current,
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
    } finally {
      syncPassiveLiveRecognition();
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
      if (isSpeechCaptureBlocked(true)) {
        return;
      }
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
      if (store.getState().recording || shouldKeepPassiveLiveRecognition()) {
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

  function passiveListenState(): string {
    return store.getState().voiceWakeWordEnabled ? 'Always listening' : 'Always on';
  }

  function shouldKeepPassiveLiveRecognition(): boolean {
    const state = store.getState();
    return Boolean(
      speechRecognitionAvailable
      && state.micReady
      && state.voiceHandsFreeEnabled
      && !state.sleeping
      && !state.audioPlaying
      && !isSpeechCaptureBlocked()
      && !manualPressActive
      && state.listenState !== 'Uploading...'
      && state.listenState !== 'Thinking...',
    );
  }

  function syncPassiveLiveRecognition(): void {
    if (shouldKeepPassiveLiveRecognition()) {
      startLiveRecognition();
      const state = store.getState();
      if (!state.recording && state.listenState !== 'Uploading...' && state.listenState !== 'Thinking...' && state.listenState !== passiveListenState()) {
        store.setState((current) => ({
          ...current,
          listenState: passiveListenState(),
        }));
      }
      return;
    }
    if (!store.getState().recording) {
      stopLiveRecognition();
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
      handleHandsFreeVad(rms, samples);
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

  async function ensureVadProvider(sampleRate: number): Promise<void> {
    const configModel = (store.getState().config?.vadModel ?? 'rms') as VadModelId;
    if (vadProvider && vadModelId === configModel) {
      return;
    }
    vadProvider?.dispose();
    vadProvider = null;
    vadModelId = configModel;
    const noiseGate = store.getState().config?.vadNoiseGate ?? 0.008;
    vadProvider = createVadProvider(configModel, { noiseGate, sampleRate });
    try {
      await vadProvider.init();
      store.appendLog('info', `VAD provider: ${configModel}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'VAD init failed';
      store.appendLog('error', `VAD ${configModel} init failed: ${message}, falling back to rms`);
      vadProvider.dispose();
      vadModelId = 'rms';
      vadProvider = createVadProvider('rms', { noiseGate, sampleRate });
      await vadProvider.init();
    }
  }

  function handleHandsFreeVad(rms: number, samples: Float32Array): void {
    const state = store.getState();
    if (!state.voiceHandsFreeEnabled || !state.micReady || state.sleeping || state.audioPlaying || manualPressActive || isSpeechCaptureBlocked()) {
      if (state.recording && recordingMode === 'handsfree' && isSpeechCaptureBlocked()) {
        stopRecording('handsfree', { discard: true });
      }
      speechDetectedAt = 0;
      silenceDetectedAt = 0;
      return;
    }

    // Resolve voice activity: use model provider if available, else RMS thresholds
    let isVoice: boolean;
    let isSilence: boolean;
    if (vadProvider && vadModelId !== 'rms') {
      const result = vadProvider.process(samples);
      isVoice = result.isVoice;
      isSilence = !result.isVoice;
    } else {
      const gate = Math.max(0.008, state.config?.vadNoiseGate ?? 0.008);
      const startThreshold = Math.max(0.018, gate * 2.5);
      const stopThreshold = Math.max(0.01, gate * 1.5);
      isVoice = rms >= startThreshold;
      isSilence = rms <= stopThreshold;
    }

    const now = Date.now();

    if (isVoice) {
      lastVoiceDetectedAt = now;
    }

    const activeVoice = isVoice || ((now - lastVoiceDetectedAt) < 300);

    if (!state.recording) {
      if (state.listenState === 'Uploading...' || state.listenState === 'Thinking...') {
        return;
      }
      if (activeVoice) {
        speechDetectedAt = speechDetectedAt || now;
        if (now - speechDetectedAt >= HANDSFREE_START_HOLD_MS) {
          lastSpeechStart = speechDetectedAt;
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

    // Must be completely silent for 900ms (so total ~1.2s since last actual voice)
    if (!activeVoice) {
      silenceDetectedAt = silenceDetectedAt || now;
      if (now - silenceDetectedAt >= HANDSFREE_STOP_SILENCE_MS) {
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

  function bindHeadSpeechObserver(): void {
    if (anyHeadSpeechHandler) {
      return;
    }
    anyHeadSpeechHandler = (event: Event) => {
      const detail = (event as CustomEvent<{
        actor?: 'main' | 'small';
        state?: 'start' | 'end';
        ts?: number;
      }>).detail;
      const actor = detail?.actor === 'small' ? 'small' : 'main';
      const ts = detail?.ts ?? Date.now();
      if (detail?.state === 'start') {
        speakingActors.set(actor, ts + HEAD_SPEECH_STALE_MS);
        speechCaptureBlockedUntil = Math.max(speechCaptureBlockedUntil, ts + SPEECH_CAPTURE_COOLDOWN_MS);
        if (!manualPressActive) {
          store.setState((current) => ({
            ...current,
            currentIncomingText: '',
            liveTranscriptText: '',
            liveTranscriptDraft: false,
          }));
          lastLiveTranscript = '';
          stopLiveRecognition();
          if (store.getState().recording && recordingMode === 'handsfree') {
            stopRecording('handsfree', { discard: true });
          }
        }
      } else {
        speakingActors.delete(actor);
        speechCaptureBlockedUntil = Math.max(speechCaptureBlockedUntil, ts + SPEECH_CAPTURE_COOLDOWN_MS);
      }
      syncPassiveLiveRecognition();
    };
    window.addEventListener('tubs:any-head-speech-state', anyHeadSpeechHandler as EventListener);
  }

  function unbindHeadSpeechObserver(): void {
    if (!anyHeadSpeechHandler) {
      return;
    }
    window.removeEventListener('tubs:any-head-speech-state', anyHeadSpeechHandler as EventListener);
    anyHeadSpeechHandler = null;
  }

  function isSpeechCaptureBlocked(allowManual = false): boolean {
    if (allowManual && (manualPressActive || recordingMode === 'manual')) {
      return false;
    }
    const now = Date.now();
    for (const [actor, until] of speakingActors.entries()) {
      if (until <= now) {
        speakingActors.delete(actor);
      }
    }
    return speakingActors.size > 0 || now < speechCaptureBlockedUntil;
  }
}

function getSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  const scopedWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };

  return scopedWindow.SpeechRecognition ?? scopedWindow.webkitSpeechRecognition ?? null;
}
