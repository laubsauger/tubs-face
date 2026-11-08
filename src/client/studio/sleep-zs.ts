// The sleeping "z z z" for a studio stream. On the face window it is page text
// (.visual-zzz in styles/app.css, ui/visual-shell.tsx); a studio stream carries
// only the canvas, so the Zs are drawn into the published frame here: the
// app's font, step-down sizes, up-and-right arrangement, float and fade.
//
// They are sized and placed for a stream, from the head's actual sleeping
// face: they start just above the right eye's outer corner and float up and
// right into the empty top of the frame, as big as that room allows (the
// largest up to ~15 % of the frame height, so they read with the face far
// back). They never cover the eyes or mouth (a sleeping face holds its gaze at
// centre), and never leave the frame. The letters are one near-white for both heads (STUDIO_ZZZ_COLOR); a
// faint outer glow in the head's colour tells the heads apart.

/** The letters' colour, for both heads, at full brightness. Change it here. */
export const STUDIO_ZZZ_COLOR = '#f1eefc';
export const ZZZ_FONT = '800 {size}px Outfit, "Avenir Next", system-ui, sans-serif';

// The app's zzzFloat (styles/app.css): 3.6 s, each Z 1.2 s after the last,
// drifting up 1.2 em and right 0.35 em while growing from 0.82 to 1.08.
const CYCLE_S = 3.6;
const DELAYS_S = [0, -1.2, -2.4];
const FLOAT_UP_EM = 1.2;
const FLOAT_RIGHT_EM = 0.35;
const SCALE_FROM = 0.82;
const SCALE_TO = 1.08;

/**
 * The three Zs as the app lays them out (.visual-zzz > span), converted to the
 * centres of the visible letters: size in units of the first Z's font size,
 * and offset from the first Z's centre in the same unit.
 */
const GLYPHS = [
  { size: 1, dx: 0, dy: 0 },
  { size: 0.7, dx: 0.5325, dy: -0.733 },
  { size: 0.48, dx: 0.943, dy: -1.317 },
];

/** The visible "z" in em: Outfit 800's x-height and width (measured in the page once the font is there). */
export interface GlyphMetrics {
  heightEm: number;
  widthEm: number;
}
export const DEFAULT_GLYPH: GlyphMetrics = { heightEm: 0.52, widthEm: 0.5 };

/** The largest Z's visible height, as a share of the frame, when there is room for it. */
export const TARGET_HEIGHT_SHARE = 0.15;
/** Glow, as a share of each Z's font size (the app's 32 px and 14 px at its largest Zs, 160 px). */
const OUTER_GLOW_EM = 0.2;
const INNER_GLOW_EM = 0.0875;
const INNER_GLOW_ALPHA = 0.95;
const OUTER_GLOW_ALPHA = 0.55;
const FALLBACK_GLOW = '#84b6ff';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the face is while it sleeps, in canvas pixels, and how far gaze can move its eyes. */
export interface SleepingFace {
  /** Both eyes and the mouth of the sleeping face, at rest (no gaze). */
  leftEye: Box;
  rightEye: Box;
  mouth: Box;
  /** The furthest gaze moves the eyes, sideways and up or down. */
  gazeX: number;
  gazeY: number;
}

export interface SleepZLayout {
  /** The first Z's centre at rest. */
  x: number;
  y: number;
  /** The first Z's font size. */
  em: number;
  /** Share of the app's float travel that fits (1 = all of it). */
  rise: number;
  /** Share of the app's spacing between the Zs, up and sideways (1 = as in the app). */
  spread: number;
  spreadX: number;
}

export interface DrawnZ {
  /** Centre of the visible letter, its font size, scale and opacity. */
  cx: number;
  cy: number;
  fontPx: number;
  scale: number;
  opacity: number;
}

/** CSS ease-in-out: cubic-bezier(0.42, 0, 0.58, 1). */
export function easeInOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bezier = (u: number, p1: number, p2: number) => 3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (bezier(mid, 0.42, 0.58) < t) lo = mid;
    else hi = mid;
  }
  return bezier((lo + hi) / 2, 0, 1);
}

/** zzzFloat's opacity: 0 -> 0.92 (12 %) -> 0.7 (75 %) -> 0, each step eased. */
function opacityAt(p: number): number {
  if (p < 0.12) return 0.92 * easeInOut(p / 0.12);
  if (p < 0.75) return 0.92 + (0.7 - 0.92) * easeInOut((p - 0.12) / 0.63);
  return 0.7 * (1 - easeInOut((p - 0.75) / 0.25));
}

