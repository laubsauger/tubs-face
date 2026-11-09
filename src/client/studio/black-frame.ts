// The published face going black while the page still says "publishing" (it
// happened: a WebGPU canvas copied too late reads black in the studio's
// Chrome). The face page looks at its own frame now and then; the face always
// has lit pixels, asleep too, so a frame that stays black means the stream is
// empty and GET /studio must say so.

/** Brightest channel at or below this counts as black (video noise stays under it). */
export const BLACK_LEVEL = 16;
/** Checks in a row before it counts: a single dark frame (a glitch burst) is not an outage. */
export const BLACK_CHECKS = 3;

export interface BlackFrameMonitor {
  /** One look at the published frame: its brightest channel value. Returns whether the stream is black now. */
  check(brightest: number): boolean;
}

export function createBlackFrameMonitor(): BlackFrameMonitor {
  let dark = 0;
  return {
    check(brightest) {
      dark = brightest <= BLACK_LEVEL ? dark + 1 : 0;
      return dark >= BLACK_CHECKS;
    },
  };
}
