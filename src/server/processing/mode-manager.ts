import { runtimeConfig } from '../config/runtime.js';
import { legacyProcessingMode } from './modes/legacy.js';
import { realtimeProcessingMode } from './modes/realtime.js';
import type { ProcessingModeAdapter } from './types.js';

const registry: Record<'legacy' | 'realtime', ProcessingModeAdapter> = {
  legacy: legacyProcessingMode,
  realtime: realtimeProcessingMode,
};

export function getProcessingMode(): 'legacy' | 'realtime' {
  return runtimeConfig.processingMode;
}

export function getModeAdapter(): ProcessingModeAdapter {
  return registry[getProcessingMode()];
}

export function startProcessingStack(options?: { sttModel?: string }): void | Promise<void> {
  return getModeAdapter().startProcessingStack(options);
}

export function stopProcessingStack(timeoutMs = 5000): Promise<boolean> {
  return getModeAdapter().stopProcessingStack(timeoutMs);
}

export function restartTranscriptionService(modelName: string, reason = 'runtime config update'): Promise<void> {
  console.log(`[processing] restarting (${reason}) with sttModel=${modelName}`);
  runtimeConfig.sttModel = modelName;
  return getModeAdapter().restartTranscriptionService(modelName, reason);
}

export function transcribeAudio(audioBuffer: Buffer, mimeType?: string) {
  return getModeAdapter().transcribeAudio(audioBuffer, mimeType);
}

export function getTtsProxyTarget() {
  return getModeAdapter().getTtsProxyTarget();
}
