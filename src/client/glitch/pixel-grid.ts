import type { AppState } from '../state/app-state.js';
import type { GlitchConfig } from './constants.js';
import {
  EXPRESSION_PROFILES,
  FEATURE_BOX_GLOBAL_SCALE_X,
  FEATURE_BOX_GLOBAL_SCALE_Y,
  FEATURE_MOUTH_SCALE_X,
  FEATURE_MOUTH_SCALE_Y,
} from './constants.js';
import {
  getColorLUT,
  hexToHSL,
  testShapeHit,
} from './utils.js';

export interface PixelGridPoint {
  x: number;
  y: number;
  hueOff: number;
  brightOff: number;
  lut: string[];
  overrideHSL: { h: number; s: number; l: number } | null;
}

export interface ShapeCenter {
  cx: number;
  cy: number;
}

export interface PixelGridBuildResult {
  pixelGrid: PixelGridPoint[];
  shapeGroups: number[];
  shapeCenters: ShapeCenter[];
}

export function buildPixelGrid(
  state: AppState,
  config: GlitchConfig,
  faceWidth: number,
  faceHeight: number,
  effectivePixelSize: number,
  effectivePixelGap: number,
  baseHSL: { h: number; s: number; l: number },
  colorLUTs: Map<number, string[]>,
): PixelGridBuildResult {
  colorLUTs.clear();

  const pixelGrid: PixelGridPoint[] = [];
  const shapeGroups: number[] = [];
  const shapeCenters: ShapeCenter[] = [];

  const expression = state.sleeping ? 'sleep' : state.currentExpression || 'idle';
  const profile = EXPRESSION_PROFILES[expression] ?? null;
  const shapes = getModifiedShapes(expression, config);
  const vb = config.svg.viewBox;
  const fitScale = Math.min(faceWidth / vb.w, faceHeight / vb.h);
  const drawW = vb.w * fitScale * FEATURE_BOX_GLOBAL_SCALE_X;
  const drawH = vb.h * fitScale * FEATURE_BOX_GLOBAL_SCALE_Y;
  const offsetX = (faceWidth - drawW) * 0.5;
  const offsetY = (faceHeight - drawH) * 0.5;
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

    shapeCenters.push({ cx: tx + sw / 2, cy: ty + sh / 2 });

    let hitTest = 'rect';
    if (profile) {
      if (si <= 1 && profile.eyeShape) hitTest = profile.eyeShape;
      if (si === 2 && profile.mouthShape) hitTest = profile.mouthShape;
    }

    let shapeOverrideHSL: { h: number; s: number; l: number } | null = null;
    if (profile) {
      if (si <= 1 && profile.colorHex) shapeOverrideHSL = hexToHSL(profile.colorHex);
      if (si >= 3 && profile.tearColorHex) shapeOverrideHSL = hexToHSL(profile.tearColorHex);
    }

    const baseH = shapeOverrideHSL ? shapeOverrideHSL.h : baseHSL.h;
    const baseS = shapeOverrideHSL ? shapeOverrideHSL.s : baseHSL.s;

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
          hueOff: hOff,
          brightOff: bOff,
          lut: getColorLUT(colorLUTs, baseH + hOff, baseS),
          overrideHSL: shapeOverrideHSL,
        });
        shapeGroups.push(si);
      }
    }
  }

  return {
    pixelGrid,
    shapeGroups,
    shapeCenters,
  };
}

export function recolorPixelGrid(
  pixelGrid: PixelGridPoint[],
  colorLUTs: Map<number, string[]>,
  baseHSL: { h: number; s: number; l: number },
): void {
  colorLUTs.clear();
  for (const point of pixelGrid) {
    const base = point.overrideHSL || baseHSL;
    point.lut = getColorLUT(colorLUTs, base.h + point.hueOff, base.s);
  }
}

function getModifiedShapes(expression: string, config: GlitchConfig): GlitchConfig['svg']['shapes'] {
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
