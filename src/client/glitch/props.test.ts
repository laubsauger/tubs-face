import { describe, expect, it } from 'vitest';
import { EXPRESSIONS, PROPS, type ExpressionName, type PropId } from '../../shared/contracts/config.js';
import type { AppState } from '../state/app-state.js';
import {
  DEFAULT_CONFIG,
  FEATURE_BOX_GLOBAL_SCALE_X,
  FEATURE_BOX_GLOBAL_SCALE_Y,
  GAZE_EYE_RANGE_X,
  GAZE_EYE_RANGE_Y,
  GAZE_MOUTH_RANGE_X,
  GAZE_MOUTH_RANGE_Y,
  SPEAK_MAX_SCALE,
  SPEAK_MIN_SCALE,
  type GlitchConfig,
} from './constants.js';
import { SHAPE_TRANSFORM_FLOATS, createExpressionMotion, createFaceMotion, packShapeTransforms } from './expression-motion.js';
import { SCREEN_LAYOUT, STUDIO_LAYOUT, buildPixelGrid, faceBox, featureFitScale, type FaceLayout, type PixelGridPoint, type ShapeCenter } from './pixel-grid.js';
import {
  PROP_GROUP,
  PROP_HEAD_GROUP,
  PROP_JAW_GROUP,
  PROP_LIP_GROUP,
  PROP_SPIN_GROUP,
  PROP_SWING_GROUP,
  PROP_TRANSFORM_FLOATS,
  packPropTransform,
} from './props.js';

// A prop is drawn into the face's own frame, so it goes wherever the stream
// goes. Window renderers show a studio frame and nothing outside it, so a hat
// that pokes out of the 1024 frame is cut off on every surface; and the head
// with no prop must look exactly as it did before props existed.

const FRAME = 1024;
const WORN = PROPS.filter((prop) => prop !== 'none');
/** Looks: parts round the whole face (hair, brows, a beard), not a hat on top. */
const LOOKS: readonly PropId[] = ['watts', 'mark-watts'];
const HATS = WORN.filter((prop) => !LOOKS.includes(prop));
/** Widest a mouth opens talking: worked up all the way (glitch/runtime.ts getSpeakMouthScale). */
const TALK_WIDEST = SPEAK_MIN_SCALE + (SPEAK_MAX_SCALE - SPEAK_MIN_SCALE) * 1.25;
const onMouth = (group: number) => group === PROP_LIP_GROUP || group === PROP_JAW_GROUP;

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
  return { size, gap, ...buildPixelGrid(stateIn(expression), config, width, height, size, gap, layout) };
}

/**
 * Where the shader draws a pixel's centre (shaders.ts vsMain and propCentre,
 * before the gaze and glitches, no blink): eyes and mouth by their living
 * transform, the mouth opened by `talk` about its middle; a prop's parts on
 * what they sit on. `swing` is how far a blade or the tassel reaches sideways.
 */
function drawnCentre(pixel: PixelGridPoint, size: number, transforms: Float32Array, prop: Float32Array, centers: readonly ShapeCenter[], talk: number, swing = 0) {
  const x = pixel.x + size / 2;
  const y = pixel.y + size / 2;
  if (pixel.group <= 2) {
    const at = pixel.group * 4;
    const [sx, sy, tx, ty] = [transforms[at]!, transforms[at + 1]!, transforms[at + 2]!, transforms[at + 3]!];
    if (pixel.group < 2) return { x: x * sx + tx, y: y * sy + ty };
    const middle = centers[2]!.cy * sy + ty;
    return { x: x * sx + tx, y: middle + (y * sy + ty - middle) * talk };
  }
  if (pixel.group === PROP_HEAD_GROUP) return { x: x + prop[6]!, y: y + prop[7]! };
  if (onMouth(pixel.group)) {
    const parted = prop[11]! * (talk - 1);
    return { x: x + prop[8]!, y: y + (pixel.group === PROP_LIP_GROUP ? prop[9]! - parted : prop[10]! + parted) };
  }
  const [px, py, cos, sin, dx, dy] = [prop[0]!, prop[1]!, prop[2]!, prop[3]!, prop[4]!, prop[5]!];
  const lx = x - px + (pixel.group === PROP_SPIN_GROUP || pixel.group === PROP_SWING_GROUP ? swing : 0);
  const ly = y - py;
  return { x: px + lx * cos - ly * sin + dx, y: py + lx * sin + ly * cos + dy };
}

