// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Glitch FX — Pixel-art face with post-processing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';

// ── Default config (ROBOT_FX from docs/Glitch Tool/config.js) ──

const DEFAULT_CONFIG = {
    svg: {
        viewBox: { w: 52.82, h: 27.45 },
        shapes: [
            { x: 0, y: 0, w: 14.59, h: 22.47, rx: 5.94, ry: 5.94 },
            { x: 40.85, y: 0, w: 14.59, h: 22.47, rx: 5.94, ry: 5.94 },
            { x: 20.53, y: 23.86, w: 14.38, h: 6.44, rx: 1.95, ry: 1.95 },
        ],
    },
    pixel: { size: 21, gap: 7, edgeSoftness: 0, borderRadius: 0 },
    color: { base: '#a855f7', hueVariation: 8, brightnessVariation: 8, opacityMin: 0.5 },
    glow: { pixelGlow: 14, outerBloom: 0, bloomIntensity: 1, color: '#5900ff', falloffCurve: 2.8 },
    brightnessPulse: { enabled: true, dim: 0.62, bright: 1, speed: 17 },
    scanBeam: { enabled: true, speed: 10, lineWidth: 7, brightness: 0.65, glowStrength: 26, jitter: 1, color: '#a600ff' },
    chromatic: { enabled: true, offsetX: 0, offsetY: 4.5, intensity: 0.65, animate: true, animateSpeed: 7 },
    glitchSlice: {
        enabled: true, sliceCount: 24, maxOffset: 5, speed: 28,
        intensity: 0.53, colorShift: 0.03, gapChance: 0.07,
        interval: 6200, burstDuration: 3000,
    },
    glitch: {
        scanlines: true, scanlineIntensity: 0.41, scanlineSpacing: 5,
        scanlineThickness: 3, scanlineMove: true, scanlineSpeed: 26,
        pixelJitter: 0, flicker: true, flickerSpeed: 11, flickerDepth: 0.02,
    },
};

// ── Module state ────────────────────────────

let config;
let canvas = null;
let ctx = null;
let tempCanvas = null;
let tempCtx = null;
let animFrameId = null;
let pixelGrid = [];       // { x, y, hueOff, brightOff, lut }
let baseHSL = { h: 271, s: 91, l: 65 };
let scanBeamRGB = { r: 166, g: 0, b: 255 };
let startTime = 0;
let colorLUTs = new Map(); // hue-key → hex-string[101]
let scanlinePattern = null;
let cachedDpr = 1;
let cachedGlowFilter = 'blur(14px)';
let cachedScanBeamRGBA = 'rgba(166,0,255,0.26)';
let resizeTimer = null;

const GLOW_ALPHA = 0.65;

// ── Utility ─────────────────────────────────