/** The Zs at `seconds`. */
export function sleepZs(seconds: number, layout: SleepZLayout, reducedMotion = false): DrawnZ[] {
  return GLYPHS.map((glyph, index) => {
    const fontPx = layout.em * glyph.size;
    const restX = layout.x + glyph.dx * layout.em * layout.spreadX;
    const restY = layout.y + glyph.dy * layout.em * layout.spread;
    if (reducedMotion) return { cx: restX, cy: restY, fontPx, scale: 1, opacity: 0.8 };
    const delay = DELAYS_S[index] ?? 0;
    const p = ((((seconds - delay) % CYCLE_S) + CYCLE_S) % CYCLE_S) / CYCLE_S;
    const k = easeInOut(p);
    return {
      cx: restX + FLOAT_RIGHT_EM * fontPx * layout.rise * k,
      cy: restY - FLOAT_UP_EM * fontPx * layout.rise * k,
      fontPx,
      scale: SCALE_FROM + (SCALE_TO - SCALE_FROM) * k,
      opacity: opacityAt(p),
    };
  });
}

/** The visible letter's box. */
export function letterBox(z: DrawnZ, glyph: GlyphMetrics = DEFAULT_GLYPH): Box {
  const halfW = (glyph.widthEm * z.fontPx * z.scale) / 2;
  const halfH = (glyph.heightEm * z.fontPx * z.scale) / 2;
  return { left: z.cx - halfW, right: z.cx + halfW, top: z.cy - halfH, bottom: z.cy + halfH };
}

/** How far a Z's glow reaches past its letter, for keeping it in the frame. */
export function glowReach(z: DrawnZ): number {
  return OUTER_GLOW_EM * z.fontPx * 0.6;
}

/** Everything the Zs reach over a whole cycle: letters, and letters plus glow. */
function reach(layout: SleepZLayout, glyph: GlyphMetrics): { letters: Box; glow: Box } {
  const letters: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const glow: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (let step = 0; step <= 24; step += 1) {
    for (const z of sleepZs((step / 24) * CYCLE_S, layout)) {
      const box = letterBox(z, glyph);
      const halo = glowReach(z);
      letters.left = Math.min(letters.left, box.left);
      letters.right = Math.max(letters.right, box.right);
      letters.top = Math.min(letters.top, box.top);
      letters.bottom = Math.max(letters.bottom, box.bottom);
      glow.left = Math.min(glow.left, box.left - halo);
      glow.right = Math.max(glow.right, box.right + halo);
      glow.top = Math.min(glow.top, box.top - halo);
      glow.bottom = Math.max(glow.bottom, box.bottom + halo);
    }
  }
  return { letters, glow };
}

/** Closest the Zs get to each other, and least float kept, before the letters shrink instead. */
const MIN_SPREAD = 0.75;
const MIN_RISE = 0.4;
/** Sideways the Zs may close up further, so the first one stays at the eye's corner. */
const MIN_SPREAD_X = 0.35;

/**
 * Size and place the Zs for this face: the first one just above the right
 * eye's outer corner, clear of both eyes and the mouth wherever gaze moves
 * them; as large as the room above allows (up to TARGET_HEIGHT_SHARE). Size
 * comes first: the spacing and the float give way (down to MIN_SPREAD and
 * MIN_RISE of the app's) before the letters shrink. Near the right edge the Zs
 * climb more steeply (MIN_SPREAD_X) rather than leave the corner; only then
 * do they move left.
 */
