import type { ExpressionName } from '../../shared/contracts/config.js';
import type { AppState } from '../state/app-state.js';
import type { GlitchConfig } from './constants.js';
import {
  EXPRESSION_PROFILES,
  FACE_SAFE_AREA_X,
  FACE_SAFE_AREA_Y,
  FEATURE_BOX_GLOBAL_SCALE_X,
  FEATURE_BOX_GLOBAL_SCALE_Y,
  FEATURE_MOUTH_SCALE_X,
  FEATURE_MOUTH_SCALE_Y,
  GAZE_EYE_RANGE_Y,
} from './constants.js';
import { PROP_GAP, PROP_TONES, propBounds, rasterizeProp, type PropAnchors, type PropBase } from './props.js';
import { ARC_REACH, hexToHSL, testShapeHit } from './utils.js';

export interface PixelGridPoint {
  x: number;
  y: number;
  /** Shape the pixel belongs to: 0 left eye, 1 right eye, 2 mouth, 3-4 tears, 5-10 a worn prop (props.ts). */
  group: number;
  /** Size factor. Below 1 only while the pixel grows in or shrinks away in a morph. */
  scale: number;
  hueOff: number;
  brightOff: number;
  /**
   * Override colour in GPU units (hue and saturation 0..1); a hue below 0
   * keeps the base colour, or with a saturation above 0 the base hue washed
   * out to it (hair).
   */
  overrideH: number;
  overrideS: number;
}

export interface ShapeCenter {
  cx: number;
  cy: number;
  /** Half the shape's height: a lowered lid pivots on the bottom edge. A mouth's is what it covers. */
  halfH: number;
}

export interface PixelGridBuildResult {
  pixelGrid: PixelGridPoint[];
  shapeCenters: ShapeCenter[];
  /** Where a worn prop sits at rest; null without one. */
  propBase: PropBase | null;
}

/** How the face sits in its box: the share of the box it may fill, and where it sits vertically. */
export interface FaceLayout {
  safeX: number;
  safeY: number;
  /** Share of the free height above the face: 0.5 centres it. */
  top: number;
  /**
   * What gets placed: the viewBox, or the face's own (resting) shapes. The
   * shapes reach past the viewBox's right and bottom edges, so a centred
   * viewBox leaves the face itself a little right of and below centre.
   */
  anchor: 'viewBox' | 'shapes';
}

/** On a screen: slightly above centre, so the mouth clears the listening indicator at the bottom. */
export const SCREEN_LAYOUT: FaceLayout = { safeX: FACE_SAFE_AREA_X, safeY: FACE_SAFE_AREA_Y, top: 0.42, anchor: 'viewBox' };

/**
 * A studio stream (sentient-studio contract section 5): centred, so the
 * frame's centre is the face's centre, and as large as it can be while the
 * eyes stay inside the frame looking all the way left or right (they move by
 * GAZE_EYE_RANGE_X of the frame width). The face is about 1.8 times as wide
 * as it is tall, so at rest it is ~65 % of a square frame's width and ~36 %
 * of its height. Centred on its resting shapes, so expressions move about a
 * fixed centre.
 */
export const STUDIO_LAYOUT: FaceLayout = { safeX: 0.74, safeY: 1, top: 0.5, anchor: 'shapes' };

/**
 * Highest a worn prop reaches at rest in a studio frame, as a share of the
 * frame's height from its top: the prop goes up with the eyes when they look
 * all the way up, and with surprised eyes opening taller, popping and turning
 * with the gaze (up to about 0.035 of the frame, props.test.ts), plus a
 * little to spare. Window renderers show the frame and nothing past it
 * (sentient-studio window/faces.wgsl pads around the frame, it never draws
 * outside it), so a hat above this would be cut off.
 */
export const STUDIO_PROP_TOP = GAZE_EYE_RANGE_Y + 0.045;

/**
 * Scale that fits the face's viewBox into the safe area of a width x height
 * box. A worn prop is fitted with the face: on a screen the two share the
 * safe area; in a studio frame the face keeps its size unless face and prop
 * don't fit between STUDIO_PROP_TOP and the same margin at the bottom, or
 * the prop reaches out past the eyes (hair), which then keeps the margin the
 * eyes keep for looking all the way to a side.
 */
