import { describe, expect, it } from 'vitest';
import { EXPRESSIONS, PROPS, type ExpressionName, type PropId } from '../../shared/contracts/config.js';
import type { AppState } from '../state/app-state.js';
import {
  DEFAULT_CONFIG,
  FEATURE_BOX_GLOBAL_SCALE_X,
  FEATURE_BOX_GLOBAL_SCALE_Y,
  GAZE_EYE_RANGE_X,
  GAZE_EYE_RANGE_Y,
  type GlitchConfig,
} from './constants.js';
import { SHAPE_TRANSFORM_FLOATS, createExpressionMotion, createFaceMotion, packShapeTransforms } from './expression-motion.js';
import { SCREEN_LAYOUT, STUDIO_LAYOUT, buildPixelGrid, faceBox, featureFitScale, type FaceLayout } from './pixel-grid.js';
import { PROP_GROUP, PROP_TRANSFORM_FLOATS, packPropTransform } from './props.js';

// A prop is drawn into the face's own frame, so it goes wherever the stream
// goes. Window renderers show a studio frame and nothing outside it, so a hat
// that pokes out of the 1024 frame is cut off on every surface; and the head
// with no prop must look exactly as it did before props existed.

const FRAME = 1024;
const WORN = PROPS.filter((prop) => prop !== 'none');

const withProp = (prop: PropId): GlitchConfig => ({ ...structuredClone(DEFAULT_CONFIG), prop });
const stateIn = (expression: ExpressionName) => ({ sleeping: false, currentExpression: expression }) as AppState;

/** The pixel size and gap the runtime uses for this box (glitch/runtime.ts updateEffectivePixelMetrics). */
function pixelMetrics(config: GlitchConfig, width: number, height: number, layout: FaceLayout) {
  const featureBoxWidth = config.svg.viewBox.w * featureFitScale(width, height, config, layout);
  const scale = Math.max(0.16, Math.min(1, featureBoxWidth / 1400));
  return { size: Math.max(2, config.pixel.size * scale), gap: Math.max(0, config.pixel.gap * scale) };
}

function grid(config: GlitchConfig, expression: ExpressionName, width = FRAME, height = FRAME, layout = STUDIO_LAYOUT) {
  const { size, gap } = pixelMetrics(config, width, height, layout);
  return { size, ...buildPixelGrid(stateIn(expression), config, width, height, size, gap, layout) };
}

describe('a head with no prop', () => {
  // Where the face sat before props: centred on its shapes in a studio frame,
  // a little above centre on a screen. Worked out here on its own, so a change
  // that makes "none" reserve room for a hat shows up.
  function boxBeforeProps(width: number, height: number, layout: FaceLayout) {
    const vb = DEFAULT_CONFIG.svg.viewBox;
    const fit = Math.min((width * layout.safeX) / vb.w, (height * layout.safeY) / vb.h);
    const w = vb.w * fit * FEATURE_BOX_GLOBAL_SCALE_X;
    const h = vb.h * fit * FEATURE_BOX_GLOBAL_SCALE_Y;
    if (layout.anchor === 'viewBox') return { x: (width - w) / 2, y: (height - h) * layout.top, w, h };
    const shapes = DEFAULT_CONFIG.svg.shapes;
    const cx = (Math.min(...shapes.map((s) => s.x)) + Math.max(...shapes.map((s) => s.x + s.w))) / 2;
    const cy = (Math.min(...shapes.map((s) => s.y)) + Math.max(...shapes.map((s) => s.y + s.h))) / 2;
    return { x: width / 2 - cx * (w / vb.w), y: height * layout.top - cy * (h / vb.h), w, h };
  }

  it('draws nothing extra and sits where it always did, in a studio frame and on a screen', () => {
    for (const [width, height, layout] of [[FRAME, FRAME, STUDIO_LAYOUT], [1920, 1080, SCREEN_LAYOUT], [1280, 800, SCREEN_LAYOUT]] as const) {
      const config = withProp('none');
      const box = faceBox(config, width, height, layout);
      const before = boxBeforeProps(width, height, layout);
      for (const key of ['x', 'y', 'w', 'h'] as const) expect(box[key]).toBeCloseTo(before[key], 6);
      for (const expression of EXPRESSIONS) {
        const built = grid(config, expression, width, height, layout);
        expect(built.propBase).toBeNull();
        expect(built.pixelGrid.filter((pixel) => pixel.group >= PROP_GROUP)).toEqual([]);
      }
    }
  });
});

