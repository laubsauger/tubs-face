// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Glitch FX — Pixel-art face with post-processing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';
import { onGazeTargetChanged } from './eye-tracking.js';
import { onBlink } from './expressions.js';

// ── Default config (ROBOT_FX) ──────────────

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

// ── Expression shape profiles ──────────────
// Multipliers/offsets applied to base shapes per expression.

const EXPRESSION_PROFILES = {
    idle: null,
    'idle-flat': null,
    listening: { eyeH: 1.09, eyeW: 1.07 },
    thinking: { eyeH: 0.5, eyeW: 1.15, eyeDy: 5, mouthW: 0.56, mouthH: 1.4, mouthRound: true },
    smile: { eyeH: 0.85, eyeDy: 2, mouthW: 0.85, mouthH: 1.8 },
    happy: { eyeH: 0.85, eyeDy: 2, mouthW: 0.85, mouthH: 1.8 },
    sad: { eyeH: 0.3, eyeDy: 7, eyeW: 1.15, mouthW: 0.56, mouthH: 0.7 },
    crying: { eyeH: 0.3, eyeDy: 7, eyeW: 1.15, mouthW: 0.56, mouthH: 0.7 },
    love: { eyeH: 0.85, eyeDy: 1, mouthW: 0.9, mouthH: 1.5 },
    sleep: { eyeH: 0.12, eyeDy: 8, mouthW: 0.8, mouthH: 0.5 },
    angry: { eyeH: 0.45, eyeW: 1.2, eyeDy: 4 },
    surprised: { eyeH: 1.15, eyeW: 1.1, mouthW: 0.56, mouthH: 1.8, mouthRound: true },
};

// ── Animation constants ───────────────────

const BLINK_CLOSE_MS = 80;
const BLINK_HOLD_MS = 60;
const BLINK_OPEN_MS = 80;
const BLINK_TOTAL_MS = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS;

const SPEAK_CYCLE_MS = 280;
const SPEAK_MIN_SCALE = 0.6;
const SPEAK_MAX_SCALE = 2.0;

const GAZE_EYE_RANGE_X = 0.14;
const GAZE_EYE_RANGE_Y = 0.09;
const GAZE_MOUTH_RANGE_X = 0.06;
const GAZE_MOUTH_RANGE_Y = 0.04;
const GAZE_LERP = 0.12;

const GLOW_ALPHA = 0.65;

// ── Module state ──────────────────────────

let config;
let canvas = null;
let ctx = null;
let tempCanvas = null;
let tempCtx = null;
let animFrameId = null;

let pixelGrid = [];
let shapeGroups = [];   // group index per pixel: 0=leftEye, 1=rightEye, 2=mouth
let shapeCenters = [];  // { cx, cy } per shape (face-relative CSS coords)

let baseHSL = { h: 271, s: 91, l: 65 };
let startTime = 0;
let colorLUTs = new Map();
let scanlinePattern = null;
let cachedDpr = 1;
let cachedGlowFilter = 'blur(14px)';
let cachedScanBeamRGBA = 'rgba(166,0,255,0.26)';
let resizeTimer = null;

let faceEl = null;
let containerEl = null;

// Face position within the canvas (the canvas fills the viewport container,
// so we need to know where #face is to draw the pixel grid correctly).
let baseFaceX = 0;
let baseFaceY = 0;
let faceW = 0;
let faceH = 0;

// Dynamic face state
let gazeTargetX = 0;
let gazeTargetY = 0;
let currentGazeX = 0;
let currentGazeY = 0;
let blinkStartTime = 0;
let blinkActive = false;
let lastBuiltExpression = '';
let lastSleepingState = false;

// ── Utility ───────────────────────────────

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

// ── Expression helpers ────────────────────

function getActiveExpression() {
    if (STATE.sleeping) return 'sleep';
    return STATE.expression || 'idle';
}

