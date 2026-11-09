import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createPythonServiceController, buildRealtimeServiceEnv } from './process-service.js';
import type { TranscriptionResult, TtsProxyTarget } from './types.js';

/**
 * The Python speech service (realtime-processing-service.py): Kokoro TTS,
 * streamed over a WebSocket, and Whisper (MLX) speech-to-text. Started and
 * supervised by the server, restarted with backoff if it dies.
 */

export const SPEECH_SERVICE_PORT = Number.parseInt(process.env.REALTIME_PROCESSING_PORT || '3002', 10) || 3002;

const service = createPythonServiceController({
  scriptName: 'realtime-processing-service.py',
  port: SPEECH_SERVICE_PORT,
  envFactory: () => buildRealtimeServiceEnv(),
  logPrefix: '[realtime-python]',
});

/**
 * The cloned voices (ming:*) come from the Ming TTS service (ming-tts-service.py),
 * which the speech service calls on this port. It needs a newer mlx than
 * speech-to-text, so it runs from its own venv (npm run setup-ming). Without
 * Ming those voices fail with an error; they never switch to another voice.
 */
export const MING_PORT = Number.parseInt(process.env.MING_PORT || '3003', 10) || 3003;
const MING_VENV = 'venv-ming';

const mingService = createPythonServiceController({
  scriptName: 'ming-tts-service.py',
  port: MING_PORT,
  venvDir: MING_VENV,
  envFactory: () => ({ ...process.env, MING_PORT: String(MING_PORT) }),
  logPrefix: '[ming]',
});

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function startMingService(): Promise<void> {
  if (!fs.existsSync(path.join(process.cwd(), MING_VENV, 'bin', 'python'))) {
    console.error(`[ming] ERROR: no ${MING_VENV}, so the Ming service can't start and the cloned voices (ming:*) can't speak. Run npm run setup-ming.`);
    return;
  }
  // Someone may already run one by hand (or the voice lab copy); use that.
  if (await portInUse(MING_PORT)) {
    console.log(`[ming] port ${MING_PORT} is already serving; using the Ming service running there`);
    return;
  }
  mingService.start();
}

/** Our speech service process is running (it may still be loading its models). */
export function speechServiceRunning(): boolean {
  return service.running();
}

export function startProcessingStack(): void {
  service.start();
  void startMingService();
}

export async function stopProcessingStack(timeoutMs = 5000): Promise<boolean> {
  const [speechStopped] = await Promise.all([service.stop(timeoutMs), mingService.stop(timeoutMs)]);
  return speechStopped;
}

/** A new speech-to-text model only loads on a fresh start of the service. */
export async function restartSpeechService(sttModel: string, reason = 'runtime config update'): Promise<void> {
  console.log(`[processing] restarting (${reason}) with sttModel=${sttModel}`);
  await service.restart();
}

export function transcribeAudio(audioBuffer: Buffer, mimeType = 'audio/webm'): Promise<TranscriptionResult> {
  return service.postAudioMultipart('/transcribe', audioBuffer, mimeType) as Promise<TranscriptionResult>;
}

export function getTtsProxyTarget(): TtsProxyTarget {
  return { hostname: '127.0.0.1', port: SPEECH_SERVICE_PORT, path: '/tts' };
}