/** Runs the living motion from idle into `expression`, through its pop or hop, and held; calls back each frame. */
function playExpression(built: ReturnType<typeof grid>, expression: ExpressionName, gazeX: number, frame: (transforms: Float32Array, prop: Float32Array) => void): void {
  const motion = createExpressionMotion();
  const face = createFaceMotion();
  const transforms = new Float32Array(SHAPE_TRANSFORM_FLOATS * 3);
  const prop = new Float32Array(PROP_TRANSFORM_FLOATS);
  motion.update('idle', 0, gazeX, face);
  for (let t = 0; t < 2500; t += 1000 / 60) {
    motion.update(expression, 1000 + t, gazeX, face);
    packShapeTransforms(face, built.shapeCenters, FRAME, transforms);
    packPropTransform(built.propBase, transforms, built.shapeCenters, face, FRAME, prop);
    frame(transforms, prop);
  }
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
  it('every hat draws something, above the eyes', () => {
    for (const prop of HATS) {
      const { pixelGrid } = grid(withProp(prop), 'idle');
      const hat = pixelGrid.filter((pixel) => pixel.group >= PROP_GROUP);
      const eyesTop = Math.min(...pixelGrid.filter((pixel) => pixel.group <= 1).map((pixel) => pixel.y));
      expect(hat.length, prop).toBeGreaterThan(40);
      expect(Math.max(...hat.map((pixel) => pixel.y)), prop).toBeLessThan(eyesTop);
    }
  });

  // The prop follows the face: a hat and brows the eyes' tops in every
  // expression (surprised opens them taller, asleep they close), hair the
  // head, a beard the mouth opening as wide as it ever talks; with the pop,
  // hop and sink of the living motion, a tilt, and the gaze all the way up,
  // down or to a side (a beard moves with the mouth's smaller gaze). The
  // propeller's blades only ever swing inward; the tassel swings half a pixel.
  it('stays inside the frame for every prop, expression, gaze and mouth, so no surface cuts it off', () => {
    for (const prop of WORN) {
      const config = withProp(prop);
      for (const expression of EXPRESSIONS) {
        const built = grid(config, expression);
        const { pixelGrid, shapeCenters, size } = built;
        const worn = pixelGrid.filter((pixel) => pixel.group >= PROP_GROUP);
        for (const gazeX of [-1, 0, 1]) {
          const edges = { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
          playExpression(built, expression, gazeX, (transforms, move) => {
            for (const pixel of worn) {
              const mouth = onMouth(pixel.group);
              const reachX = (mouth ? GAZE_MOUTH_RANGE_X : GAZE_EYE_RANGE_X) * FRAME + size / 2;
              const reachY = (mouth ? GAZE_MOUTH_RANGE_Y : GAZE_EYE_RANGE_Y) * FRAME + size / 2;
              for (const talk of mouth ? [SPEAK_MIN_SCALE, TALK_WIDEST] : [1]) {
                for (const swing of [-size / 2, size / 2]) {
                  const { x, y } = drawnCentre(pixel, size, transforms, move, shapeCenters, talk, swing);
                  edges.top = Math.min(edges.top, y - reachY);
                  edges.bottom = Math.max(edges.bottom, y + reachY);
                  edges.left = Math.min(edges.left, x - reachX);
                  edges.right = Math.max(edges.right, x + reachX);
                }
              }
            }
          });
          const where = `${prop} ${expression} gaze ${gazeX}`;
          expect(edges.top, where).toBeGreaterThan(0);
          expect(edges.bottom, where).toBeLessThan(FRAME);
          expect(edges.left, where).toBeGreaterThan(0);
          expect(edges.right, where).toBeLessThan(FRAME);
        }
      }
    }
  });

  // Making room for the hat moves the face down; it must not push the face
  // out at the bottom, nor shrink it to a dot on a far-away window. Hair
  // beside the eyes has to stay in the frame when they look all the way to
  // a side, so a look gives some of the face's width to it: the head as a
  // whole keeps the bare face's width.
  it('keeps the face whole and about its size: it moves down instead of shrinking', () => {
    const bare = grid(withProp('none'), 'idle').pixelGrid;
    const width = (pixels: typeof bare) => Math.max(...pixels.map((p) => p.x)) - Math.min(...pixels.map((p) => p.x));
    const bareWidth = width(bare.filter((pixel) => pixel.group <= 2));
    for (const prop of WORN) {
      const { pixelGrid, size } = grid(withProp(prop), 'surprised');
      const face = pixelGrid.filter((pixel) => pixel.group <= 2);
      const bottom = Math.max(...face.map((pixel) => pixel.y)) + size;
      expect(bottom + GAZE_EYE_RANGE_Y * FRAME, prop).toBeLessThan(FRAME);
      if (LOOKS.includes(prop)) {
        expect(width(face), prop).toBeGreaterThan(bareWidth * 0.8);
        expect(width(pixelGrid), prop).toBeGreaterThan(bareWidth * 0.95);
      } else {
        expect(width(face), prop).toBeGreaterThan(bareWidth * 0.9);
      }
    }
  });
});