function getModifiedShapes() {
    const expr = getActiveExpression();
    const profile = EXPRESSION_PROFILES[expr] || null;
    const base = config.svg.shapes;
    const shapes = base.map(s => ({ ...s }));
    if (!profile) return shapes;

    // Eyes (shapes 0 and 1)
    for (let i = 0; i < 2; i++) {
        const s = shapes[i];
        const cx = s.x + s.w / 2;
        const cy = s.y + s.h / 2;
        if (profile.eyeW) { s.w *= profile.eyeW; s.x = cx - s.w / 2; }
        if (profile.eyeH) { s.h *= profile.eyeH; s.y = cy - s.h / 2; }
        if (profile.eyeDy) { s.y += profile.eyeDy; }
        s.rx = Math.min(s.rx, s.w / 2);
        s.ry = Math.min(s.ry, s.h / 2);
    }

    // Mouth (shape 2)
    const m = shapes[2];
    const mcx = m.x + m.w / 2;
    const mcy = m.y + m.h / 2;
    if (profile.mouthW) { m.w *= profile.mouthW; m.x = mcx - m.w / 2; }
    if (profile.mouthH) { m.h *= profile.mouthH; m.y = mcy - m.h / 2; }
    if (profile.mouthRound) { m.rx = Math.min(m.w, m.h) / 2; m.ry = m.rx; }
    m.rx = Math.min(m.rx, m.w / 2);
    m.ry = Math.min(m.ry, m.h / 2);

    return shapes;
}

