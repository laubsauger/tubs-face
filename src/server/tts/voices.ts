/**
 * Cloned voices served by the separate Ming service. Ming wants whole replies
 * (sentence by sentence the intonation resets) and plain text (no Kokoro
 * phoneme markup).
 */
export function isMingVoice(voice: string): boolean {
  return voice.startsWith('ming:');
}