describe('a worn prop in a studio frame', () => {
  it('every prop draws something, above the eyes', () => {
    for (const prop of WORN) {
      const { pixelGrid } = grid(withProp(prop), 'idle');
      const hat = pixelGrid.filter((pixel) => pixel.group >= PROP_GROUP);
      const eyesTop = Math.min(...pixelGrid.filter((pixel) => pixel.group <= 1).map((pixel) => pixel.y));
      expect(hat.length, prop).toBeGreaterThan(40);
      expect(Math.max(...hat.map((pixel) => pixel.y)), prop).toBeLessThan(eyesTop);
    }
  });

  // The prop follows the eyes: their tops in every expression (surprised
  // opens them taller, asleep they close), the pop, hop and sink of the
  // living motion, a tilt, and the gaze all the way up or to a side. The
  // propeller's blades only ever swing inward; the tassel swings half a pixel.
  it('stays inside the frame for every prop, expression and gaze, so no surface cuts it off', () => {
    for (const prop of WORN) {
      const config = withProp(prop);
      for (const expression of EXPRESSIONS) {
        const { pixelGrid, shapeCenters, propBase, size } = grid(config, expression);
        const hat = pixelGrid.filter((pixel) => pixel.group >= PROP_GROUP);
        for (const gazeX of [-1, 0, 1]) {
          const motion = createExpressionMotion();
          const face = createFaceMotion();
          const transforms = new Float32Array(SHAPE_TRANSFORM_FLOATS * 3);
          const prop4 = new Float32Array(PROP_TRANSFORM_FLOATS);
          let top = Infinity;
          let left = Infinity;
          let right = -Infinity;
          // From idle into the expression, through its pop or hop, and held.
          motion.update('idle', 0, gazeX, face);
          for (let t = 0; t < 2500; t += 1000 / 60) {
            motion.update(expression, 1000 + t, gazeX, face);
            packShapeTransforms(face, shapeCenters, FRAME, transforms);
            packPropTransform(propBase, transforms, shapeCenters, prop4);
            const [px, py, cos, sin, dx, dy] = prop4 as unknown as number[];
            for (const pixel of hat) {
              const lx = pixel.x + size / 2 - px!;
              const ly = pixel.y + size / 2 - py!;
              for (const swing of [-size / 2, size / 2]) {
                const x = px! + (lx + swing) * cos! - ly * sin! + dx!;
                const y = py! + (lx + swing) * sin! + ly * cos! + dy!;
                top = Math.min(top, y - size / 2);
                left = Math.min(left, x - size / 2);
                right = Math.max(right, x + size / 2);
              }
            }
          }
          const where = `${prop} ${expression} gaze ${gazeX}`;
          expect(top - GAZE_EYE_RANGE_Y * FRAME, where).toBeGreaterThan(0);
          expect(left - GAZE_EYE_RANGE_X * FRAME, where).toBeGreaterThan(0);
          expect(right + GAZE_EYE_RANGE_X * FRAME, where).toBeLessThan(FRAME);
        }
      }
    }
  });

  // Making room for the hat moves the face down; it must not push the face
  // out at the bottom, nor shrink it to a dot on a far-away window.
  it('keeps the face whole and about its size: it moves down instead of shrinking', () => {
    const bare = grid(withProp('none'), 'idle').pixelGrid;
    const width = (pixels: typeof bare) => Math.max(...pixels.map((p) => p.x)) - Math.min(...pixels.map((p) => p.x));
    for (const prop of WORN) {
      const { pixelGrid, size } = grid(withProp(prop), 'surprised');
      const face = pixelGrid.filter((pixel) => pixel.group <= 2);
      const bottom = Math.max(...face.map((pixel) => pixel.y)) + size;
      expect(bottom + GAZE_EYE_RANGE_Y * FRAME, prop).toBeLessThan(FRAME);
      expect(width(face), prop).toBeGreaterThan(width(bare.filter((pixel) => pixel.group <= 2)) * 0.9);
    }
  });
});

describe('a worn prop on a screen', () => {
  it('fits on the screen with the face, at any aspect ratio', () => {
    for (const [width, height] of [[1920, 1080], [1280, 800], [800, 1280]] as const) {
      for (const prop of WORN) {
        const { pixelGrid } = grid(withProp(prop), 'idle', width, height, SCREEN_LAYOUT);
        const ys = pixelGrid.map((pixel) => pixel.y);
        const xs = pixelGrid.map((pixel) => pixel.x);
        expect(Math.min(...ys), `${prop} ${width}x${height}`).toBeGreaterThan(0);
        expect(Math.max(...ys), `${prop} ${width}x${height}`).toBeLessThan(height);
        expect(Math.min(...xs)).toBeGreaterThan(0);
        expect(Math.max(...xs)).toBeLessThan(width);
      }
    }
  });
});
