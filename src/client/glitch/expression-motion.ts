import type { ExpressionName } from '../../shared/contracts/config.js';
import { MOTION } from './constants.js';
import type { ShapeCenter } from './pixel-grid.js';

// A held expression used to be a still picture. This adds the small motion a
// living face has: breathing, a pop or hop when a feeling appears, a tremble
// when angry, a slow sink when sad, and the head turning with the gaze. It is
// one scale and offset per eye and mouth, so it costs the shader nothing.

/** Transform of one shape: scale about a pivot, then an offset. */
export interface ShapeMotion {
  sx: number;
  sy: number;
  /** Vertical pivot of the scale: -1 top edge, 0 centre, 1 bottom edge (a lowered lid keeps its bottom edge). */
  pivotY: number;
  /** Offsets, in face heights. */
  ox: number;
  oy: number;
}

export interface FaceMotion {
  left: ShapeMotion;
  right: ShapeMotion;
  mouth: ShapeMotion;
}

export interface ExpressionMotion {
  /**
   * Motion at nowMs for the expression on screen (null holds still, e.g.
   * while the FX editor shows the true shapes), written into out.
   */
  update(expression: ExpressionName | null, nowMs: number, gazeX: number, out: FaceMotion): FaceMotion;
}

/** Floats per shape in the transform uniform: sx, sy, tx, ty. */
export const SHAPE_TRANSFORM_FLOATS = 4;

const BREATHING: ReadonlySet<ExpressionName> = new Set(['idle', 'idle-flat', 'listening']);
const HOPPING: ReadonlySet<ExpressionName> = new Set(['happy', 'smile']);
const TWO_PI = Math.PI * 2;

export function createFaceMotion(): FaceMotion {
  return { left: identity(), right: identity(), mouth: identity() };
}

export function createExpressionMotion(): ExpressionMotion {
  // Held poses, eased toward the current expression's.
  const pose = createFaceMotion();
  const target = createFaceMotion();
  let breath = 0;
  let sleepBreath = 0;
  let tremble = 0;
  let drift = 0;
  let lastExpression: ExpressionName | null = null;
  let lastNow = Number.NaN;
  // Entry accents play out in full even if the expression moves on, so they never cut off mid-swing.
  let popAt = Number.NEGATIVE_INFINITY;
  let hopAt = Number.NEGATIVE_INFINITY;

  return {
    update(expression, nowMs, gazeX, out) {
      const dt = Number.isNaN(lastNow) ? 0 : Math.max(0, Math.min(100, nowMs - lastNow));
      lastNow = nowMs;
      if (expression !== lastExpression) {
        if (expression === 'surprised') popAt = nowMs;
        if (expression && HOPPING.has(expression)) hopAt = nowMs;
        lastExpression = expression;
      }

      targetPose(expression, target);
      const settle = approach(dt, expression === 'sad' || expression === 'crying' ? MOTION.sadSettleMs : MOTION.poseSettleMs);
      easeShape(pose.left, target.left, settle);
      easeShape(pose.right, target.right, settle);
      easeShape(pose.mouth, target.mouth, settle);

      const fade = approach(dt, MOTION.loopFadeMs);
      breath += ((expression && BREATHING.has(expression) ? 1 : 0) - breath) * fade;
      sleepBreath += ((expression === 'sleep' ? 1 : 0) - sleepBreath) * fade;
      tremble += ((expression === 'angry' ? 1 : 0) - tremble) * fade;
      drift += ((expression === 'thinking' ? 1 : 0) - drift) * fade;

      const inhale = Math.sin((TWO_PI * nowMs) / MOTION.breathPeriodMs);
      const sleepInhale = Math.sin((TWO_PI * nowMs) / MOTION.sleepBreathPeriodMs);
      const swell = breath * MOTION.breathScale * inhale + sleepBreath * MOTION.sleepBreathScale * sleepInhale;
      const rise = -breath * MOTION.breathRise * inhale;

      const sincePop = nowMs - popAt;
      const pop = sincePop < 4 * MOTION.popDecayMs + MOTION.popPeriodMs
        ? MOTION.popAmount * Math.sin((TWO_PI * sincePop) / MOTION.popPeriodMs) * Math.exp(-sincePop / MOTION.popDecayMs)
        : 0;
      const sinceHop = nowMs - hopAt;
      const hop = sinceHop < 5 * MOTION.bounceDecayMs
        ? -MOTION.bounceHeight * Math.abs(Math.sin((Math.PI * sinceHop) / MOTION.bouncePeriodMs)) * Math.exp(-sinceHop / MOTION.bounceDecayMs)
        : 0;

      const seconds = nowMs / 1000;
      const driftX = drift * MOTION.thinkDrift * Math.sin((TWO_PI * nowMs) / MOTION.thinkDriftPeriodMs);
      const driftY = drift * MOTION.thinkDrift * 0.4 * Math.sin((TWO_PI * nowMs) / (MOTION.thinkDriftPeriodMs * 1.37));

      // Head turn: looking right, the left eye comes nearer and the right one turns away.
      const turn = expression === null ? 0 : Math.max(-1, Math.min(1, gazeX));
      const near = 1 + MOTION.headTurnNearGrow * Math.abs(turn);
      const farX = 1 - MOTION.headTurnFarNarrow * Math.abs(turn);
      const farY = 1 - MOTION.headTurnFarNarrow * 0.15 * Math.abs(turn);
      const shift = MOTION.headTurnShift * turn;

      compose(out.left, pose.left, swell, pop, turn > 0 ? near : farX, turn > 0 ? near : farY);
      compose(out.right, pose.right, swell, pop, turn > 0 ? farX : near, turn > 0 ? farY : near);
      compose(out.mouth, pose.mouth, swell, pop, 1 - MOTION.headTurnFarNarrow * 0.3 * Math.abs(turn), 1);

      // Each shape trembles on its own phase, so it reads as tension, not a shaking screen.
      out.left.ox += shift + driftX + tremble * trembleWave(seconds, 0);
      out.left.oy += rise + hop + driftY + tremble * trembleWave(seconds, 1.7);
      out.right.ox += shift + driftX + tremble * trembleWave(seconds, 3.1);
      out.right.oy += rise + hop + driftY + tremble * trembleWave(seconds, 4.4);
      out.mouth.ox += shift + tremble * trembleWave(seconds, 5.9);
      out.mouth.oy += rise * 0.5 + hop + tremble * trembleWave(seconds, 7.3);
      return out;
    },
  };
}

