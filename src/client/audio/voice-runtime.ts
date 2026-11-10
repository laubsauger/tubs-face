import type { VoiceResponse } from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';
import { upsertChatDraft } from '../chat/state.js';
import { createVadProvider, type VadModelId, type VadProvider } from './vad/index.js';
import { createClipBuffer, encodeWav16k, type ClipBuffer } from './pcm-clip.js';
import { createPcmTap } from './pcm-tap.js';
import { ECHO_TAIL_MS, createEchoBargeIn } from './echo-gate.js';
import { formatMicSource, type MicSourceSpec, type StudioMicStatus } from '../../shared/contracts/studio.js';
import { reconnectDelayMs, whepAudio } from '../transport/whip.js';

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

/**
 * The live caption from a recognition session's results, from index `from` on.
 * Chrome keeps every result of a session for as long as it runs, and each
 * event lists them all again from the start; results before `from` were
 * already handled or were Tubs' own voice from the speakers.
 */
export function liveTranscriptFrom(
  results: ArrayLike<{ isFinal: boolean; length: number; [index: number]: { transcript: string } | undefined }>,
  from: number,
): { text: string; interim: boolean } {
  let finalTranscript = '';
  let interimTranscript = '';
  for (let index = Math.max(0, from); index < results.length; index += 1) {
    const result = results[index];
    const transcript = result && result.length > 0 ? result[0]?.transcript ?? '' : '';
    if (!transcript) continue;
    if (result!.isFinal) finalTranscript += transcript;
    else interimTranscript += transcript;
  }
  return { text: `${finalTranscript} ${interimTranscript}`.trim(), interim: interimTranscript.trim().length > 0 };
}

export interface VoiceRuntime {
  init(): Promise<void>;
  enableMic(): Promise<void>;
  startManualRecording(): Promise<void>;
  stopManualRecording(): void;
  /**
   * Where the mic hears from, switched live: the old source is closed and the
   * new one opened, no reload. `site` is the site node base URL (site: sources).
   */
  setMicSource(source: MicSourceSpec, site?: string): Promise<void>;
  /** Either head is talking (here, or in another window per head_speech_state). */
  headsTalking(): boolean;
  dispose(): void;
}

export interface VoiceRuntimeOptions {
  /** Open no mic until setMicSource says which (the studio listener waits for its settings). */
  deferMic?: boolean;
  /**
   * This page's voice plays somewhere the browser's echo cancellation can't
   * see (a studio stream, a site: mic): mute recognition while a head talks
   * and only take a voice clearly over the echo as talking over it.
   */
  echoGuard?: boolean;
  /** The mic's state, whenever it changes (studio: reported in GET /studio). */
  onMicStatus?: (status: StudioMicStatus) => void;
}

/**
 * Speaking counts as talking over Tubs only while he is audible. His subtitle
 * stays up for a few seconds after he finishes; treating that as a barge-in
 * told the server he had been cut off, and he complained about an interrupt
 * that never happened. A reply still being generated is superseded by the
 * server when the new turn starts, so it needs no interrupt from here.
 */
export function isTalkingOverTubs(state: { audioPlaying: boolean }): boolean {
  return state.audioPlaying;
}