export function featureFitScale(width: number, height: number, config: GlitchConfig, layout: FaceLayout = SCREEN_LAYOUT): number {
  const vb = config.svg.viewBox;
  const reach = propReach(config);
  if (layout.anchor === 'viewBox') {
    return Math.min((width * layout.safeX) / (vb.w + 2 * reach.side), (height * layout.safeY) / (vb.h + reach.above + reach.below));
  }
  const fitX = (width * layout.safeX) / vb.w;
  const fit = Math.min(fitX, (height * layout.safeY) / vb.h);
  const bounds = restingPropBounds(config);
  if (!bounds) return fit;
  const { top, bottom } = restingSpanY(config);
  const { left, right } = restingSpanX(config);
  const room = height * (1 - 2 * STUDIO_PROP_TOP);
  const tall = Math.max(bottom, bounds.bottom) - Math.min(top, bounds.top);
  const middle = (left + right) / 2;
  const half = Math.max(middle - bounds.left, bounds.right - middle, (right - left) / 2);
  return Math.min(fit, room / (tall * FEATURE_BOX_GLOBAL_SCALE_Y), fitX * ((right - left) / 2 / half));
}

/**
 * Where a worn prop's parts sit on the resting face, in viewBox units: above
 * the eyes, and on the mouth's top and bottom edges as drawn.
 */
export function restingPropAnchors(config: GlitchConfig): PropAnchors | null {
  const [left, right, mouth] = config.svg.shapes;
  if (!left || !right) return null;
  const eyes = { x: (Math.min(left.x, right.x) + Math.max(left.x + left.w, right.x + right.w)) / 2, y: Math.min(left.y, right.y) - PROP_GAP };
  if (!mouth) return { eyes, lip: eyes, jaw: eyes };
  const x = mouth.x + mouth.w / 2;
  const cy = mouth.y + mouth.h / 2;
  const half = (mouth.h * FEATURE_MOUTH_SCALE_Y) / 2;
  return { eyes, lip: { x, y: cy - half }, jaw: { x, y: cy + half } };
}

/** The box the worn prop covers on the resting face, in viewBox units; null without one. */
function restingPropBounds(config: GlitchConfig) {
  const anchors = config.prop === 'none' ? null : restingPropAnchors(config);
  return anchors ? propBounds(config.prop, anchors) : null;
}

/** How far a worn prop reaches past the viewBox: above, below, and out to the further side. */
function propReach(config: GlitchConfig): { above: number; below: number; side: number } {
  const bounds = restingPropBounds(config);
  if (!bounds) return { above: 0, below: 0, side: 0 };
  const vb = config.svg.viewBox;
  return {
    above: Math.max(0, -bounds.top),
    below: Math.max(0, bounds.bottom - vb.h),
    side: Math.max(0, -bounds.left, bounds.right - vb.w),
  };
}

/** Top and bottom of the face's resting shapes, in viewBox units. */
function restingSpanY(config: GlitchConfig): { top: number; bottom: number } {
  const rest = config.svg.shapes;
  return { top: Math.min(...rest.map((shape) => shape.y)), bottom: Math.max(...rest.map((shape) => shape.y + shape.h)) };
}

/** Left and right of the face's resting shapes, in viewBox units. */
function restingSpanX(config: GlitchConfig): { left: number; right: number } {
  const rest = config.svg.shapes;
  return { left: Math.min(...rest.map((shape) => shape.x)), right: Math.max(...rest.map((shape) => shape.x + shape.w)) };
}

/** Where the face's viewBox is drawn in a width x height box. */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function faceBox(config: GlitchConfig, width: number, height: number, layout: FaceLayout = SCREEN_LAYOUT): FaceBox {
  const vb = config.svg.viewBox;
  const fitScale = featureFitScale(width, height, config, layout);
  const w = vb.w * fitScale * FEATURE_BOX_GLOBAL_SCALE_X;
  const h = vb.h * fitScale * FEATURE_BOX_GLOBAL_SCALE_Y;
  // A worn prop sits round the face: on a screen the two are placed together.
  const reach = propReach(config);
  const above = reach.above * (h / vb.h);
  const below = reach.below * (h / vb.h);
  let x = (width - w) * 0.5;
  let y = (height - h - above - below) * layout.top + above;
  if (layout.anchor === 'shapes' && config.svg.shapes.length > 0) {
    const { left, right } = restingSpanX(config);
    const { top, bottom } = restingSpanY(config);
    x = width * 0.5 - ((left + right) / 2) * (w / vb.w);
    y = height * layout.top - ((top + bottom) / 2) * (h / vb.h);
    // A studio frame stays centred on the face; only a prop that would rise
    // past STUDIO_PROP_TOP (or hang below the same margin at the bottom)
    // moves the face, as far as it needs.
    const bounds = restingPropBounds(config);
    if (bounds) {
      const down = height * STUDIO_PROP_TOP - (y + Math.min(top, bounds.top) * (h / vb.h));
      const up = height * (1 - STUDIO_PROP_TOP) - (y + Math.max(bottom, bounds.bottom) * (h / vb.h));
      y += Math.min(Math.max(0, down), up);
    }
  }
  return { x, y, w, h };
}