function hexToHSL(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
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

function hslToRGB(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    return {
        r: Math.round(f(0) * 255),
        g: Math.round(f(8) * 255),
        b: Math.round(f(4) * 255),
    };
}

// Pre-compute 101 hex color strings for a given (hue, saturation) pair.
// Indexed by integer lightness 0–100. Eliminates per-frame string alloc.
function getColorLUT(h, s) {
    const key = (Math.round(h) + 360) % 360;
    let lut = colorLUTs.get(key);
    if (lut) return lut;
    lut = new Array(101);
    for (let l = 0; l <= 100; l++) {
        const { r, g, b } = hslToRGB(h, s, l);
        lut[l] = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    }
    colorLUTs.set(key, lut);
    return lut;
}

function applyDerivedColors(hex) {
    const hsl = hexToHSL(hex);
    baseHSL = hsl;
    const sb = hslToRGB(hsl.h, 100, 50);
    scanBeamRGB = sb;
    cachedScanBeamRGBA = `rgba(${sb.r},${sb.g},${sb.b},0.26)`;
    cachedGlowFilter = `blur(${Math.round(config.glow.pixelGlow * cachedDpr)}px)`;
}

function isInsideRoundedRect(px, py, rx, ry, rw, rh, rrx, rry) {
    if (px < rx || px > rx + rw || py < ry || py > ry + rh) return false;
    const left = rx + rrx;
    const right = rx + rw - rrx;
    const top = ry + rry;
    const bottom = ry + rh - rry;
    if (px >= left && px <= right) return true;
    if (py >= top && py <= bottom) return true;
    let cx, cy;
    if (px < left && py < top) { cx = left; cy = top; }
    else if (px > right && py < top) { cx = right; cy = top; }
    else if (px < left && py > bottom) { cx = left; cy = bottom; }
    else if (px > right && py > bottom) { cx = right; cy = bottom; }
    else return true;
    const dx = (px - cx) / rrx;
    const dy = (py - cy) / rry;
    return dx * dx + dy * dy <= 1;
}

// ── Canvas sizing ───────────────────────────

function sizeCanvas() {
    const face = document.getElementById('face');
    if (!face || !canvas) return;
    const rect = face.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    cachedDpr = dpr;
    const pw = Math.round(rect.width * dpr);
    const ph = Math.round(rect.height * dpr);
    if (canvas.width === pw && canvas.height === ph) return;
    canvas.width = pw;
    canvas.height = ph;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!tempCanvas) {
        tempCanvas = document.createElement('canvas');
        tempCtx = tempCanvas.getContext('2d');
    }
    tempCanvas.width = pw;
    tempCanvas.height = ph;
    cachedGlowFilter = `blur(${Math.round(config.glow.pixelGlow * dpr)}px)`;
    rebuildScanlinePattern();
}

function rebuildScanlinePattern() {
    if (!ctx || !config.glitch.scanlines) { scanlinePattern = null; return; }
    const spacing = Math.max(1, Math.round(config.glitch.scanlineSpacing * cachedDpr));
    const thickness = Math.max(1, Math.round(config.glitch.scanlineThickness * cachedDpr));
    const pc = document.createElement('canvas');
    pc.width = 4;
    pc.height = spacing;
    const pctx = pc.getContext('2d');
    pctx.fillStyle = '#000';
    pctx.fillRect(0, 0, 4, thickness);
    scanlinePattern = ctx.createPattern(pc, 'repeat');
}

// ── Pixel grid computation ──────────────────

function buildPixelGrid() {
    pixelGrid = [];
    colorLUTs.clear();
    const face = document.getElementById('face');
    if (!face) return;
    const rect = face.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    if (!W || !H) return;

    const vb = config.svg.viewBox;
    const scale = Math.min(W / vb.w, H / vb.h);
    const offsetX = (W - vb.w * scale) / 2;
    const offsetY = (H - vb.h * scale) / 2;
    const sz = config.pixel.size;
    const gap = config.pixel.gap;
    const stride = sz + gap;
    const hueVar = config.color.hueVariation;
    const brightVar = config.color.brightnessVariation;

    for (const shape of config.svg.shapes) {
        const sx = offsetX + shape.x * scale;
        const sy = offsetY + shape.y * scale;
        const sw = shape.w * scale;
        const sh = shape.h * scale;
        const srx = shape.rx * scale;
        const sry = shape.ry * scale;

        const cols = Math.floor(sw / stride);
        const rows = Math.floor(sh / stride);
        if (cols <= 0 || rows <= 0) continue;

        const gridOffX = sx + (sw - cols * stride + gap) / 2;
        const gridOffY = sy + (sh - rows * stride + gap) / 2;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const px = gridOffX + c * stride;
                const py = gridOffY + r * stride;
                const cx = px + sz / 2;
                const cy = py + sz / 2;
                if (!isInsideRoundedRect(cx, cy, sx, sy, sw, sh, srx, sry)) continue;

                const hOff = (Math.random() - 0.5) * 2 * hueVar;
                const bOff = (Math.random() - 0.5) * 2 * brightVar;
                pixelGrid.push({
                    x: px,
                    y: py,
                    hueOff: hOff,
                    brightOff: bOff,
                    lut: getColorLUT(baseHSL.h + hOff, baseHSL.s),
                });
            }
        }
    }
}

