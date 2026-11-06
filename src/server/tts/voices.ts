/**
 * Cloned voices served by the separate Ming service. Ming wants whole replies
 * (sentence by sentence the intonation resets) and plain text (no Kokoro
 * phoneme markup).
 */
export function isMingVoice(voice: string): boolean {
  return voice.startsWith('ming:');
}

// The speech service reaches Ming at MING_TTS_URL; the server starts it on MING_PORT.
const MING_URL = (process.env.MING_TTS_URL || `http://127.0.0.1:${process.env.MING_PORT || '3003'}`).replace(/\/+$/, '');

/**
 * Whether Ming has its model loaded and knows this voice. Until then the
 * speech service speaks a ming: voice with its Kokoro fallback, so anything
 * rendered to keep (the fillers) would keep the wrong voice.
 */
export async function mingVoiceReady(voice: string): Promise<boolean> {
  try {
    const response = await fetch(`${MING_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    const health = (await response.json()) as { ready?: boolean; voices?: Record<string, unknown> };
    return health.ready === true && Boolean(health.voices?.[voice.slice('ming:'.length) || 'friend']);
  } catch {
    return false;
  }
}
