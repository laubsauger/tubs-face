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
} from './constants.js';
import { hexToHSL, testShapeHit } from './utils.js';

export interface PixelGridPoint {
  x: number;
  y: number;
  /** Shape the pixel belongs to: 0 left eye, 1 right eye, 2 mouth, 3+ tears. */
  group: number;
  /** Size factor. Below 1 only while the pixel grows in or shrinks away in a morph. */
  scale: number;
  hueOff: number;
  brightOff: number;
  /** Override colour in GPU units (hue and saturation 0..1); a hue below 0 keeps the base colour. */
  overrideH: number;
  overrideS: number;
}

export interface ShapeCenter {
  cx: number;
  cy: number;
  /** Half the shape's height: a lowered lid pivots on the bottom edge. */
  halfH: number;
}

export interface PixelGridBuildResult {
  pixelGrid: PixelGridPoint[];
  shapeCenters: ShapeCenter[];
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

/** Scale that fits the face's viewBox into the safe area of a width x height box. */
export function featureFitScale(width: number, height: number, viewBox: { w: number; h: number }, layout: FaceLayout = SCREEN_LAYOUT): number {
  return Math.min((width * layout.safeX) / viewBox.w, (height * layout.safeY) / viewBox.h);
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
  const fitScale = featureFitScale(width, height, vb, layout);
  const w = vb.w * fitScale * FEATURE_BOX_GLOBAL_SCALE_X;
  const h = vb.h * fitScale * FEATURE_BOX_GLOBAL_SCALE_Y;
  let x = (width - w) * 0.5;
  let y = (height - h) * layout.top;
  if (layout.anchor === 'shapes' && config.svg.shapes.length > 0) {
    const rest = config.svg.shapes;
    const centreX = (Math.min(...rest.map((shape) => shape.x)) + Math.max(...rest.map((shape) => shape.x + shape.w))) / 2;
    const centreY = (Math.min(...rest.map((shape) => shape.y)) + Math.max(...rest.map((shape) => shape.y + shape.h))) / 2;
    x = width * 0.5 - centreX * (w / vb.w);
    y = height * layout.top - centreY * (h / vb.h);
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

    shapeCenters.push({ cx: tx + sw / 2, cy: ty + sh / 2, halfH: sh / 2 });

    let hitTest = 'rect';
    if (profile) {
      if (si <= 1 && profile.eyeShape) hitTest = profile.eyeShape;
      if (si === 2 && profile.mouthShape) hitTest = profile.mouthShape;
    }

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