// Rebuild only the color LUTs (preserves grid positions & random offsets)
function recolorPixelGrid() {
    colorLUTs.clear();
    for (let i = 0; i < pixelGrid.length; i++) {
        pixelGrid[i].lut = getColorLUT(baseHSL.h + pixelGrid[i].hueOff, baseHSL.s);
    }
}

// ── Render loop ─────────────────────────────

function renderFrame(now) {
    if (!STATE.glitchFxEnabled) { animFrameId = null; return; }
    animFrameId = requestAnimationFrame(renderFrame);

    const t = (now - startTime) / 1000;
    const dpr = cachedDpr;
    const pw = canvas.width;
    const ph = canvas.height;
    const W = pw / dpr;
    const H = ph / dpr;
    if (!pw || !ph) return;

    const sz = config.pixel.size;

    // ── Time-based modulators ─────────────

    const bp = config.brightnessPulse;
    const pulseMod = bp.enabled
        ? bp.dim + (bp.bright - bp.dim) * (0.5 + 0.5 * Math.sin(t * bp.speed * 0.3))
        : 1;

    const sb = config.scanBeam;
    const scanY = sb.enabled
        ? H * (0.5 + 0.5 * Math.sin(t * sb.speed * 0.15)) + (Math.random() - 0.5) * sb.jitter
        : -9999;
    const sbHalfW = sb.lineWidth * sz * 0.5;

    const chr = config.chromatic;
    const chrOffX = chr.enabled
        ? chr.offsetX + (chr.animate ? Math.sin(t * chr.animateSpeed * 0.4) * 2 : 0)
        : 0;
    const chrOffY = chr.enabled
        ? chr.offsetY + (chr.animate ? Math.cos(t * chr.animateSpeed * 0.3) * 2 : 0)
        : 0;

    const gs = config.glitchSlice;
    const burstPhase = (now - startTime) % (gs.interval + gs.burstDuration);
    const inBurst = gs.enabled && burstPhase > gs.interval;

    const fl = config.glitch;
    const flickerMod = fl.flicker
        ? 1 - fl.flickerDepth * (0.5 + 0.5 * Math.sin(t * fl.flickerSpeed * 2))
        : 1;

    // ── Pass 1: Sharp pixels (DPR transform, CSS coords) ──
    // No shadowBlur — glow is composited via blur drawImage in pass 2.

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const bsl = baseHSL.l;
    for (let i = 0; i < pixelGrid.length; i++) {
        const p = pixelGrid[i];
        let l = (bsl + p.brightOff) * pulseMod;
        if (sb.enabled) {
            const dist = Math.abs(p.y + sz * 0.5 - scanY);
            if (dist < sbHalfW) {
                l += (1 - dist / sbHalfW) * sb.brightness * 30;
            }
        }
        // Clamp + round to integer index for LUT
        const li = l < 0 ? 0 : l > 100 ? 100 : (l + 0.5) | 0;
        ctx.fillStyle = p.lut[li];
        ctx.fillRect(p.x, p.y, sz, sz);
    }

    // ── Pass 2: Glow bloom (physical pixel space) ──
    // Copy sharp pixels → temp, then composite blurred glow + sharp back.

    tempCtx.setTransform(1, 0, 0, 1, 0, 0);
    tempCtx.clearRect(0, 0, pw, ph);
    tempCtx.drawImage(canvas, 0, 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);

    // Blurred glow layer
    ctx.filter = cachedGlowFilter;
    ctx.globalAlpha = GLOW_ALPHA * config.glow.bloomIntensity * flickerMod;
    ctx.drawImage(tempCanvas, 0, 0);

    // Sharp pixels on top
    ctx.filter = 'none';
    ctx.globalAlpha = flickerMod;
    ctx.drawImage(tempCanvas, 0, 0);

    // ── Pass 3: Chromatic aberration (physical pixel space) ──
    // Draw hue-rotated copy of sharp pixels at an offset with lighter blend.

    if (chr.enabled && chr.intensity > 0) {
        ctx.filter = 'hue-rotate(40deg)';
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = chr.intensity * 0.35 * flickerMod;
        ctx.drawImage(tempCanvas, Math.round(chrOffX * dpr), Math.round(chrOffY * dpr));
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
    }

    // ── Pass 4: Glitch slice (physical pixel space) ──

    if (inBurst) {
        tempCtx.clearRect(0, 0, pw, ph);
        tempCtx.drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, pw, ph);

        const sliceH = Math.ceil(ph / gs.sliceCount);
        for (let i = 0; i < gs.sliceCount; i++) {
            if (Math.random() < gs.gapChance) continue;
            const sy = i * sliceH;
            const off = ((Math.random() - 0.5) * 2 * gs.maxOffset * gs.intensity * dpr) | 0;
            ctx.drawImage(tempCanvas, 0, sy, pw, sliceH, off, sy, pw, sliceH);
        }
    }

    // ── Pass 5: Scan beam glow overlay (DPR transform) ──

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (sb.enabled) {
        const beamHalf = sb.lineWidth * sz;
        const grad = ctx.createLinearGradient(0, scanY - beamHalf, 0, scanY + beamHalf);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(0.5, cachedScanBeamRGBA);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.globalAlpha = sb.glowStrength / 100;
        ctx.fillRect(0, scanY - beamHalf, W, beamHalf * 2);
    }

    // ── Pass 6: Scanlines (physical pixel space, pattern fill) ──

    if (fl.scanlines && scanlinePattern) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = fl.scanlineIntensity;
        ctx.fillStyle = scanlinePattern;
        const sp = Math.max(1, Math.round(fl.scanlineSpacing * dpr));
        const scrollOff = fl.scanlineMove ? Math.round(t * fl.scanlineSpeed * dpr) % sp : 0;
        ctx.save();
        ctx.translate(0, scrollOff);
        ctx.fillRect(0, -scrollOff, pw, ph + sp);
        ctx.restore();
    }

    // Reset for next frame
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ── Public API ──────────────────────────────

