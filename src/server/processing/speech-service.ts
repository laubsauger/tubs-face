import { createPythonServiceController, buildRealtimeServiceEnv } from './process-service.js';
import type { TranscriptionResult, TtsProxyTarget } from './types.js';

/**
 * The Python speech service (realtime-processing-service.py): Kokoro TTS,
 * streamed over a WebSocket, and Whisper (MLX) speech-to-text. Started and
 * supervised by the server, restarted with backoff if it dies.
 */

const SPEECH_SERVICE_PORT = Number.parseInt(process.env.REALTIME_PROCESSING_PORT || '3002', 10) || 3002;

const service = createPythonServiceController({
  scriptName: 'realtime-processing-service.py',
  port: SPEECH_SERVICE_PORT,
  envFactory: () => buildRealtimeServiceEnv(),
  logPrefix: '[realtime-python]',
});

export function startProcessingStack(): void {
  service.start();
}

export function stopProcessingStack(timeoutMs = 5000): Promise<boolean> {
  return service.stop(timeoutMs);
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
