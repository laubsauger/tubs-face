/**
 * Whether a voice is being rendered right now: text sent to TTS and not done
 * yet. On the Mac, Ming shares memory and power with everything else, and
 * Ming must never be slowed for face detection (the user, Nov 2026), so the
 * face window pauses its checks while this is on.
 */
let pending = 0;
const listeners = new Set<(rendering: boolean) => void>();

export function isRendering(): boolean {
  return pending > 0;
}

export function onRenderingChange(listener: (rendering: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One render starts; call the returned function when it ends (calling it again does nothing). */
export function beginRender(): () => void {
  pending += 1;
  if (pending === 1) for (const listener of listeners) listener(true);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    pending -= 1;
    if (pending === 0) for (const listener of listeners) listener(false);
  };
}