export function enableGlitchFx() {
    if (STATE.glitchFxEnabled && animFrameId) return;
    STATE.glitchFxEnabled = true;
    const face = document.getElementById('face');
    if (face) face.classList.add('use-glitch-fx');
    sizeCanvas();
    buildPixelGrid();
    startTime = performance.now();
    animFrameId = requestAnimationFrame(renderFrame);
}

export function disableGlitchFx() {
    STATE.glitchFxEnabled = false;
    const face = document.getElementById('face');
    if (face) face.classList.remove('use-glitch-fx');
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    if (canvas && ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(cachedDpr, 0, 0, cachedDpr, 0, 0);
    }
}

export function setGlitchFxBaseColor(hex) {
    config.color = { ...config.color, base: hex };
    applyDerivedColors(hex);
    recolorPixelGrid();
}

export function setGlitchFxConfig(newConfig) {
    config = structuredClone({ ...DEFAULT_CONFIG, ...newConfig });
    applyDerivedColors(config.color.base);
    if (STATE.glitchFxEnabled) {
        sizeCanvas();
        buildPixelGrid();
    }
}

export function initGlitchFx() {
    config = structuredClone(DEFAULT_CONFIG);

    canvas = document.createElement('canvas');
    canvas.id = 'glitch-fx-canvas';
    ctx = canvas.getContext('2d');

    const face = document.getElementById('face');
    const zzzAnchor = document.getElementById('zzz-anchor');
    if (face && zzzAnchor) {
        face.insertBefore(canvas, zzzAnchor);
    } else if (face) {
        face.appendChild(canvas);
    }

    applyDerivedColors(config.color.base);

    // Wire toggle (with persistence)
    const toggle = document.getElementById('glitch-fx-toggle');
    if (toggle) {
        toggle.addEventListener('change', () => {
            if (toggle.checked) enableGlitchFx();
            else disableGlitchFx();
            fetch('/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ glitchFxEnabled: toggle.checked }),
            }).catch(() => {});
        });
    }

    // Debounced resize
    if (face) {
        new ResizeObserver(() => {
            if (!STATE.glitchFxEnabled) return;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                sizeCanvas();
                buildPixelGrid();
            }, 80);
        }).observe(face);
    }

    startTime = performance.now();
}