describe.each(LOOKS)('a look (%s) in a studio frame', (look) => {
  const config = withProp(look);

  it('puts each part where it grows: hair above and beside the eyes, brows over them, a moustache over the mouth, a beard under it', () => {
    const { pixelGrid } = grid(config, 'idle');
    const of = (group: number) => pixelGrid.filter((pixel) => pixel.group === group);
    const [left, right, mouth] = [of(0), of(1), of(2)];
    const span = (pixels: PixelGridPoint[], key: 'x' | 'y') => ({ min: Math.min(...pixels.map((p) => p[key])), max: Math.max(...pixels.map((p) => p[key])) });
    const eyesTop = Math.min(span(left, 'y').min, span(right, 'y').min);
    const hair = of(PROP_HEAD_GROUP);
    expect(span(hair, 'y').min).toBeLessThan(eyesTop);
    expect(span(hair, 'x').min).toBeLessThan(span(left, 'x').min);
    expect(span(hair, 'x').max).toBeGreaterThan(span(right, 'x').max);
    const brows = of(PROP_GROUP);
    expect(brows.length).toBeGreaterThan(20);
    expect(span(brows, 'y').max).toBeLessThan(eyesTop);
    const moustache = of(PROP_LIP_GROUP);
    const beard = of(PROP_JAW_GROUP);
    expect(span(moustache, 'y').min).toBeLessThan(span(mouth, 'y').min);
    expect(span(beard, 'y').max).toBeGreaterThan(span(mouth, 'y').max);
  });

  // The moustache and beard are on the lips: talking they part with the
  // mouth, a grin or a round "o" moves them out, asleep it closes. They must
  // never cover the mouth, nor float off it: a row or two clear, and a little
  // more on a thin frown opened wide, whose pixel rows barely move.
  const NEAR = 3.5;
  it('keeps the moustache and beard on the mouth in every expression, however far it opens', () => {
    for (const expression of EXPRESSIONS) {
      const built = grid(config, expression);
      const { pixelGrid, shapeCenters, size, gap } = built;
      const mouth = pixelGrid.filter((pixel) => pixel.group === 2);
      const moustache = pixelGrid.filter((pixel) => pixel.group === PROP_LIP_GROUP);
      const beard = pixelGrid.filter((pixel) => pixel.group === PROP_JAW_GROUP);
      playExpression(built, expression, 0, (transforms, move) => {
        for (const talk of [SPEAK_MIN_SCALE, 1, TALK_WIDEST]) {
          const at = (pixel: PixelGridPoint) => drawnCentre(pixel, size, transforms, move, shapeCenters, talk);
          const lips = mouth.map(at);
          // Closing, the shader flattens the mouth's pixels too.
          const half = (size / 2) * Math.min(1, Math.max(0.2, talk)) * transforms[9]!;
          const top = Math.min(...lips.map((p) => p.y)) - half;
          const bottom = Math.max(...lips.map((p) => p.y)) + half;
          const left = Math.min(...lips.map((p) => p.x));
          const right = Math.max(...lips.map((p) => p.x));
          const over = (p: { x: number }) => p.x >= left - size && p.x <= right + size;
          const above = moustache.map(at).filter(over);
          const below = beard.map(at).filter(over);
          const where = `${expression} talking ${talk}`;
          const clearAbove = top - (Math.max(...above.map((p) => p.y)) + size / 2);
          const clearBelow = Math.min(...below.map((p) => p.y)) - size / 2 - bottom;
          expect(clearAbove, where).toBeGreaterThanOrEqual(0);
          expect(clearBelow, where).toBeGreaterThanOrEqual(0);
          expect(clearAbove, where).toBeLessThan(NEAR * (size + gap));
          expect(clearBelow, where).toBeLessThan(NEAR * (size + gap));
        }
      });
    }
  });

  // Hair grows on the head, not on the lids: closing or narrowing the eyes
  // brings the brows down with them, while the hair stays where it was.
  it('leaves the hair where it is while the brows come down with the lids', () => {
    const held = (expression: ExpressionName) => {
      const built = grid(config, expression);
      const middle = { hair: 0, brows: 0 };
      playExpression(built, expression, 0, (transforms, move) => {
        const mean = (group: number) => {
          const pixels = built.pixelGrid.filter((pixel) => pixel.group === group);
          return pixels.reduce((sum, pixel) => sum + drawnCentre(pixel, built.size, transforms, move, built.shapeCenters, 1).y, 0) / pixels.length;
        };
        middle.hair = mean(PROP_HEAD_GROUP);
        middle.brows = mean(PROP_GROUP);
      });
      return { ...middle, pitch: built.size + built.gap };
    };
    const open = held('idle');
    for (const expression of ['sleep', 'happy', 'smug'] as const) {
      const narrowed = held(expression);
      expect(Math.abs(narrowed.hair - open.hair), expression).toBeLessThan(1);
      expect(narrowed.brows - open.brows, expression).toBeGreaterThan(2 * open.pitch);
    }
  });

  // Hair and brows touching an eye would read as part of it. They follow
  // the eyes (brows their tops, hair the head), through every expression,
  // the pop and the head turn, and the eyes never grow into them.
  it('keeps the hair and brows clear of the eyes in every expression and gaze', () => {
    for (const expression of EXPRESSIONS) {
      const built = grid(config, expression);
      const { pixelGrid, shapeCenters, size } = built;
      const eyes = [0, 1].map((group) => pixelGrid.filter((pixel) => pixel.group === group));
      const hairAndBrows = pixelGrid.filter((pixel) => pixel.group === PROP_HEAD_GROUP || pixel.group === PROP_GROUP);
      for (const gazeX of [-1, 0, 1]) {
        let closest = Infinity;
        playExpression(built, expression, gazeX, (transforms, move) => {
          const boxes = eyes.map((eye, i) => {
            const points = eye.map((pixel) => drawnCentre(pixel, size, transforms, move, shapeCenters, 1));
            const halfW = (size / 2) * transforms[i * 4]!;
            const halfH = (size / 2) * transforms[i * 4 + 1]!;
            return {
              left: Math.min(...points.map((p) => p.x)) - halfW,
              right: Math.max(...points.map((p) => p.x)) + halfW,
              top: Math.min(...points.map((p) => p.y)) - halfH,
              bottom: Math.max(...points.map((p) => p.y)) + halfH,
            };
          });
          for (const pixel of hairAndBrows) {
            const { x, y } = drawnCentre(pixel, size, transforms, move, shapeCenters, 1);
            for (const box of boxes) {
              // How far apart the two are, sideways or up and down (negative: overlapping).
              const apart = Math.max(box.left - (x + size / 2), x - size / 2 - box.right, box.top - (y + size / 2), y - size / 2 - box.bottom);
              closest = Math.min(closest, apart);
            }
          }
        });
        expect(closest, `${expression} gaze ${gazeX}`).toBeGreaterThan(0);
      }
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