function getBlinkFactor(now) {
    if (!blinkActive) return 0;
    const elapsed = now - blinkStartTime;
    if (elapsed >= BLINK_TOTAL_MS) { blinkActive = false; return 0; }
    if (elapsed < BLINK_CLOSE_MS) return elapsed / BLINK_CLOSE_MS;
    if (elapsed < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 1;
    return 1 - (elapsed - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS;
}

function getSpeakMouthScale(now) {
    if (!faceEl || !faceEl.classList.contains('speaking')) return 1;
    const phase = ((now - startTime) % SPEAK_CYCLE_MS) / SPEAK_CYCLE_MS;
    return SPEAK_MIN_SCALE + (SPEAK_MAX_SCALE - SPEAK_MIN_SCALE) *
        (0.5 + 0.5 * Math.sin(phase * Math.PI * 2));
}

// ── Canvas & layout sizing ────────────────

function computeFacePosition() {
    if (!faceEl || !containerEl) return;
    const cr = containerEl.getBoundingClientRect();
    const fr = faceEl.getBoundingClientRect();
    // Subtract the current parallax transform to get the base position
    const lookX = parseFloat(faceEl.style.getPropertyValue('--face-look-x')) || 0;
    const lookY = parseFloat(faceEl.style.getPropertyValue('--face-look-y')) || 0;
    baseFaceX = fr.left - cr.left - lookX;
    baseFaceY = fr.top - cr.top - lookY;
    faceW = fr.width;
    faceH = fr.height;
}

function sizeCanvas() {
    if (!containerEl || !canvas) return;
    const cr = containerEl.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    const dpr = window.devicePixelRatio || 1;
    cachedDpr = dpr;
    const pw = Math.round(cr.width * dpr);
    const ph = Math.round(cr.height * dpr);
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
    computeFacePosition();
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

// ── Pixel grid computation ────────────────
// Pixel positions are in face-relative CSS coordinates.
// The face offset (baseFaceX/Y + parallax) is added at draw time.

function buildPixelGrid() {
    pixelGrid = [];
    shapeGroups = [];
    shapeCenters = [];
    colorLUTs.clear();
    if (!faceEl) return;
    const W = faceW || faceEl.getBoundingClientRect().width;
    const H = faceH || faceEl.getBoundingClientRect().height;
    if (!W || !H) return;

    const shapes = getModifiedShapes();
    const vb = config.svg.viewBox;
    const scale = Math.min(W / vb.w, H / vb.h);
    const offsetX = (W - vb.w * scale) / 2;
    const offsetY = (H - vb.h * scale) / 2;
    const sz = config.pixel.size;
    const gap = config.pixel.gap;
    const stride = sz + gap;
    const hueVar = config.color.hueVariation;
    const brightVar = config.color.brightnessVariation;

    for (let si = 0; si < shapes.length; si++) {
        const shape = shapes[si];
        const sx = offsetX + shape.x * scale;
        const sy = offsetY + shape.y * scale;
        const sw = shape.w * scale;
        const sh = shape.h * scale;
        const srx = shape.rx * scale;
        const sry = shape.ry * scale;

        shapeCenters.push({ cx: sx + sw / 2, cy: sy + sh / 2 });

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
                shapeGroups.push(si);
            }
        }
    }

    lastBuiltExpression = getActiveExpression();
    lastSleepingState = STATE.sleeping;
}

function recolorPixelGrid() {
    colorLUTs.clear();
    for (let i = 0; i < pixelGrid.length; i++) {
        pixelGrid[i].lut = getColorLUT(baseHSL.h + pixelGrid[i].hueOff, baseHSL.s);
    }
}

// ── Render loop ───────────────────────────

function renderFrame(now) {
    if (!STATE.glitchFxEnabled) { animFrameId = null; return; }
    animFrameId = requestAnimationFrame(renderFrame);

    // Detect expression/sleep changes → rebuild grid
    const currentExpr = getActiveExpression();
    if (currentExpr !== lastBuiltExpression || STATE.sleeping !== lastSleepingState) {
        buildPixelGrid();
    }

    // Smooth gaze interpolation
    currentGazeX += (gazeTargetX - currentGazeX) * GAZE_LERP;
    currentGazeY += (gazeTargetY - currentGazeY) * GAZE_LERP;

    const t = (now - startTime) / 1000;
    const dpr = cachedDpr;
    const pw = canvas.width;
    const ph = canvas.height;
    const W = pw / dpr;   // canvas CSS width (viewport width)
    const H = ph / dpr;   // canvas CSS height (viewport height)
    if (!pw || !ph) return;

    const sz = config.pixel.size;

    // Face parallax offset (reads CSS custom properties set by eye-tracking)
    const faceLookX = parseFloat(faceEl?.style.getPropertyValue('--face-look-x')) || 0;
    const faceLookY = parseFloat(faceEl?.style.getPropertyValue('--face-look-y')) || 0;
    const faceOX = baseFaceX + faceLookX;
    const faceOY = baseFaceY + faceLookY;

    // Gaze offsets in CSS pixels
    const eyeGazeX = currentGazeX * faceW * GAZE_EYE_RANGE_X;
    const eyeGazeY = currentGazeY * faceH * GAZE_EYE_RANGE_Y;
    const mouthGazeX = currentGazeX * faceW * GAZE_MOUTH_RANGE_X;
    const mouthGazeY = currentGazeY * faceH * GAZE_MOUTH_RANGE_Y;

    // Blink & speaking
    const blinkF = getBlinkFactor(now);
    const mouthScale = getSpeakMouthScale(now);

    // ── Time-based modulators ──

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

    // ── Pass 1: Sharp pixels ──
    // Pixel positions are face-relative; we add faceOX/OY + gaze offsets.

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const bsl = baseHSL.l;
    for (let i = 0; i < pixelGrid.length; i++) {
        const p = pixelGrid[i];
        const group = shapeGroups[i];

        let drawX = p.x + faceOX;
        let drawY = p.y + faceOY;
        let drawSzY = sz;

        // Eye gaze + blink (groups 0 and 1)
        if (group <= 1) {
            drawX += eyeGazeX;
            drawY += eyeGazeY;
            if (blinkF > 0 && shapeCenters[group]) {
                const centerY = shapeCenters[group].cy + faceOY + eyeGazeY;
                drawY = centerY + (drawY - centerY) * (1 - blinkF);
                drawSzY = Math.max(2, sz * (1 - blinkF * 0.85));
            }
        }

        // Mouth gaze + speaking (group 2)
        if (group === 2) {
            drawX += mouthGazeX;
            drawY += mouthGazeY;
            if (mouthScale !== 1 && shapeCenters[2]) {
                const centerY = shapeCenters[2].cy + faceOY + mouthGazeY;
                drawY = centerY + (drawY - centerY) * mouthScale;
            }
        }

        // Lightness with scan beam
        let l = (bsl + p.brightOff) * pulseMod;
        if (sb.enabled) {
            const dist = Math.abs(drawY + sz * 0.5 - scanY);
            if (dist < sbHalfW) {
                l += (1 - dist / sbHalfW) * sb.brightness * 30;
            }
        }

        const li = l < 0 ? 0 : l > 100 ? 100 : (l + 0.5) | 0;
        ctx.fillStyle = p.lut[li];
        ctx.fillRect(drawX, drawY, sz, drawSzY);
    }

    // ── Pass 2: Glow bloom ──

    tempCtx.setTransform(1, 0, 0, 1, 0, 0);
    tempCtx.clearRect(0, 0, pw, ph);
    tempCtx.drawImage(canvas, 0, 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);

    ctx.filter = cachedGlowFilter;
    ctx.globalAlpha = GLOW_ALPHA * config.glow.bloomIntensity * flickerMod;
    ctx.drawImage(tempCanvas, 0, 0);

    ctx.filter = 'none';
    ctx.globalAlpha = flickerMod;
    ctx.drawImage(tempCanvas, 0, 0);

    // ── Pass 3: Chromatic aberration ──

    if (chr.enabled && chr.intensity > 0) {
        ctx.filter = 'hue-rotate(40deg)';
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = chr.intensity * 0.35 * flickerMod;
        ctx.drawImage(tempCanvas, Math.round(chrOffX * dpr), Math.round(chrOffY * dpr));
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
    }

    // ── Pass 4: Glitch slice ──

    if (inBurst) {
        tempCtx.clearRect(0, 0, pw, ph);
        tempCtx.drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, pw, ph);

        const sliceH = Math.ceil(ph / gs.sliceCount);
        for (let j = 0; j < gs.sliceCount; j++) {
            if (Math.random() < gs.gapChance) continue;
            const sy = j * sliceH;
            const off = ((Math.random() - 0.5) * 2 * gs.maxOffset * gs.intensity * dpr) | 0;
            ctx.drawImage(tempCanvas, 0, sy, pw, sliceH, off, sy, pw, sliceH);
        }
    }

    // ── Pass 5: Scan beam glow overlay ──

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

    // ── Pass 6: Scanlines ──

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

    // Reset
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ── Public API ────────────────────────────

export function enableGlitchFx() {
    if (STATE.glitchFxEnabled && animFrameId) return;
    STATE.glitchFxEnabled = true;
    if (faceEl) faceEl.classList.add('use-glitch-fx');
    if (canvas) canvas.style.display = 'block';
    computeFacePosition();
    sizeCanvas();
    buildPixelGrid();
    startTime = performance.now();
    animFrameId = requestAnimationFrame(renderFrame);
}

export function disableGlitchFx() {
    STATE.glitchFxEnabled = false;
    if (faceEl) faceEl.classList.remove('use-glitch-fx');
    if (canvas) canvas.style.display = 'none';
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
    faceEl = document.getElementById('face');

    // Find the viewport-filling container to host the canvas
    containerEl = document.getElementById('center')
        || document.getElementById('mini-root')
        || (faceEl && faceEl.parentElement);

    canvas = document.createElement('canvas');
    canvas.id = 'glitch-fx-canvas';
    canvas.style.display = 'none';
    ctx = canvas.getContext('2d');

    if (containerEl) {
        // Insert at start so it's behind other content in the container
        containerEl.insertBefore(canvas, containerEl.firstChild);
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

    // Gaze tracking
    onGazeTargetChanged(({ x, y }) => {
        gazeTargetX = x;
        gazeTargetY = y;
    });

    // Blink animation
    onBlink(() => {
        blinkActive = true;
        blinkStartTime = performance.now();
    });

    // Debounced resize — recompute face position + rebuild grid
    const resizeTarget = containerEl || faceEl;
    if (resizeTarget) {
        new ResizeObserver(() => {
            if (!STATE.glitchFxEnabled) return;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                computeFacePosition();
                sizeCanvas();
                buildPixelGrid();
            }, 80);
        }).observe(resizeTarget);
    }

    startTime = performance.now();

    // Auto-enable if state says so
    if (STATE.glitchFxEnabled) {
        enableGlitchFx();
    }
}
