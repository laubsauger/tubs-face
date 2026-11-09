// Real eyes don't glide after what they look at. They hold still on one point
// (a fixation), then jump to the next in a quick saccade. Steering the eyes
// with a spring toward the raw camera face box made them follow every wobble
// of the detector, which read as nervous.
//
// Gaze units are the store's: -1..1 on each axis, 0 is straight ahead.

/** Low-pass on noisy, continuous targets (the camera face box, the pointer). */
export const GAZE_TARGET_SMOOTHING_MS = 160;
/** A tracked target has to move this far from the fixation before the eyes follow it. */
export const GAZE_DEAD_ZONE = 0.06;
/** At most one saccade per this window; the eyes hold still in between. */
export const GAZE_MIN_FIXATION_MS = 300;
/** Saccade length: a base plus a bit per unit travelled, like real eyes. */
export const SACCADE_BASE_MS = 70;
export const SACCADE_MS_PER_UNIT = 110;
export const SACCADE_MAX_MS = 170;
/** Micro-saccades are tiny jumps around the fixation point. */
export const MICRO_SACCADE_MS = 45;
/** A target that went quiet this long restarts the filter instead of sliding over from a stale point. */
const TRACK_STALE_MS = 400;
/** Deliberate looks (wander, thinking, a new person) are honoured exactly. */
const LOOK_EPSILON = 0.002;
/**
 * The studio director's look is a steadily moving target (a head floating
 * past windows, updated up to 10 times a second): the eyes follow it
 * smoothly, critically damped, reaching 95 % of each new target in this long.
 * Saccades there read as the face jumping around.
 */
export const GAZE_PURSUIT_MS = 160;
const PURSUIT_OMEGA = 4.74 / GAZE_PURSUIT_MS; // critically damped: 95 % at ωt ≈ 4.74
/** A frame longer than this (a stalled tab) is followed as if it were this long. */
const PURSUIT_MAX_STEP_MS = 100;
const PURSUIT_REST = 0.0005;

export interface GazeSample {
  x: number;
  y: number;
  /** True while a saccade runs or one is waiting for the fixation to end. */
  moving: boolean;
}

export interface GazeController {
  /** A noisy, continuous target. Smoothed, and ignored while it stays inside the dead zone. */
  track(x: number, y: number, nowMs: number): void;
  /** A deliberate look, taken as is at the next allowed saccade. */
  lookAt(x: number, y: number, nowMs: number): void;
  /** A tiny offset around the current fixation; it bypasses the dead zone and ends with the next saccade. */
  microSaccade(dx: number, dy: number, nowMs: number): void;
  /** A moving target to follow smoothly (no saccades) until track or lookAt takes over. */
  pursue(x: number, y: number, nowMs: number): void;
  /** Where the eyes are at nowMs, written into out (no allocation per frame). */
  sample(nowMs: number, out: GazeSample): GazeSample;
}