export function createVoiceRuntime(store: AppStore, options: VoiceRuntimeOptions = {}): VoiceRuntime {
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
  // The current session's results: how many there are, and where the caption
  // starts (everything before is handled speech or Tubs' own voice).
  let resultsSeen = 0;
  let resultsFrom = 0;
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
  let lastEchoTickAt = 0;
  let unlockHandlerBound = false;
  let discardPendingRecording = false;
  let anyHeadSpeechHandler: ((event: Event) => void) | null = null;
  let speechCaptureBlockedUntil = 0;
  const speakingActors = new Map<'main' | 'small', number>();
  // Today's behaviour unless told otherwise: the default input device.
  let micSource: MicSourceSpec = { kind: 'local' };
  let micSite = '';
  let micSourceSet = !options.deferMic;
  // Bumped on every switch; an open that finishes for an older source is dropped.
  let micGeneration = 0;
  let micOpening: Promise<void> | null = null;
  let closeMicSource: (() => void) | null = null;
  let micReopenTimer: number | undefined;
  let micReopenAttempt = 0;
  let micError: string | undefined;
  const echoGuard = options.echoGuard === true;
  const echoBargeIn = createEchoBargeIn();
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
    async setMicSource(source, site): Promise<void> {
      const same = micSourceSet && formatMicSource(source) === formatMicSource(micSource) && (source.kind !== 'site' || site === micSite);
      micSourceSet = true;
      if (same) {
        return ensureMicrophone();
      }
      micSource = source;
      micSite = site ?? '';
      micReopenAttempt = 0;
      micError = undefined;
      store.appendLog('info', `Mic source: ${formatMicSource(source)}`);
      releaseMicrophone();
      await ensureMicrophone();
    },
    headsTalking(): boolean {
      return anyHeadTalking();
    },
    dispose(): void {
      stopRecording(recordingMode ?? 'manual');
      window.clearTimeout(micReopenTimer);
      micGeneration += 1;
      if (levelRaf) {
        window.cancelAnimationFrame(levelRaf);
      }
      for (const track of micStream?.getTracks() ?? []) {
        track.stop();
      }
      closeMicSource?.();
      closeMicSource = null;
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

  /** Opens the current source unless it is open (or opening) already. */
  function ensureMicrophone(): Promise<void> {
    if (micStream || !micSourceSet) {
      return Promise.resolve();
    }
    micOpening ??= openMicrophone().finally(() => {
      micOpening = null;
    });
    return micOpening;
  }

  async function openMicrophone(): Promise<void> {
    const generation = micGeneration;
    if (micSource.kind === 'off') {
      store.setState((current) => ({
        ...current,
        micReady: false,
        micDenied: false,
        micLevel: 0,
        listenState: 'Mic off',
      }));
      reportMic();
      return;
    }
    if (micSource.kind !== 'site' && !navigator.mediaDevices?.getUserMedia) {
      store.setState((current) => ({
        ...current,
        micDenied: true,
        listenState: 'Mic unavailable',
      }));
      store.appendLog('error', 'Microphone requires getUserMedia support');
      return;
    }

    try {
      const opened = await openMicStream(micSource);
      if (generation !== micGeneration) {
        // Switched (or disposed) while this one was opening.
        opened.close();
        return;
      }
      micStream = opened.stream;
      closeMicSource = opened.close;
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
      store.appendLog('info', micSource.kind === 'local' && !micSource.label ? 'Microphone ready' : `Microphone ready (${formatMicSource(micSource)})`);
      micError = undefined;
      micReopenAttempt = 0;
      reportMic();
      syncPassiveLiveRecognition();
      startMeterLoop();
    } catch (error) {
      if (generation !== micGeneration) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Microphone access denied';
      store.setState((current) => ({
        ...current,
        micReady: false,
        micDenied: true,
        listenState: 'Mic denied',
      }));
      store.appendLog('error', message);
      micError = message;
      reportMic();
      // A site stream that isn't up yet (or a mic leg restarting) comes back; keep trying.
      if (micSource.kind === 'site') {
        scheduleMicReopen();
      }
    }
  }

  /** The stream for a source; the plain default mic is opened exactly as before. */
  async function openMicStream(source: MicSourceSpec): Promise<{ stream: MediaStream; close: () => void }> {
    const stopTracks = (stream: MediaStream) => () => {
      for (const track of stream.getTracks()) track.stop();
    };
    const processing = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (source.kind === 'site') {
      if (!micSite) throw new Error('No site node URL for the site mic');
      const url = `${micSite}/${source.path}/whep`;
      const generation = micGeneration;
      const audio = await whepAudio(url, (reason) => {
        if (generation !== micGeneration) return;
        store.appendLog('error', `Mic ${formatMicSource(source)}: ${reason}`);
        micError = reason;
        releaseMicrophone();
        scheduleMicReopen();
      });
      return { stream: audio.stream, close: audio.close };
    }
    if (source.kind === 'local' && source.label) {
      const deviceId = await findInputDevice(source.label);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...processing, deviceId: { exact: deviceId } } });
      return { stream, close: stopTracks(stream) };
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return { stream, close: stopTracks(stream) };
  }

  /**
   * The input device with exactly this label, as the browser names it (Chrome
   * adds to the system's name, e.g. "(Built-in)"). Labels show only once the
   * page may use the mic. A miss lists the labels there are.
   */
  async function findInputDevice(label: string): Promise<string> {
    const inputs = async () => (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    let devices = await inputs();
    if (devices.every((device) => !device.label)) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of probe.getTracks()) track.stop();
      devices = await inputs();
    }
    const device = devices.find((candidate) => candidate.label === label);
    if (!device) {
      const labels = [...new Set(devices.map((candidate) => candidate.label).filter(Boolean))];
      throw new Error(`No input device labelled "${label}"${labels.length ? ` (there are: ${labels.map((name) => `"${name}"`).join(', ')})` : ''}`);
    }
    return device.deviceId;
  }

  function scheduleMicReopen(): void {
    window.clearTimeout(micReopenTimer);
    const delay = reconnectDelayMs(micReopenAttempt);
    micReopenAttempt += 1;
    const generation = micGeneration;
    micReopenTimer = window.setTimeout(() => {
      if (generation === micGeneration) {
        void ensureMicrophone();
      }
    }, delay);
  }

  /** Closes the current source and everything built on it; a switch opens the next one. */
  function releaseMicrophone(): void {
    micGeneration += 1;
    window.clearTimeout(micReopenTimer);
    if (isCapturing() && recordingMode) {
      stopRecording(recordingMode, { discard: true });
    }
    if (mediaRecorder?.state === 'recording') {
      discardPendingRecording = true;
      try { mediaRecorder.stop(); } catch { /* ignore */ }
    }
    mediaRecorder = null;
    if (levelRaf) {
      window.cancelAnimationFrame(levelRaf);
      levelRaf = 0;
    }
    analyser = null;
    stopPcmTap?.();
    stopPcmTap = null;
    clipBuffer = null;
    vadProvider?.dispose();
    vadProvider = null;
    closeMicSource?.();
    closeMicSource = null;
    micStream = null;
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => { });
    }
    audioContext = null;
    stopLiveRecognition();
    echoBargeIn.reset();
    store.setState((current) => ({
      ...current,
      micReady: false,
      micDenied: false,
      micLevel: 0,
      recording: false,
    }));
    reportMic();
  }

  function reportMic(): void {
    options.onMicStatus?.({
      source: formatMicSource(micSource),
      listening: Boolean(micStream) && store.getState().micReady,
      ...(micError && !micStream ? { error: micError } : {}),
    });
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
      forgetLiveTranscript();
      store.setState((current) => ({
        ...current,
        recording: false,
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
    if (mode === 'handsfree' && (store.getState().sleeping || (!interruptible() && (store.getState().audioPlaying || isSpeechCaptureBlocked())))) {
      return;
    }
    if (mode === 'handsfree' && echoGuard && captureBlocked()) {
      return;
    }

    const state = store.getState();
    // Only audible playback matters for the pre-roll: it would hold Tubs's own
    // voice. (currentSpeechText can linger after playback has ended.)
    const tubsAudible = state.audioPlaying;
    if (isTalkingOverTubs(state) || (interruptible() && anyHeadTalking())) {
      interruptHeads(state.currentTurnId ?? null);
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
      forgetLiveTranscript();
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
      resultsSeen = event.results.length;
      if (captureBlocked()) {
        // Tubs' own voice: skipped now and in every later event of this session.
        resultsFrom = resultsSeen;
        return;
      }
      const { text: normalized, interim } = liveTranscriptFrom(event.results, resultsFrom);
      if (!normalized) {
        return;
      }
      lastLiveTranscript = normalized;
      store.setState((current) => ({
        ...upsertChatDraft(current, 'in', normalized),
        liveTranscriptText: normalized,
        liveTranscriptDraft: interim || current.recording,
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
    if (!speechRecognition || speechRecognitionRunning || !liveCaptionHearsTheMic()) {
      return;
    }

    try {
      speechRecognition.start();
      resultsSeen = 0;
      resultsFrom = 0;
    } catch {
      // It throws when the session before hasn't ended yet: that one is still
      // running. Marked stopped, it was never stopped again, and its caption
      // grew all night, Tubs' lines included.
    }
    speechRecognitionRunning = true;
  }

  function stopLiveRecognition(): void {
    if (!speechRecognition) {
      return;
    }
    speechRecognitionRunning = false;
    try {
      // Whatever it still had pending is dropped (the server transcribes the clip itself).
      speechRecognition.abort();
    } catch {
      // ignore
    }
  }

  /** The caption starts over: nothing heard so far shows again. */
  function forgetLiveTranscript(): void {
    lastLiveTranscript = '';
    resultsFrom = resultsSeen;
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

  /** The browser's live caption always listens to the default device, so only then is it this mic. */
  function liveCaptionHearsTheMic(): boolean {
    return micSource.kind === 'local' && !micSource.label;
  }

  function shouldKeepPassiveLiveRecognition(): boolean {
    const state = store.getState();
    return Boolean(
      speechRecognitionAvailable
      && liveCaptionHearsTheMic()
      && state.micReady
      && state.voiceHandsFreeEnabled
      && !state.sleeping
      && (interruptible() || (!state.audioPlaying && !isSpeechCaptureBlocked()))
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
    if (!state.voiceHandsFreeEnabled || !state.micReady || state.sleeping || (!interruptible() && state.audioPlaying) || manualPressActive || captureBlocked()) {
      // Also when hands-free was switched off mid-clip: nothing else would end it,
      // and the open recording blocked push-to-talk.
      if (state.recording && recordingMode === 'handsfree' && (captureBlocked() || !state.voiceHandsFreeEnabled)) {
        stopRecording('handsfree', { discard: true });
      }
      speechDetectedAt = 0;
      silenceDetectedAt = 0;
      if (echoGuard) {
        watchForBargeInOverEcho(state, rms);
      }
      return;
    }

    // Resolve voice activity: use model provider if available, else RMS thresholds
    let isVoice: boolean;
    if (vadProvider && vadModelId !== 'rms') {
      const result = vadProvider.process(samples);
      isVoice = result.isVoice;
    } else {
      const gate = Math.max(0.008, state.config?.vadNoiseGate ?? 0.008);
      const startThreshold = Math.max(0.018, gate * 2.5);
      isVoice = rms >= startThreshold;
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

  /**
   * Echo guard: what the mic hears while a head talks is mostly that head, so
   * it is never recorded. With Interruptible on, a voice well over the echo
   * for a while still cuts the heads off; the mic listens again once they are
   * quiet (see echo-gate.ts).
   */
  function watchForBargeInOverEcho(state: ReturnType<AppStore['getState']>, rms: number): void {
    const now = Date.now();
    const dt = lastEchoTickAt ? now - lastEchoTickAt : 0;
    lastEchoTickAt = now;
    if (!interruptible() || !anyHeadTalking() || !state.voiceHandsFreeEnabled || !state.micReady || state.sleeping || manualPressActive) {
      echoBargeIn.reset();
      lastEchoTickAt = 0;
      return;
    }
    if (echoBargeIn.feed(rms, dt)) {
      echoBargeIn.reset();
      store.appendLog('info', 'Someone talked over the heads (well above their echo)');
      interruptHeads(state.currentTurnId ?? null);
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
      // With the echo guard the room plays the voice late and with reverb; wait longer.
      const cooldownMs = echoGuard ? ECHO_TAIL_MS : SPEECH_CAPTURE_COOLDOWN_MS;
      if (detail?.state === 'start') {
        speakingActors.set(actor, ts + HEAD_SPEECH_STALE_MS);
        speechCaptureBlockedUntil = Math.max(speechCaptureBlockedUntil, ts + cooldownMs);
        const visitorTalking = !manualPressActive && store.getState().recording && recordingMode === 'handsfree';
        // Behind the echo guard the clip would fill with the head's voice: it is dropped instead.
        if (interruptible() && visitorTalking && !echoGuard) {
          // The visitor has the floor: the head that just started is cut off, the clip goes on.
          interruptHeads(store.getState().currentTurnId ?? null);
        } else {
          store.setState((current) => ({
            ...current,
            liveTranscriptText: '',
            liveTranscriptDraft: false,
          }));
          forgetLiveTranscript();
          stopLiveRecognition();
          if (visitorTalking) {
            stopRecording('handsfree', { discard: true });
          }
        }
      } else {
        speakingActors.delete(actor);
        speechCaptureBlockedUntil = Math.max(speechCaptureBlockedUntil, ts + cooldownMs);
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

  /** The operator's toggle: speech while a head talks cuts it off instead of being ignored. */
  function interruptible(): boolean {
    return store.getState().config?.interruptible === true;
  }

  /**
   * Speech is ignored while a head talks and just after, unless the heads are
   * interruptible. Behind the echo guard always: the mic hears the head itself.
   */
  function captureBlocked(): boolean {
    if (echoGuard) {
      return store.getState().audioPlaying || isSpeechCaptureBlocked();
    }
    return !interruptible() && isSpeechCaptureBlocked();
  }

  /** Tubs plays here, or either head is talking in another window (Mini's tile or screen). */
  function anyHeadTalking(): boolean {
    isSpeechCaptureBlocked(); // drops heads whose speech state went stale
    return store.getState().audioPlaying || speakingActors.size > 0;
  }

  /** The visitor takes the floor: whoever is talking stops, here and on the server. */
  function interruptHeads(turnId: string | null): void {
    stopLiveRecognition();
    forgetLiveTranscript();
    store.setState((current) => ({
      ...current,
      liveTranscriptText: '',
      liveTranscriptDraft: false,
    }));
    window.dispatchEvent(new CustomEvent('tubs:stop-speech', { detail: { turnId, source: 'voice_barge_in' } }));
    window.dispatchEvent(new CustomEvent('tubs:request-interrupt', { detail: { turnId } }));
  }

  function isSpeechCaptureBlocked(): boolean {
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