export function layoutSleepZs(face: SleepingFace, frame: number, glyph: GlyphMetrics = DEFAULT_GLYPH): SleepZLayout {
  const margin = frame * 0.015;
  // The highest any part of the face gets: the eyes looking up.
  const faceTop = Math.min(face.leftEye.top, face.rightEye.top, face.mouth.top) - face.gazeY;
  const targetEm = (TARGET_HEIGHT_SHARE * frame) / glyph.heightEm;
  let fallback: SleepZLayout | null = null;
  const options: Array<{ spread: number; rise: number }> = [];
  for (let spread = 1; spread >= MIN_SPREAD - 1e-9; spread -= 0.05) {
    for (let rise = 1; rise >= MIN_RISE - 1e-9; rise -= 0.05) options.push({ spread, rise });
  }
  // Most of the app's spacing and float first.
  options.sort((a, b) => (b.spread + b.rise) - (a.spread + a.rise));
  // How far the first Z may move left of the corner before that counts as leaving it.
  const cornerSlack = frame * 0.03;
  for (let em = targetEm; em > targetEm * 0.2; em *= 0.97) {
    const gap = Math.max(frame * 0.012, OUTER_GLOW_EM * em * 0.4);
    for (const { spread, rise } of options) {
      for (let spreadX = spread; spreadX >= MIN_SPREAD_X - 1e-9; spreadX -= 0.05) {
        // The first Z centred over the outer corner, its lowest point just above the face.
        const trial: SleepZLayout = { x: face.rightEye.right, y: 0, em, rise, spread, spreadX };
        trial.y = faceTop - gap - reach(trial, glyph).letters.bottom;
        let { glow } = reach(trial, glyph);
        // Near the right edge: move left (the letters stay above the face, so nothing gets covered).
        const shift = Math.max(0, glow.right - (frame - margin));
        if (shift > 0) {
          trial.x -= shift;
          glow = reach(trial, glyph).glow;
        }
        const fits = glow.top >= margin && glow.left >= margin && glow.right <= frame - margin;
        if (fits) fallback ??= trial;
        if (fits && shift <= cornerSlack) return trial;
      }
    }
  }
  return fallback ?? { x: face.rightEye.right, y: faceTop - frame * 0.1, em: targetEm * 0.2, rise: MIN_RISE, spread: MIN_SPREAD, spreadX: MIN_SPREAD_X };
}

/** `#rrggbb` (or `#rgb`) as rgba() with this alpha; the colour unchanged if it isn't hex. */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const digits = match[1]!.length === 3 ? [...match[1]!].map((d) => d + d).join('') : match[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The visible "z" of the font as the page draws it; null until the font gives real metrics. */
export function measureGlyph(ctx: CanvasRenderingContext2D): GlyphMetrics | null {
  ctx.save();
  ctx.font = ZZZ_FONT.replace('{size}', '100');
  const metrics = ctx.measureText('z');
  ctx.restore();
  const height = (metrics.actualBoundingBoxAscent ?? 0) + (metrics.actualBoundingBoxDescent ?? 0);
  const width = (metrics.actualBoundingBoxLeft ?? 0) + (metrics.actualBoundingBoxRight ?? 0);
  return height > 10 && width > 10 ? { heightEm: height / 100, widthEm: width / 100 } : null;
}

/**
 * Draws the Zs at `seconds`. `headColour` tints the faint outer glow so the
 * heads can be told apart; the letters stay STUDIO_ZZZ_COLOR.
 */
export function drawSleepZs(
  ctx: CanvasRenderingContext2D,
  seconds: number,
  layout: SleepZLayout,
  options: { reducedMotion?: boolean; headColour?: string | null } = {},
): void {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const z of sleepZs(seconds, layout, options.reducedMotion ?? false)) {
    if (z.opacity <= 0.001) continue;
    ctx.save();
    ctx.translate(z.cx, z.cy);
    ctx.scale(z.scale, z.scale);
    ctx.font = ZZZ_FONT.replace('{size}', z.fontPx.toFixed(1));
    // Centre the visible letter on (0, 0).
    const metrics = ctx.measureText('z');
    const left = metrics.actualBoundingBoxLeft ?? 0;
    const right = metrics.actualBoundingBoxRight ?? z.fontPx * DEFAULT_GLYPH.widthEm;
    const ascent = metrics.actualBoundingBoxAscent ?? z.fontPx * DEFAULT_GLYPH.heightEm;
    const descent = metrics.actualBoundingBoxDescent ?? 0;
    const x = (left - right) / 2;
    const y = (ascent - descent) / 2;
    ctx.globalAlpha = z.opacity;
    ctx.fillStyle = STUDIO_ZZZ_COLOR;
    // Painted bottom-most first, as with CSS text-shadow.
    const glows = [
      { blur: OUTER_GLOW_EM * z.fontPx, colour: withAlpha(options.headColour ?? FALLBACK_GLOW, OUTER_GLOW_ALPHA) },
      { blur: INNER_GLOW_EM * z.fontPx, colour: withAlpha(STUDIO_ZZZ_COLOR, INNER_GLOW_ALPHA) },
    ];
    for (const glow of glows) {
      ctx.shadowColor = glow.colour;
      ctx.shadowBlur = glow.blur;
      ctx.fillText('z', x, y);
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.fillText('z', x, y);
    ctx.restore();
  }
  ctx.restore();
}