export function buildPixelGrid(
  state: AppState,
  config: GlitchConfig,
  faceWidth: number,
  faceHeight: number,
  effectivePixelSize: number,
  effectivePixelGap: number,
  layout: FaceLayout = SCREEN_LAYOUT,
): PixelGridBuildResult {
  const pixelGrid: PixelGridPoint[] = [];
  const shapeCenters: ShapeCenter[] = [];

  const expression: ExpressionName = state.sleeping ? 'sleep' : state.currentExpression;
  const profile = EXPRESSION_PROFILES[expression] ?? null;
  const shapes = getModifiedShapes(expression, config);
  const vb = config.svg.viewBox;
  const { x: offsetX, y: offsetY, w: drawW, h: drawH } = faceBox(config, faceWidth, faceHeight, layout);
  const mapScaleX = drawW / vb.w;
  const mapScaleY = drawH / vb.h;
  const sz = effectivePixelSize;
  const gap = effectivePixelGap;
  const stride = sz + gap;
  const hueVar = config.color.hueVariation;
  const brightVar = config.color.brightnessVariation;

  // A worn prop is laid out on the resting face, the same in every
  // expression, so an expression change never re-lays it; the shader moves
  // it onto the eyes and mouth as drawn (props.ts packPropTransform). It is
  // drawn first, under the face: an eye looking all the way to a side passes
  // over the moustache's end and covers it.
  let propBase: PropBase | null = null;
  const rest = config.prop === 'none' ? null : restingPropAnchors(config);
  if (rest) {
    const at = (point: { x: number; y: number }) => ({ x: offsetX + point.x * mapScaleX, y: offsetY + point.y * mapScaleY });
    const anchors: PropAnchors = { eyes: at(rest.eyes), lip: at(rest.lip), jaw: at(rest.jaw) };
    propBase = {
      x: anchors.eyes.x,
      y: anchors.eyes.y,
      eyeTop: anchors.eyes.y + PROP_GAP * mapScaleY,
      mouthX: anchors.lip.x,
      mouthTop: anchors.lip.y,
      mouthBottom: anchors.jaw.y,
    };
    for (const pixel of rasterizeProp(config.prop, anchors, mapScaleX, mapScaleY, sz, gap)) {
      const tone = PROP_TONES[pixel.tone];
      pixelGrid.push({
        x: pixel.x,
        y: pixel.y,
        group: pixel.group,
        scale: 1,
        hueOff: tone.hue + (Math.random() - 0.5) * 2 * hueVar,
        brightOff: tone.light + (Math.random() - 0.5) * 2 * brightVar,
        overrideH: -1,
        overrideS: tone.sat ?? 0,
      });
    }
  }

  for (const [si, shape] of shapes.entries()) {
    const sx = offsetX + shape.x * mapScaleX;
    const sy = offsetY + shape.y * mapScaleY;
    let sw = shape.w * mapScaleX;
    let sh = shape.h * mapScaleY;
    let srx = shape.rx * mapScaleX;
    let sry = shape.ry * mapScaleY;
    let tx = sx;
    let ty = sy;

    if (si === 2) {
      const cx = sx + sw * 0.5;
      const cy = sy + sh * 0.5;
      sw *= FEATURE_MOUTH_SCALE_X;
      sh *= FEATURE_MOUTH_SCALE_Y;
      srx *= FEATURE_MOUTH_SCALE_X;
      sry *= FEATURE_MOUTH_SCALE_Y;
      tx = cx - sw * 0.5;
      ty = cy - sh * 0.5;
    }

    let hitTest = 'rect';
    if (profile) {
      if (si <= 1 && profile.eyeShape) hitTest = profile.eyeShape;
      if (si === 2 && profile.mouthShape) hitTest = profile.mouthShape;
    }

    // A mouth drawn as an arc (a grin) covers only part of its box; its half
    // height is what it covers, so a worn beard stays on it.
    const arc = si === 2 && (hitTest === 'smile-arc' || hitTest === 'frown');
    shapeCenters.push({ cx: tx + sw / 2, cy: ty + sh / 2, halfH: (sh / 2) * (arc ? ARC_REACH : 1) });

    let overrideHex: string | undefined;
    if (profile) {
      if (si <= 1 && profile.colorHex) overrideHex = profile.colorHex;
      if (si >= 3 && profile.tearColorHex) overrideHex = profile.tearColorHex;
    }
    const override = overrideHex ? hexToHSL(overrideHex) : null;
    const overrideH = override ? (((override.h % 360) + 360) % 360) / 360 : -1;
    const overrideS = override ? override.s / 100 : 0;

    const cols = Math.max(1, Math.floor(sw / stride));
    const rows = Math.max(1, Math.floor(sh / stride));
    const gridOffX = tx + (sw - cols * stride + gap) / 2;
    const gridOffY = ty + (sh - rows * stride + gap) / 2;

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const px = gridOffX + c * stride;
        const py = gridOffY + r * stride;
        const cx = px + sz / 2;
        const cy = py + sz / 2;
        if (!testShapeHit(cx, cy, tx, ty, sw, sh, srx, sry, hitTest)) continue;

        let finalY = py;
        if (profile?.eyeSkew && si <= 1) {
          const eyeCenterX = tx + sw / 2;
          const normX = (cx - eyeCenterX) / (sw / 2);
          const skewDir = si === 0 ? -1 : 1;
          finalY += normX * skewDir * profile.eyeSkew * sh;
        }

        const hOff = (Math.random() - 0.5) * 2 * hueVar;
        const bOff = (Math.random() - 0.5) * 2 * brightVar;
        pixelGrid.push({
          x: px,
          y: finalY,
          group: si,
          scale: 1,
          hueOff: hOff,
          brightOff: bOff,
          overrideH,
          overrideS,
        });
      }
    }
  }

  return {
    pixelGrid,
    shapeCenters,
    propBase,
  };
}

