// Records the face window as the room sees and hears it, so a session can be
// shared without a screen recorder: the tab's pixels, the tab's audio (Tubs'
// voice, and Small's from the mini tile) and the mic (the visitors). Each
// piece goes to the server as soon as it is recorded (src/server/recordings.ts),
// so a crash or a reload loses a second, not the take.

import type { RecordingFileRequest, RecordingFinishResponse, RecordingStartRequest, RecordingStartResponse } from '../../shared/contracts/http.js';
import type { AppState, AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';

// MP4 first: QuickTime and most upload forms take it, Chrome records it since 126.
const MIME_TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
const PIECE_MS = 1000;
const VIDEO_BITS_PER_SECOND = 8_000_000;
const AUDIO_BITS_PER_SECOND = 192_000;
// The face is a pixel grid; 1920 on the long side keeps it sharp and the encoder at ease on a Retina tab.
const MAX_SIDE = 1920;

export interface ScreenRecorder {
  /** Starts (needs a click or key press: Chrome asks to share the tab) or stops. */
  toggle(): Promise<void>;
  stop(): void;
  dispose(): void;
}

interface Session {
  recorder: MediaRecorder;
  uploader: ChunkUploader;
  file: string;
  release(): void;
}

export function createScreenRecorder(store: AppStore): ScreenRecorder {
  let session: Session | null = null;
  const setRecording = (patch: Partial<Pick<AppState, 'screenRecording' | 'screenRecordingSince' | 'screenRecordingFile'>>) =>
    store.setState((current) => ({ ...current, ...patch }));

  async function start(): Promise<void> {
    const mimeType = typeof MediaRecorder === 'undefined' ? undefined : MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    if (!navigator.mediaDevices?.getDisplayMedia || !mimeType) {
      store.appendLog('error', 'Recording needs a browser with tab capture and MediaRecorder (Chrome)');
      return;
    }
    setRecording({ screenRecording: 'starting' });
    // Made inside the click or key press, so the browser lets it run.
    const mix = new AudioContext({ sampleRate: 48_000 });
    void mix.resume().catch(() => {});
    const tracks: MediaStreamTrack[] = [];
    const release = () => {
      for (const track of tracks) track.stop();
      void mix.close().catch(() => {});
    };

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, width: { max: MAX_SIDE }, height: { max: MAX_SIDE } },
        // Keep playing in the room: the recording takes a copy.
        audio: { suppressLocalAudioPlayback: false } as MediaTrackConstraints,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude',
      } as DisplayMediaStreamOptions);
      tracks.push(...display.getTracks());

      const audioOut = mix.createMediaStreamDestination();
      // Tubs and a loud visitor at once would clip the sum; a limiter keeps it clean.
      const limiter = new DynamicsCompressorNode(mix, { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });
      limiter.connect(audioOut);
      const tabAudio = display.getAudioTracks();
      if (tabAudio.length > 0) {
        mix.createMediaStreamSource(new MediaStream(tabAudio)).connect(limiter);
      } else {
        store.appendLog('error', "Recording without Tubs' voice: tab audio was not shared. Leave \"Also share tab audio\" on next time.");
      }
      // Echo cancellation keeps Tubs' own voice (already in the tab audio) out of the mic.
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).catch((error: unknown) => {
        store.appendLog('error', `Recording without the mic: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (mic) {
        tracks.push(...mic.getTracks());
        mix.createMediaStreamSource(mic).connect(limiter);
      }

      const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
      const { file, dir } = await postJson<RecordingStartRequest, RecordingStartResponse>('/api/recordings', { ext });
      const recorder = new MediaRecorder(new MediaStream([...display.getVideoTracks(), ...audioOut.stream.getAudioTracks()]), {
        mimeType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      const uploader = createChunkUploader((chunk, offset) => sendPiece(file, chunk, offset), (error) => {
        store.appendLog('error', `Recording stopped, pieces no longer reach the server: ${error.message}`);
        stop();
      });
      const current: Session = { recorder, uploader, file, release };
      recorder.ondataavailable = (event) => uploader.push(event.data);
      recorder.onstop = () => void finish(current);
      // Chrome's own "Stop sharing" button ends the take too.
      display.getVideoTracks()[0]?.addEventListener('ended', () => stop());
      recorder.start(PIECE_MS);
      session = current;
      setRecording({ screenRecording: 'recording', screenRecordingSince: Date.now(), screenRecordingFile: null });
      store.appendLog('info', `Recording to ${dir}/${file}`);
    } catch (error) {
      release();
      setRecording({ screenRecording: 'idle' });
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        store.appendLog('info', 'Recording cancelled');
      } else {
        store.appendLog('error', `Recording failed to start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function finish(current: Session): Promise<void> {
    current.release();
    session = null;
    await current.uploader.drain();
    try {
      const saved = await postJson<RecordingFileRequest, RecordingFinishResponse>('/api/recordings/finish', { file: current.file });
      setRecording({ screenRecording: 'idle', screenRecordingSince: null, screenRecordingFile: saved.file });
      store.appendLog('info', `Recording saved: ${saved.path}`);
    } catch (error) {
      setRecording({ screenRecording: 'idle', screenRecordingSince: null, screenRecordingFile: current.file });
      store.appendLog('error', `Recording ${current.file} was not closed, its pieces stay as .part: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function stop(): void {
    if (!session || session.recorder.state === 'inactive') return;
    setRecording({ screenRecording: 'saving' });
    session.recorder.stop();
  }

  return {
    async toggle() {
      const phase = store.getState().screenRecording;
      if (phase === 'recording') stop();
      else if (phase === 'idle') await start();
    },
    stop,
    dispose: stop,
  };
}

async function sendPiece(file: string, chunk: Blob, offset: number): Promise<void> {
  const response = await fetch(`/api/recordings/chunk?file=${encodeURIComponent(file)}&offset=${offset}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: chunk,
  });
  if (response.ok) return;
  const error = new Error(`${response.status} ${await response.text().catch(() => '')}`.trim());
  // 4xx: the server refuses this piece and will keep refusing it.
  throw Object.assign(error, { permanent: response.status >= 400 && response.status < 500 });
}

export interface ChunkUploader {
  push(chunk: Blob): void;
  /** Resolves once every piece pushed so far is stored, or the uploader gave up. */
  drain(): Promise<void>;
}

/**
 * Sends recorded pieces one at a time, in order, each with the byte offset it
 * starts at. A piece that fails is resent (the server is local, it comes back
 * after a restart) while later pieces wait; after `giveUpMs` of failing, or a
 * refusal, it gives up and calls `onFail` once.
 */
export function createChunkUploader(
  send: (chunk: Blob, offset: number) => Promise<void>,
  onFail: (error: Error) => void,
  { retryMs = 1000, giveUpMs = 60_000 } = {},
): ChunkUploader {
  const queue: Blob[] = [];
  let offset = 0;
  let failed = false;
  let running: Promise<void> | null = null;

  async function pump(): Promise<void> {
    try {
      while (queue.length > 0 && !failed) {
        const chunk = queue[0]!;
        const firstTry = Date.now();
        for (;;) {
          try {
            await send(chunk, offset);
            break;
          } catch (error) {
            const permanent = Boolean((error as { permanent?: boolean }).permanent);
            if (permanent || Date.now() - firstTry >= giveUpMs) {
              failed = true;
              queue.length = 0;
              onFail(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, retryMs));
          }
        }
        offset += chunk.size;
        queue.shift();
      }
    } finally {
      running = null;
    }
  }

  return {
    push(chunk) {
      if (failed || chunk.size === 0) return;
      queue.push(chunk);
      running ??= pump();
    },
    drain: () => running ?? Promise.resolve(),
  };
}
