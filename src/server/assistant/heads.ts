// Whether a head is still talking, as the pages report it (studio_state in
// studio mode, head_speech_state from a face window), and when the last voice
// was sent and ended. A line Tubs starts on his own (a proactive line, an
// appearance greeting) waits for quiet: started over a head still talking, it
// interrupted that turn and cut its line off mid-word (the reply's generation
// was over, its audio was not).

/** After the last head stopped: the other head's line may still be on its way (the handover breath), and the room still rings. */
export const QUIET_AFTER_SPEECH_MS = 1500;
/** Audio sent this recently is still to be played (held for its face or the handover, or decoding). */
export const AUDIO_PENDING_MS = 4000;

const speaking = new Map<string, boolean>();
let lastEndAt = 0;
let lastAudioAt = 0;

export function noteHeadSpeaking(actor: string, on: boolean, now = Date.now()): void {
  const was = speaking.get(actor) ?? false;
  speaking.set(actor, on);
  if (was && !on) lastEndAt = now;
}

/** An audio_chunk went out to the pages. */
export function noteAudioSent(now = Date.now()): void {
  lastAudioAt = now;
}

/** The head talking now ('main' first), or null. */
export function headSpeaking(): 'main' | 'small' | null {
  return speaking.get('main') ? 'main' : speaking.get('small') ? 'small' : null;
}

/** Nobody talking, nothing about to play, and a moment since the last voice ended. */
export function headsQuiet(now = Date.now()): boolean {
  return headSpeaking() === null && now - lastEndAt >= QUIET_AFTER_SPEECH_MS && now - lastAudioAt >= AUDIO_PENDING_MS;
}

export function resetHeads(): void {
  speaking.clear();
  lastEndAt = 0;
  lastAudioAt = 0;
}