function getModifiedShapes(expression: ExpressionName, config: GlitchConfig): GlitchConfig['svg']['shapes'] {
  const profile = EXPRESSION_PROFILES[expression] ?? null;
  const shapes = config.svg.shapes.map((shape) => ({ ...shape }));
  if (!profile) return shapes;

  for (let i = 0; i < 2; i += 1) {
    const shape = shapes[i];
    if (!shape) continue;
    const cx = shape.x + shape.w / 2;
    const cy = shape.y + shape.h / 2;
    if (profile.eyeW) { shape.w *= profile.eyeW; shape.x = cx - shape.w / 2; }
    if (profile.eyeH) { shape.h *= profile.eyeH; shape.y = cy - shape.h / 2; }
    if (profile.eyeDy) { shape.y += profile.eyeDy; }
    shape.rx = Math.min(shape.rx, shape.w / 2);
    shape.ry = Math.min(shape.ry, shape.h / 2);
  }

  const mouth = shapes[2];
  if (!mouth) return shapes;
  const mcx = mouth.x + mouth.w / 2;
  const mcy = mouth.y + mouth.h / 2;
  if (profile.mouthW) { mouth.w *= profile.mouthW; mouth.x = mcx - mouth.w / 2; }
  if (profile.mouthH) { mouth.h *= profile.mouthH; mouth.y = mcy - mouth.h / 2; }
  if (profile.mouthRound) { mouth.rx = Math.min(mouth.w, mouth.h) / 2; mouth.ry = mouth.rx; }
  mouth.rx = Math.min(mouth.rx, mouth.w / 2);
  mouth.ry = Math.min(mouth.ry, mouth.h / 2);

  if (profile.tears) {
    for (let i = 0; i < 2; i += 1) {
      const eye = shapes[i];
      if (!eye) continue;
      const tearW = eye.w * 0.15;
      const tearH = eye.h;
      const tearX = eye.x + eye.w / 2 - tearW / 2;
      const tearY = eye.y + eye.h + 1;
      shapes.push({
        x: tearX,
        y: tearY,
        w: tearW,
        h: tearH,
        rx: tearW / 2,
        ry: tearW / 2,
      });
    }
  }

  return shapes;
}