export function createGazeController(): GazeController {
  let filtX = 0;
  let filtY = 0;
  let lastTrackAt = Number.NEGATIVE_INFINITY;
  let desiredX = 0;
  let desiredY = 0;
  let desiredDeadZone = LOOK_EPSILON;
  // The fixation is where the current (or last) saccade lands.
  let fixX = 0;
  let fixY = 0;
  let lastSaccadeAt = Number.NEGATIVE_INFINITY;
  let saccadeActive = false;
  let fromX = 0;
  let fromY = 0;
  let saccadeStart = 0;
  let saccadeMs = 0;
  let microFromX = 0;
  let microFromY = 0;
  let microToX = 0;
  let microToY = 0;
  let microStart = Number.NEGATIVE_INFINITY;
  // Smooth pursuit: position and velocity (per ms) of the followed point.
  let pursuing = false;
  let pursueX = 0;
  let pursueY = 0;
  let pursueVX = 0;
  let pursueVY = 0;
  let pursueTargetX = 0;
  let pursueTargetY = 0;
  let pursueAt = 0;
  // Where the eyes were last drawn, without the micro offset: the next mode starts from here.
  let baseX = 0;
  let baseY = 0;

  /** Saccades and fixations again, from where pursuit left the eyes. */
  function endPursuit(): void {
    if (!pursuing) return;
    pursuing = false;
    fixX = baseX;
    fixY = baseY;
    saccadeActive = false;
  }

  return {
    pursue(x, y, nowMs) {
      if (!pursuing) {
        pursuing = true;
        pursueX = baseX;
        pursueY = baseY;
        pursueVX = 0;
        pursueVY = 0;
        pursueAt = nowMs;
        saccadeActive = false;
      }
      pursueTargetX = x;
      pursueTargetY = y;
    },
    track(x, y, nowMs) {
      endPursuit();
      const dt = nowMs - lastTrackAt;
      if (dt > TRACK_STALE_MS) {
        filtX = x;
        filtY = y;
      } else if (dt > 0) {
        const a = 1 - Math.exp(-dt / GAZE_TARGET_SMOOTHING_MS);
        filtX += (x - filtX) * a;
        filtY += (y - filtY) * a;
      }
      lastTrackAt = nowMs;
      desiredX = filtX;
      desiredY = filtY;
      desiredDeadZone = GAZE_DEAD_ZONE;
    },
    lookAt(x, y, nowMs) {
      endPursuit();
      desiredX = x;
      desiredY = y;
      desiredDeadZone = LOOK_EPSILON;
      // Tracking that resumes right after (a new person) continues from here.
      filtX = x;
      filtY = y;
      lastTrackAt = nowMs;
    },
    microSaccade(dx, dy, nowMs) {
      microFromX = microOffset(nowMs, 'x');
      microFromY = microOffset(nowMs, 'y');
      microToX = dx;
      microToY = dy;
      microStart = nowMs;
    },
    sample(nowMs, out) {
      if (pursuing) {
        const dt = Math.min(PURSUIT_MAX_STEP_MS, Math.max(0, nowMs - pursueAt));
        pursueAt = nowMs;
        [pursueX, pursueVX] = criticallyDamped(pursueX, pursueVX, pursueTargetX, dt);
        [pursueY, pursueVY] = criticallyDamped(pursueY, pursueVY, pursueTargetY, dt);
        baseX = pursueX;
        baseY = pursueY;
        out.x = pursueX + microOffset(nowMs, 'x');
        out.y = pursueY + microOffset(nowMs, 'y');
        out.moving = Math.hypot(pursueTargetX - pursueX, pursueTargetY - pursueY) > PURSUIT_REST
          || Math.hypot(pursueVX, pursueVY) * 16 > PURSUIT_REST
          || nowMs < microStart + MICRO_SACCADE_MS;
        return out;
      }
      if (saccadeActive && nowMs >= saccadeStart + saccadeMs) {
        saccadeActive = false;
      }
      const pending = Math.hypot(desiredX - fixX, desiredY - fixY) > desiredDeadZone;
      if (pending && !saccadeActive && nowMs - lastSaccadeAt >= GAZE_MIN_FIXATION_MS) {
        // Start from where the eyes are now, micro offset included, so nothing jumps.
        fromX = fixX + microOffset(nowMs, 'x');
        fromY = fixY + microOffset(nowMs, 'y');
        fixX = desiredX;
        fixY = desiredY;
        microFromX = 0;
        microFromY = 0;
        microToX = 0;
        microToY = 0;
        saccadeMs = saccadeDurationMs(Math.hypot(fixX - fromX, fixY - fromY));
        saccadeStart = nowMs;
        saccadeActive = true;
        lastSaccadeAt = nowMs;
      }

      let x = fixX;
      let y = fixY;
      if (saccadeActive) {
        const e = easeOutCubic((nowMs - saccadeStart) / saccadeMs);
        x = fromX + (fixX - fromX) * e;
        y = fromY + (fixY - fromY) * e;
      }
      baseX = x;
      baseY = y;
      out.x = x + microOffset(nowMs, 'x');
      out.y = y + microOffset(nowMs, 'y');
      const stillPending = Math.hypot(desiredX - fixX, desiredY - fixY) > desiredDeadZone;
      out.moving = saccadeActive || stillPending || nowMs < microStart + MICRO_SACCADE_MS;
      return out;
    },
  };

  function microOffset(nowMs: number, axis: 'x' | 'y'): number {
    const e = easeOutCubic((nowMs - microStart) / MICRO_SACCADE_MS);
    return axis === 'x'
      ? microFromX + (microToX - microFromX) * e
      : microFromY + (microToY - microFromY) * e;
  }
}

/**
 * One step of a critically damped spring toward target, solved exactly (stable
 * at any frame time): no overshoot, no oscillation, 95 % there after GAZE_PURSUIT_MS.
 */
export function criticallyDamped(position: number, velocity: number, target: number, dtMs: number): [number, number] {
  const w = PURSUIT_OMEGA;
  const offset = position - target;
  const k = velocity + w * offset;
  const decay = Math.exp(-w * dtMs);
  return [target + (offset + k * dtMs) * decay, (velocity - w * k * dtMs) * decay];
}

export function saccadeDurationMs(distance: number): number {
  return Math.min(SACCADE_MAX_MS, SACCADE_BASE_MS + SACCADE_MS_PER_UNIT * distance);
}

export function easeOutCubic(t: number): number {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const inv = 1 - c;
  return 1 - inv * inv * inv;
}

/**
 * Index of the face whose box centre is closest to (x, y), in frame pixels.
 * Detections come in no fixed order, so following an index jumped between
 * people whenever the detector reordered them.
 */
export function nearestFaceIndex(faces: ReadonlyArray<{ box: readonly [number, number, number, number] }>, x: number, y: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < faces.length; index += 1) {
    const box = faces[index]?.box;
    if (!box) continue;
    const distance = Math.hypot((box[0] + box[2]) / 2 - x, (box[1] + box[3]) / 2 - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}