/**
 * Packs the motion as per-shape (sx, sy, tx, ty) for the shader, which maps a
 * pixel centre p to p * s + t. Pivots come from the shapes as drawn (centre
 * and half height), offsets are scaled by the face height.
 */
export function packShapeTransforms(motion: FaceMotion, centers: readonly ShapeCenter[], faceH: number, out: Float32Array): void {
  packShape(motion.left, centers[0], faceH, out, 0);
  packShape(motion.right, centers[1], faceH, out, SHAPE_TRANSFORM_FLOATS);
  packShape(motion.mouth, centers[2], faceH, out, SHAPE_TRANSFORM_FLOATS * 2);
}

function packShape(m: ShapeMotion, center: ShapeCenter | undefined, faceH: number, out: Float32Array, offset: number): void {
  const px = center?.cx ?? 0;
  const py = (center?.cy ?? 0) + m.pivotY * (center?.halfH ?? 0);
  out[offset] = m.sx;
  out[offset + 1] = m.sy;
  out[offset + 2] = px * (1 - m.sx) + m.ox * faceH;
  out[offset + 3] = py * (1 - m.sy) + m.oy * faceH;
}

/** The pose an expression holds, beyond its profile's shape. */
function targetPose(expression: ExpressionName | null, out: FaceMotion): void {
  setShape(out.left, 1, 1, 0, 0, 0);
  setShape(out.right, 1, 1, 0, 0, 0);
  setShape(out.mouth, 1, 1, 0, 0, 0);
  switch (expression) {
    case 'sad':
    case 'crying':
      // Lids droop (bottom edge stays) and the whole face sinks.
      setShape(out.left, 1, 1 - MOTION.sadDroop, 1, 0, MOTION.sadSink);
      setShape(out.right, 1, 1 - MOTION.sadDroop, 1, 0, MOTION.sadSink);
      setShape(out.mouth, 1, 1, 0, 0, MOTION.sadSink * 0.6);
      return;
    case 'smug':
      setShape(out.right, 1, 1 - MOTION.smugLid, 1, 0, 0);
      return;
    case 'thinking':
      setShape(out.left, 1, 1 - MOTION.thinkSquint, 1, 0, 0);
      setShape(out.right, 1, 1 + MOTION.thinkWiden, 0, 0, 0);
      return;
    default:
      return;
  }
}

function compose(out: ShapeMotion, pose: ShapeMotion, swell: number, pop: number, turnX: number, turnY: number): void {
  out.sx = pose.sx * (1 + swell * 0.5) * (1 + pop) * turnX;
  out.sy = pose.sy * (1 + swell) * (1 + pop) * turnY;
  out.pivotY = pose.pivotY;
  out.ox = pose.ox;
  out.oy = pose.oy;
}

/** Two incommensurate sines (about 11 and 17 Hz): irregular, never a visible loop. */
function trembleWave(seconds: number, phase: number): number {
  return MOTION.trembleAmount * (0.6 * Math.sin(TWO_PI * 11 * seconds + phase) + 0.4 * Math.sin(TWO_PI * 17.3 * seconds + phase * 1.9));
}

function easeShape(current: ShapeMotion, goal: ShapeMotion, amount: number): void {
  current.sx += (goal.sx - current.sx) * amount;
  current.sy += (goal.sy - current.sy) * amount;
  current.pivotY += (goal.pivotY - current.pivotY) * amount;
  current.ox += (goal.ox - current.ox) * amount;
  current.oy += (goal.oy - current.oy) * amount;
}

function setShape(shape: ShapeMotion, sx: number, sy: number, pivotY: number, ox: number, oy: number): void {
  shape.sx = sx;
  shape.sy = sy;
  shape.pivotY = pivotY;
  shape.ox = ox;
  shape.oy = oy;
}

/** Frame-rate independent share of the way to a target, for time constant tauMs. */
function approach(dtMs: number, tauMs: number): number {
  return 1 - Math.exp(-dtMs / tauMs);
}

function identity(): ShapeMotion {
  return { sx: 1, sy: 1, pivotY: 0, ox: 0, oy: 0 };
}
