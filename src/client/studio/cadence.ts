// How steadily a face page renders: frame times in, a summary per report
// window out. A stall the size of a few frames is what reads as a jump in a
// window; an average fps hides it, so the largest gap is reported too.

export const STALL_MS = 50;

export interface CadenceSummary {
  fps: number;
  maxGapMs: number;
  /** Gaps over STALL_MS. */
  stalls: number;
}

export interface CadenceMeter {
  frame(nowMs: number): void;
  /** The summary since the last take; starts a new window. */
  take(nowMs: number): CadenceSummary;
}

export function createCadenceMeter(): CadenceMeter {
  let windowStart = Number.NaN;
  let last = Number.NaN;
  let frames = 0;
  let maxGap = 0;
  let stalls = 0;
  return {
    frame(nowMs) {
      if (Number.isNaN(windowStart)) windowStart = nowMs;
      if (!Number.isNaN(last)) {
        const gap = nowMs - last;
        if (gap > maxGap) maxGap = gap;
        if (gap > STALL_MS) stalls += 1;
      }
      last = nowMs;
      frames += 1;
    },
    take(nowMs) {
      // A window with no frame at all is one long gap.
      if (!Number.isNaN(last) && nowMs - last > maxGap) maxGap = nowMs - last;
      const span = Number.isNaN(windowStart) ? 0 : nowMs - windowStart;
      const summary = { fps: span > 0 ? Math.round((frames / span) * 10_000) / 10 : 0, maxGapMs: Math.round(maxGap), stalls };
      windowStart = nowMs;
      // The time up to now is in this summary; the next window measures from here.
      if (!Number.isNaN(last)) last = nowMs;
      frames = 0;
      maxGap = 0;
      stalls = 0;
      return summary;
    },
  };
}
