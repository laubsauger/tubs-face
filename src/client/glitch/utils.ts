export function normalizeRenderer(value: unknown): 'webgpu' | 'canvas2d' | 'auto' {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'webgpu' || mode === 'canvas2d' || mode === 'auto') return mode;
  return 'auto';
}

export function mergeConfig<T extends object>(base: T, patch: Partial<T> = {}): T {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key as keyof T];
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      current && typeof current === 'object' && !Array.isArray(current)
    ) {
      (merged as Record<string, unknown>)[key] = { ...(current as object), ...value };
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

export function hexToHSL(hex: string): { h: number; s: number; l: number } {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    h *= 360;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToRGB(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const normalizedS = s / 100;
  const normalizedL = l / 100;
  const a = normalizedS * Math.min(normalizedL, 1 - normalizedL);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return normalizedL - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
}

export function getColorLUT(cache: Map<number, string[]>, h: number, s: number): string[] {
  const key = (Math.round(h) + 360) % 360;
  let lut = cache.get(key);
  if (lut) return lut;
  lut = new Array(101);
  for (let l = 0; l <= 100; l += 1) {
    const { r, g, b } = hslToRGB(h, s, l);
    lut[l] = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }
  cache.set(key, lut);
  return lut;
}

function isInsideRoundedRect(px: number, py: number, rx: number, ry: number, rw: number, rh: number, rrx: number, rry: number): boolean {
  if (px < rx || px > rx + rw || py < ry || py > ry + rh) return false;
  const left = rx + rrx;
  const right = rx + rw - rrx;
  const top = ry + rry;
  const bottom = ry + rh - rry;
  if (px >= left && px <= right) return true;
  if (py >= top && py <= bottom) return true;
  let cx: number;
  let cy: number;
  if (px < left && py < top) { cx = left; cy = top; }
  else if (px > right && py < top) { cx = right; cy = top; }
  else if (px < left && py > bottom) { cx = left; cy = bottom; }
  else if (px > right && py > bottom) { cx = right; cy = bottom; }
  else return true;
  const dx = (px - cx) / rrx;
  const dy = (py - cy) / rry;
  return dx * dx + dy * dy <= 1;
}

function isInsideHeart(px: number, py: number, cx: number, cy: number, halfW: number, halfH: number): boolean {
  const nx = (px - cx) / halfW;
  const ny = -(py - cy) / halfH;
  const x2 = nx * nx;
  const y2 = ny * ny;
  const t = x2 + y2 - 1;
  return t * t * t - x2 * y2 * ny < 0;
}

function isInsideArc(px: number, py: number, cx: number, cy: number, w: number, h: number, inverted: boolean): boolean {
  const nx = (px - cx) / (w * 0.5);
  const rawNy = (py - cy) / (h * 0.5);
  const ny = inverted ? -rawNy : rawNy;
  const ey = -0.65;
  const dy = ny - ey;
  const d2 = nx * nx + dy * dy;
  const outerR2 = 1.35 * 1.35;
  const innerR2 = 0.8 * 0.8;
  return d2 <= outerR2 && d2 >= innerR2 && ny > ey;
}

export function testShapeHit(
  px: number,
  py: number,
  tx: number,
  ty: number,
  sw: number,
  sh: number,
  srx: number,
  sry: number,
  hitTest: 'heart' | 'frown' | 'smile-arc' | 'round' | string,
): boolean {
  switch (hitTest) {
    case 'heart':
      return isInsideHeart(px, py, tx + sw / 2, ty + sh / 2, sw / 2, sh / 2);
    case 'frown':
      return isInsideArc(px, py, tx + sw / 2, ty + sh / 2, sw, sh, true);
    case 'smile-arc':
      return isInsideArc(px, py, tx + sw / 2, ty + sh / 2, sw, sh, false);
    case 'round': {
      const dnx = (px - (tx + sw / 2)) / (sw / 2);
      const dny = (py - (ty + sh / 2)) / (sh / 2);
      return dnx * dnx + dny * dny <= 1;
    }
    default:
      return isInsideRoundedRect(px, py, tx, ty, sw, sh, srx, sry);
  }
}

export function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
