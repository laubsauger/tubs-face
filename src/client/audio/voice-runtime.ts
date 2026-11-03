import type { VoiceResponse } from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';
import { upsertChatDraft } from '../chat/state.js';
import { createVadProvider, type VadModelId, type VadProvider } from './vad/index.js';
import { createClipBuffer, encodeWav16k, type ClipBuffer } from './pcm-clip.js';
import { createPcmTap } from './pcm-tap.js';

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
  // Plus the 300 ms voice hangover below: about 1 s of quiet ends the turn.
  const HANDSFREE_STOP_SILENCE_MS = 700;
  // Recording starts on the first voiced frame so no word is clipped; clips
  // with less real speech than this are room noise and are not uploaded.
  const HANDSFREE_MIN_VOICED_MS = 350;
  const SPEECH_CAPTURE_COOLDOWN_MS = 650;
  const BARGE_IN_SETTLE_MS = 180;
  const THINKING_RESET_MS = 20_000;
  const ASLEEP_SPEECH_WAKE_MS = 500;
  // Audio kept from before speech was detected, so the first word survives.
  const PRE_ROLL_MS = 700;
  const MAX_CLIP_MS = 12_000;
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
  let vadNoiseGateApplied = 0;
  let thinkingResetTimer: number | undefined;
  let asleepSpeechSince = 0;
  let handsfreeVoicedMs = 0;
  // Pre-roll capture; MediaRecorder is only the fallback when AudioWorklet fails.
  let clipBuffer: ClipBuffer | null = null;
  let stopPcmTap: (() => void) | null = null;
  let lastVadTickAt = 0;
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
      // Hot-switch VAD model (or the RMS noise gate) when config changes
      store.subscribeSelector(
        (s) => `${s.config?.vadModel}:${s.config?.vadNoiseGate}`,
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
      stopPcmTap?.();
      stopPcmTap = null;
      clipBuffer = null;
      unbindHeadSpeechObserver();
      speakingActors.clear();
      speechCaptureBlockedUntil = 0;
      unbindUnlockHandlers();
      window.clearTimeout(thinkingResetTimer);
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
      try {
        clipBuffer = createClipBuffer(audioContext.sampleRate, PRE_ROLL_MS, MAX_CLIP_MS);
        stopPcmTap = await createPcmTap(audioContext, source, (chunk) => {
          clipBuffer?.push(chunk);
          // The VAD expects a continuous stream; the analyser in the meter loop
          // only gives it 256-sample snippets with gaps between frames.
          handleHandsFreeVad(rmsOf(chunk), chunk);
        });
      } catch (error) {
        clipBuffer = null;
        store.appendLog('error', `Pre-roll capture unavailable, first words may be cut: ${error instanceof Error ? error.message : String(error)}`);
      }
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
      handleRecordedClip(blob);
    };
    return recorder;
  }

  function isCapturing(): boolean {
    return Boolean(clipBuffer?.capturing) || mediaRecorder?.state === 'recording';
  }

  function handleRecordedClip(blob: Blob): void {
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
  }

  async function startRecording(mode: 'manual' | 'handsfree'): Promise<void> {
    // The server drops input while muted; don't record and upload it either.
    if (store.getState().recording || store.getState().config?.muted) {
      return;
    }
    await ensureMicrophone();
    if (isCapturing() || (!clipBuffer && !mediaRecorder) || !store.getState().micReady) {
      return;
    }
    if (mode === 'handsfree' && (store.getState().audioPlaying || store.getState().sleeping || isSpeechCaptureBlocked())) {
      return;
    }

    const state = store.getState();
    // Only audible playback matters for the pre-roll: it would hold Tubs's own
    // voice. (currentSpeechText can linger after playback has ended.)
    const tubsAudible = state.audioPlaying;
    if (state.audioPlaying || state.currentSpeechText) {
      stopLiveRecognition();
      lastLiveTranscript = '';
      store.setState((current) => ({
        ...current,
        currentIncomingText: '',
        liveTranscriptText: '',
        liveTranscriptDraft: false,
      }));
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
      if (state.audioPlaying) {
        speechCaptureBlockedUntil = Math.max(speechCaptureBlockedUntil, Date.now() + BARGE_IN_SETTLE_MS);
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, BARGE_IN_SETTLE_MS);
        });
      }
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
    if (clipBuffer) {
      clipBuffer.begin({ preRoll: !tubsAudible });
    } else {
      mediaRecorder?.start(250);
    }
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
    if (!isCapturing()) {
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
    stopLiveRecognition();
    lastSpeechStop = Date.now();
    recordingMode = null;
    if (clipBuffer?.capturing) {
      const samples = clipBuffer.end();
      const sampleRate = audioContext?.sampleRate ?? 48_000;
      handleRecordedClip(samples.length > 0
        ? new Blob([encodeWav16k(samples, sampleRate)], { type: 'audio/wav' })
        : new Blob([], { type: 'audio/wav' }));
      return;
    }
    try {
      mediaRecorder?.requestData();
    } catch {
      // ignore
    }
    mediaRecorder?.stop();
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
      const json = await response.json() as VoiceResponse & { error?: string };
      if (!response.ok) {
        throw new Error(json.error || `${response.status} ${response.statusText}`);
      }
      store.appendLog(
        'info',
        `Voice bridge replied ${json.ignored ? `ignored (${json.reason ?? 'unknown'})` : 'ok'}`,
      );
      // An accepted clip is shown through the server's `incoming` message and
      // cleared by `turn_start`. An ignored one (no wake word, noise) should
      // not leave its live-recognition draft on screen.
      store.setState((current) => ({
        ...current,
        listenState: json.ignored ? 'Ignored' : 'Thinking...',
        voiceLastTranscript: json.text ?? '',
        ...(json.ignored ? { liveTranscriptText: '', liveTranscriptDraft: false } : {}),
      }));
      if (json.text) {
        store.appendLog('info', `Voice: ${json.text}`);
      } else {
        store.appendLog('info', 'Voice upload completed with empty transcript');
      }
      lastLiveTranscript = '';
      if (!json.ignored) {
        scheduleThinkingReset();
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
      if (isSpeechCaptureBlocked()) {
        return;
      }
      let finalTranscript = '';
      let interimTranscript = '';
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result || result.length === 0) {
          continue;
        }
        const transcript = result[0]?.transcript ?? result.item(0)?.transcript ?? '';
        if (!transcript) {
          continue;
        }
        if (result.isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }
      const normalized = `${finalTranscript} ${interimTranscript}`.trim();
      if (!normalized) {
        return;
      }
      lastLiveTranscript = normalized;
      store.setState((current) => ({
        ...upsertChatDraft(current, 'in', normalized),
        currentIncomingText: normalized,
        liveTranscriptText: normalized,
        liveTranscriptDraft: interimTranscript.trim().length > 0 || current.recording,
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

  /**
   * Asleep, nothing is recorded, but about half a second of speech wakes Tubs
   * (sleep-runtime listens for the event). Only with always-listen on, so an
   * operator can keep it asleep in a noisy room.
   */
  function detectSpeechWhileAsleep(state: ReturnType<AppStore['getState']>, rms: number, samples: Float32Array): void {
    if (!state.voiceHandsFreeEnabled || !state.micReady) {
      asleepSpeechSince = 0;
      return;
    }
    const gate = Math.max(0.008, state.config?.vadNoiseGate ?? 0.008);
    const isVoice = vadProvider && vadModelId !== 'rms'
      ? vadProvider.process(samples).isVoice
      : rms >= Math.max(0.018, gate * 2.5);
    const now = Date.now();
    if (isVoice) {
      lastVoiceDetectedAt = now;
      asleepSpeechSince = asleepSpeechSince || now;
      if (now - asleepSpeechSince >= ASLEEP_SPEECH_WAKE_MS) {
        asleepSpeechSince = 0;
        window.dispatchEvent(new CustomEvent('tubs:voice-presence'));
      }
    } else if (now - lastVoiceDetectedAt > 300) {
      asleepSpeechSince = 0;
    }
  }

  /**
   * Hands-free waits while listenState is "Thinking...". Speech playback clears
   * it, but a turn that never speaks (superseded, dropped) would leave the mic
   * deaf, so give up after a while.
   */
  function scheduleThinkingReset(): void {
    window.clearTimeout(thinkingResetTimer);
    thinkingResetTimer = window.setTimeout(() => {
      const state = store.getState();
      if (state.listenState === 'Thinking...' && !state.audioPlaying) {
        store.setState((current) => ({
          ...current,
          listenState: current.voiceHandsFreeEnabled ? passiveListenState() : 'Idle',
        }));
        syncPassiveLiveRecognition();
      }
    }, THINKING_RESET_MS);
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
      const micLevel = Math.max(0, Math.min(1, rms * 8));
      // Every store write re-runs every subscriber; skip changes the meter can't show.
      if (Math.abs(micLevel - store.getState().micLevel) >= 0.01) {
        store.setState((current) => ({ ...current, micLevel }));
      }
      if (!stopPcmTap) {
        handleHandsFreeVad(rms, samples);
      }
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
    const noiseGate = store.getState().config?.vadNoiseGate ?? 0.008;
    // The RMS VAD bakes the noise gate in at creation, so a new gate needs a new provider.
    if (vadProvider && vadModelId === configModel && (configModel !== 'rms' || vadNoiseGateApplied === noiseGate)) {
      return;
    }
    vadProvider?.dispose();
    vadProvider = null;
    vadModelId = configModel;
    vadNoiseGateApplied = noiseGate;
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
    if (state.sleeping) {
      detectSpeechWhileAsleep(state, rms, samples);
    }
    if (!state.voiceHandsFreeEnabled || !state.micReady || state.sleeping || state.audioPlaying || manualPressActive || isSpeechCaptureBlocked()) {
      // Also when hands-free was switched off mid-clip: nothing else would end it,
      // and the open recording blocked push-to-talk.
      if (state.recording && recordingMode === 'handsfree' && (isSpeechCaptureBlocked() || !state.voiceHandsFreeEnabled)) {
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
    const tickMs = lastVadTickAt ? Math.min(50, now - lastVadTickAt) : 0;
    lastVadTickAt = now;

    if (isVoice) {
      lastVoiceDetectedAt = now;
      if (state.recording && recordingMode === 'handsfree') {
        handsfreeVoicedMs += tickMs;
      }
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
          handsfreeVoicedMs = 0;
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
      finishHandsFreeRecording();
      return;
    }

    if (!activeVoice) {
      silenceDetectedAt = silenceDetectedAt || now;
      if (now - silenceDetectedAt >= HANDSFREE_STOP_SILENCE_MS) {
        silenceDetectedAt = 0;
        finishHandsFreeRecording();
      }
    } else {
      silenceDetectedAt = 0;
    }
  }

  function rmsOf(samples: Float32Array): number {
    let sum = 0;
    for (const sample of samples) {
      sum += sample * sample;
    }
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  function finishHandsFreeRecording(): void {
    const isNoise = handsfreeVoicedMs < HANDSFREE_MIN_VOICED_MS;
    if (isNoise) {
      store.appendLog('info', `Hands-free: dropped ${Math.round(handsfreeVoicedMs)} ms clip as noise`);
    }
    handsfreeVoicedMs = 0;
    stopRecording('handsfree', isNoise ? { discard: true } : undefined);
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
        store.setState((current) => ({
          ...current,
          currentIncomingText: '',
          liveTranscriptText: '',
          liveTranscriptDraft: false,
        }));
        lastLiveTranscript = '';
        stopLiveRecognition();
        if (!manualPressActive && store.getState().recording && recordingMode === 'handsfree') {
          stopRecording('handsfree', { discard: true });
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
