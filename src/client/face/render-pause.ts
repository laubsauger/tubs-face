/**
 * Face checks wait while a voice renders: on the Mac, Ming shares memory and
 * power with everything else, and Ming must never be slowed for face
 * detection (the user, Nov 2026). The server says when rendering starts and
 * stops; a lost "stopped" must not blind Tubs for good, so the wait is capped.
 */
export const RENDER_PAUSE_MAX_MS = 30_000;
/** How soon a waiting check looks again, so it runs right after the render. */
export const RENDER_PAUSE_POLL_MS = 250;

export function faceChecksPaused(renderingSince: number | null, now: number): boolean {
  return renderingSince != null && now - renderingSince < RENDER_PAUSE_MAX_MS;
}
