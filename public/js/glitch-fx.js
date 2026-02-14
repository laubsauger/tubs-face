// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Glitch FX — Pixel-art face with post-processing
//  Dual backend: WebGPU (preferred) + Canvas 2D fallback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from './state.js';
import { onGazeTargetChanged } from './eye-tracking.js';
import { onBlink } from './expressions.js';

// ── Default config (ROBOT_FX) ──────────────

const DEFAULT_CONFIG = {
    renderer: 'auto', // auto | webgpu | canvas2d
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
    brightnessPulse: { enabled: true, dim: 0.88, bright: 1, speed: 3 },
    scanBeam: { enabled: true, speed: 10, lineWidth: 7, brightness: 0.65, glowStrength: 26, jitter: 1, color: '#a600ff' },
    chromatic: { enabled: true, offsetX: 0, offsetY: 4.5, intensity: 0.65, animate: true, animateSpeed: 7 },
    glitchSlice: {
        enabled: true, sliceCount: 24, maxOffset: 5, speed: 28,
        intensity: 0.53, colorShift: 0.03, gapChance: 0.07,
        interval: 18000, burstDuration: 1800,
    },
    glitch: {
        scanlines: true, scanlineIntensity: 0.41, scanlineSpacing: 5,
        scanlineThickness: 3, scanlineMove: true, scanlineSpeed: 26,
        pixelJitter: 0, flicker: true, flickerSpeed: 11, flickerDepth: 0.02,
    },
};

// ── Expression shape profiles ──────────────

const EXPRESSION_PROFILES = {
    idle: null,
    'idle-flat': { mouthH: 0.65 },
    listening: { eyeH: 1.09, eyeW: 1.07 },
    thinking: { eyeH: 0.5, eyeW: 1.15, eyeDy: 5, mouthW: 0.56, mouthH: 1.4, mouthRound: true },
    smile: { eyeH: 0.85, eyeDy: 2, mouthW: 0.85, mouthH: 1.8 },
    happy: { eyeH: 0.85, eyeDy: 2, mouthW: 0.85, mouthH: 1.8 },
    sad: { eyeH: 0.3, eyeDy: 7, eyeW: 1.15, mouthW: 0.56, mouthH: 0.7, mouthShape: 'frown' },
    crying: { eyeH: 0.3, eyeDy: 7, eyeW: 1.15, mouthW: 0.56, mouthH: 0.7, mouthShape: 'frown', tears: true, tearColorHex: '#57bfff' },
    love: { eyeH: 0.85, eyeDy: 1, mouthW: 0.9, mouthH: 1.5, eyeShape: 'heart', colorHex: '#ff4da1', mouthShape: 'smile-arc' },
    sleep: { eyeH: 0.12, eyeDy: 8, mouthW: 0.8, mouthH: 0.5 },
    angry: { eyeH: 0.45, eyeW: 1.2, eyeDy: 4, eyeSkew: -0.15 },
    surprised: { eyeH: 1.15, eyeW: 1.1, mouthW: 0.56, mouthH: 2.2, mouthRound: true, mouthShape: 'round' },
};

// ── Animation constants ───────────────────

const BLINK_CLOSE_MS = 80;
const BLINK_HOLD_MS = 60;
const BLINK_OPEN_MS = 80;
const BLINK_TOTAL_MS = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS;

const SPEAK_CYCLE_MS = 320;
const SPEAK_MIN_SCALE = 0.85;
const SPEAK_MAX_SCALE = 1.22;

const GAZE_EYE_RANGE_X = 0.14;
const GAZE_EYE_RANGE_Y = 0.09;
const GAZE_MOUTH_RANGE_X = 0.06;
const GAZE_MOUTH_RANGE_Y = 0.04;
const GAZE_LERP = 0.12;

const GLOW_ALPHA = 0.65;
const FEATURE_BOX_GLOBAL_SCALE_X = 0.92;
const FEATURE_BOX_GLOBAL_SCALE_Y = 0.92;
const FEATURE_MOUTH_SCALE_X = 0.92;
const FEATURE_MOUTH_SCALE_Y = 0.9;
const FEATURE_BOX_MAIN_BOOST = 0.03;
const GLITCH_DIAG = true;

// ── Module state ──────────────────────────

let config = structuredClone(DEFAULT_CONFIG);
let canvas = null;
let ctx = null;
let tempCanvas = null;
let tempCtx = null;
let animFrameId = null;
let resizeObserver = null;

let rendererKind = 'canvas2d'; // webgpu | canvas2d
let rendererReady = false;
let rendererInitPromise = null;
let glitchVisualActive = false;
let backendStatusEl = null;
let backendError = '';

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

// Face position within the canvas (canvas fills viewport container).
let baseFaceX = 0;
let baseFaceY = 0;
let faceW = 0;
let faceH = 0;
let containerCssW = 0;
let containerCssH = 0;
let effectivePixelSize = DEFAULT_CONFIG.pixel.size;
let effectivePixelGap = DEFAULT_CONFIG.pixel.gap;

// Dynamic face state
let gazeTargetX = 0;
let gazeTargetY = 0;
let currentGazeX = 0;
let currentGazeY = 0;
let blinkStartTime = 0;
let blinkActive = false;
let lastBuiltExpression = '';
let lastSleepingState = false;
let lastBurstState = false;
let glitchBurstSeed = Math.random() * 1000;
let diagLastLogAt = 0;
let lastGridDebug = null;

// ── WebGPU state ──────────────────────────

const GPU_UNIFORM_FLOATS = 64; // 16-byte aligned blocks
const gpuUniformData = new Float32Array(GPU_UNIFORM_FLOATS);
const gpuPostUniformData = new Float32Array(GPU_UNIFORM_FLOATS);

let gpuContext = null;
let gpuDevice = null;
let gpuPixelPipeline = null;
let gpuPostPipeline = null;
let gpuUniformBuffer = null;
let gpuPostUniformBuffer = null;
let gpuInstanceBuffer = null;
let gpuPixelBindGroup = null;
let gpuPostBindGroup = null;
let gpuSampler = null;
let gpuSceneTexture = null;
let gpuSceneTextureView = null;
let gpuSceneWidth = 0;
let gpuSceneHeight = 0;
let gpuInstanceCount = 0;
let gpuFormat = 'bgra8unorm';
const gpuSceneFormat = 'rgba8unorm';

const WEBGPU_SHADER = /* wgsl */`
struct Globals {
  canvas: vec4f,      // W, H, dpr, timeSec
  face: vec4f,        // faceOX, faceOY, faceW, faceH
  gaze: vec4f,        // eyeGazeX, eyeGazeY, mouthGazeX, mouthGazeY
  shapeCenters: vec4f,// leftEyeCenterY, rightEyeCenterY, mouthCenterY, blinkF
  motion: vec4f,      // mouthScale, pixelSize, opacityMin, pulseMod
  color: vec4f,       // baseHue01, baseSat01, baseLight01, flicker
  scan: vec4f,        // scanY, scanHalfW, scanBrightness, scanGlow
  chroma: vec4f,      // offX, offY, intensity, enabled
  glitch: vec4f,      // inBurst, sliceCount, maxOffset, intensity
  glitch2: vec4f,     // gapChance, burstSeed, intervalSec, burstDurSec
  scanline: vec4f,    // enabled, intensity, spacing, scroll
  flags: vec4f        // sleeping, scanlineThicknessRatio, reserved, reserved
};

@group(0) @binding(0) var<uniform> u: Globals;
@group(0) @binding(1) var<storage, read> pixels: array<vec4f>;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) hueOff: f32,
  @location(1) brightOff: f32,
  @location(2) worldPos: vec2f,
  @location(3) uv: vec2f,
  @location(4) visible: f32,
  @location(5) group: f32,
  @location(6) overrideColor: vec3f
};

fn hash12(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn hue2rgb(p: f32, q: f32, tIn: f32) -> f32 {
  var t = tIn;
  if (t < 0.0) { t = t + 1.0; }
  if (t > 1.0) { t = t - 1.0; }
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}

fn hslToRgb(h: f32, s: f32, l: f32) -> vec3f {
  if (s <= 0.0001) {
    return vec3f(l, l, l);
  }
  var q = l * (1.0 + s);
  if (l >= 0.5) {
    q = l + s - l * s;
  }
  let p = 2.0 * l - q;
  return vec3f(
    hue2rgb(p, q, h + 1.0 / 3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0 / 3.0)
  );
}

@vertex
fn vsMain(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VSOut {
  let base = iid * 2u;
  let a = pixels[base];
  let b = pixels[base + 1u];

  var x = a.x + u.face.x;
  var y = a.y + u.face.y;
  let hueOff = a.z;
  let brightOff = a.w;

  let group = b.x;
  var drawH = u.motion.y;
  let drawW = u.motion.y;

  if (group < 1.5) {
    x = x + u.gaze.x;
    y = y + u.gaze.y;
    if (u.shapeCenters.w > 0.0001) {
      var centerY = u.shapeCenters.x;
      if (group >= 0.5) {
        centerY = u.shapeCenters.y;
      }
      centerY = centerY + u.face.y + u.gaze.y;
      y = centerY + (y - centerY) * (1.0 - u.shapeCenters.w);
      drawH = max(2.0, u.motion.y * (1.0 - u.shapeCenters.w * 0.85));
    }
  } else if (group < 2.5) {
    x = x + u.gaze.z;
    y = y + u.gaze.w;
    let centerY = u.shapeCenters.z + u.face.y + u.gaze.w;
    y = centerY + (y - centerY) * u.motion.x;
  } else {
    // Tear decorators: follow eye gaze, no blink, oscillating flow
    x = x + u.gaze.x;
    y = y + u.gaze.y;
    y = y + sin(u.canvas.w * 1.5 + a.y * 0.05) * u.motion.y * 0.3;
  }

  var visible = 1.0;
  if (u.glitch.x > 0.5) {
    let sliceCount = max(1.0, u.glitch.y);
    let bandSize = max(1.0, u.canvas.y / sliceCount);
    let band = floor((y + drawH * 0.5) / bandSize);

    let gapNoise = hash12(vec2f(band, u.canvas.w * 0.77 + u.glitch2.y));
    if (gapNoise < u.glitch2.x) {
      visible = 0.0;
    }

    let offNoise = hash12(vec2f(band + 19.0, u.canvas.w * 1.73 + u.glitch2.y));
    x = x + (offNoise - 0.5) * 2.0 * u.glitch.z * u.glitch.w;
  }

  var corner = vec2f(1.0, 1.0);
  switch (vid) {
    case 0u: { corner = vec2f(0.0, 0.0); }
    case 1u: { corner = vec2f(1.0, 0.0); }
    case 2u: { corner = vec2f(0.0, 1.0); }
    case 3u: { corner = vec2f(0.0, 1.0); }
    case 4u: { corner = vec2f(1.0, 0.0); }
    default: { corner = vec2f(1.0, 1.0); }
  }

  let px = x + corner.x * drawW;
  let py = y + corner.y * drawH;

  let ndcX = (px / max(1.0, u.canvas.x)) * 2.0 - 1.0;
  let ndcY = 1.0 - (py / max(1.0, u.canvas.y)) * 2.0;

  var out: VSOut;
  out.position = vec4f(ndcX, ndcY, 0.0, 1.0);
  out.hueOff = hueOff;
  out.brightOff = brightOff;
  out.worldPos = vec2f(px, py);
  out.uv = corner;
  out.visible = visible;
  out.group = group;
  out.overrideColor = vec3f(b.y, b.z, b.w);
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4f {
  if (in.visible < 0.5) {
    discard;
  }

  var hue = fract(u.color.x + in.hueOff / 360.0);
  var sat = clamp(u.color.y, 0.0, 1.0);
  if (in.overrideColor.x > 0.5) {
    hue = fract(in.overrideColor.y);
    sat = clamp(in.overrideColor.z, 0.0, 1.0);
  }
  var light = (u.color.z * 100.0 + in.brightOff) * u.motion.w;

  if (u.scan.y > 0.0) {
    let dist = abs(in.worldPos.y - u.scan.x);
    if (dist < u.scan.y) {
      light = light + (1.0 - dist / u.scan.y) * u.scan.z * 30.0;
    }
  }

  let l = clamp(light / 100.0, 0.0, 1.0);
  let base = hslToRgb(hue, sat, l);
  var color = base;

  if (u.chroma.w > 0.5 && u.chroma.z > 0.0) {
    let wave = 0.5 + 0.5 * sin((in.worldPos.y + u.chroma.y) * 0.18 + (in.worldPos.x + u.chroma.x) * 0.07 + u.canvas.w * 3.2);
    color.r = color.r + wave * u.chroma.z * 0.28;
    color.b = color.b + (1.0 - wave) * u.chroma.z * 0.40;
  }

  let dx = abs(in.uv.x - 0.5) * 2.0;
  let dy = abs(in.uv.y - 0.5) * 2.0;
  let edge = max(dx, dy);
  let glow = pow(clamp(1.0 - edge, 0.0, 1.0), 1.6) * (u.scan.w / 120.0 + 0.16);
  color = color + base * glow;

  if (u.scanline.x > 0.5 && u.scanline.z > 0.0) {
    let phase = fract((in.worldPos.y + u.scanline.w) / max(1.0, u.scanline.z));
    let lineMask = 1.0 - step(u.flags.y, phase);
    let dim = 1.0 - lineMask * u.scanline.y;
    color = color * dim;
  }

  color = color * u.color.w;
  var alpha = clamp(u.motion.z + (1.0 - u.motion.z) * u.motion.w, u.motion.z, 1.0);
  alpha = alpha * u.color.w;

  // Tear opacity modulation for groups 3+
  if (in.group > 2.5) {
    alpha = alpha * (0.5 + 0.5 * sin(u.canvas.w * 2.0 + in.group * 3.14159));
  }

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), clamp(alpha, 0.0, 1.0));
}
`;

const WEBGPU_POST_SHADER = /* wgsl */`
struct Globals {
  canvas: vec4f,      // W, H, dpr, timeSec
  face: vec4f,        // faceOX, faceOY, faceW, faceH
  gaze: vec4f,        // eyeGazeX, eyeGazeY, mouthGazeX, mouthGazeY
  shapeCenters: vec4f,// leftEyeCenterY, rightEyeCenterY, mouthCenterY, blinkF
  motion: vec4f,      // mouthScale, pixelSize, opacityMin, pulseMod
  color: vec4f,       // baseHue01, baseSat01, baseLight01, flicker
  scan: vec4f,        // scanY, scanHalfW, scanBrightness, scanGlow
  chroma: vec4f,      // offX, offY, intensity, enabled
  glitch: vec4f,      // inBurst, sliceCount, maxOffset, intensity
  glitch2: vec4f,     // gapChance, burstSeed, intervalSec, burstDurSec
  scanline: vec4f,    // enabled, intensity, spacing, scroll
  flags: vec4f        // sleeping, scanlineThicknessRatio, bloomIntensity, glowStrength
};

@group(0) @binding(0) var<uniform> u: Globals;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f
};

fn hash12(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn hue2rgb(p: f32, q: f32, tIn: f32) -> f32 {
  var t = tIn;
  if (t < 0.0) { t = t + 1.0; }
  if (t > 1.0) { t = t - 1.0; }
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}

fn hslToRgb(h: f32, s: f32, l: f32) -> vec3f {
  if (s <= 0.0001) {
    return vec3f(l, l, l);
  }
  var q = l * (1.0 + s);
  if (l >= 0.5) {
    q = l + s - l * s;
  }
  let p = 2.0 * l - q;
  return vec3f(
    hue2rgb(p, q, h + 1.0 / 3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0 / 3.0)
  );
}

fn sampleScene(uv: vec2f) -> vec4f {
  let suv = vec2f(uv.x, 1.0 - uv.y);
  return textureSampleLevel(sceneTex, sceneSampler, clamp(suv, vec2f(0.0), vec2f(1.0)), 0.0);
}

@vertex
fn vsPost(@builtin(vertex_index) vid: u32) -> VSOut {
  var pos = vec2f(-1.0, -1.0);
  var uv = vec2f(0.0, 0.0);
  switch (vid) {
    case 0u: {
      pos = vec2f(-1.0, -1.0);
      uv = vec2f(0.0, 0.0);
    }
    case 1u: {
      pos = vec2f(1.0, -1.0);
      uv = vec2f(1.0, 0.0);
    }
    case 2u: {
      pos = vec2f(-1.0, 1.0);
      uv = vec2f(0.0, 1.0);
    }
    case 3u: {
      pos = vec2f(-1.0, 1.0);
      uv = vec2f(0.0, 1.0);
    }
    case 4u: {
      pos = vec2f(1.0, -1.0);
      uv = vec2f(1.0, 0.0);
    }
    default: {
      pos = vec2f(1.0, 1.0);
      uv = vec2f(1.0, 1.0);
    }
  }

  var out: VSOut;
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fsPost(in: VSOut) -> @location(0) vec4f {
  var uv = in.uv;

  if (u.glitch.x > 0.5) {
    let sliceCount = max(1.0, u.glitch.y);
    let band = floor(uv.y * sliceCount);
    let gapNoise = hash12(vec2f(band, u.canvas.w * 0.77 + u.glitch2.y));
    if (gapNoise < u.glitch2.x) {
      return vec4f(0.0);
    }

    let offNoise = hash12(vec2f(band + 19.0, u.canvas.w * 1.73 + u.glitch2.y));
    let offPx = (offNoise - 0.5) * 2.0 * u.glitch.z * u.glitch.w;
    uv.x = uv.x + offPx / max(1.0, u.canvas.x);
  }

  let base = sampleScene(uv);
  var color = base.rgb;

  if (u.chroma.w > 0.5 && u.chroma.z > 0.0) {
    let offs = vec2f(
      u.chroma.x / max(1.0, u.canvas.x),
      u.chroma.y / max(1.0, u.canvas.y)
    );
    let r = sampleScene(uv + offs).r;
    let g = sampleScene(uv).g;
    let b = sampleScene(uv - offs).b;
    let ca = vec3f(r, g, b);
    color = mix(color, ca, clamp(u.chroma.z, 0.0, 1.0));
  }

  let px = vec2f(1.0 / max(1.0, u.canvas.x), 1.0 / max(1.0, u.canvas.y));
  let blur =
    sampleScene(uv + vec2f(px.x, 0.0)).rgb +
    sampleScene(uv - vec2f(px.x, 0.0)).rgb +
    sampleScene(uv + vec2f(0.0, px.y)).rgb +
    sampleScene(uv - vec2f(0.0, px.y)).rgb;
  let bloom = blur * 0.25;
  let bloomStrength = max(0.0, u.flags.z) * (0.12 + max(0.0, u.flags.w) * 0.18);
  color = color + bloom * bloomStrength;

  if (u.scan.y > 0.0) {
    let y = uv.y * u.canvas.y;
    let dist = abs(y - u.scan.x);
    let beam = 1.0 - clamp(dist / max(1.0, u.scan.y * 1.8), 0.0, 1.0);
    let beamCurve = beam * beam;
    let beamColor = hslToRgb(fract(u.color.x), 1.0, 0.5);
    color = color + beamColor * beamCurve * (u.scan.w / 95.0);
  }

  if (u.scanline.x > 0.5 && u.scanline.z > 0.0) {
    let phase = fract((uv.y * u.canvas.y + u.scanline.w) / max(1.0, u.scanline.z));
    let lineMask = 1.0 - step(u.flags.y, phase);
    color = color * (1.0 - lineMask * u.scanline.y);
  }

  color = color * u.color.w;
  let alpha = clamp(base.a * u.color.w, 0.0, 1.0);
  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), alpha);
}
`;

// ── Utility ───────────────────────────────

function normalizeRenderer(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (mode === 'webgpu' || mode === 'canvas2d' || mode === 'auto') return mode;
    return 'auto';
}

function mergeConfig(base, patch = {}) {
    const merged = structuredClone(base || {});
    for (const [key, value] of Object.entries(patch || {})) {
        if (
            value && typeof value === 'object' && !Array.isArray(value) &&
            merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])
        ) {
            merged[key] = { ...merged[key], ...value };
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

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
    let cx;
    let cy;
    if (px < left && py < top) { cx = left; cy = top; }
    else if (px > right && py < top) { cx = right; cy = top; }
    else if (px < left && py > bottom) { cx = left; cy = bottom; }
    else if (px > right && py > bottom) { cx = right; cy = bottom; }
    else return true;
    const dx = (px - cx) / rrx;
    const dy = (py - cy) / rry;
    return dx * dx + dy * dy <= 1;
}

function isInsideHeart(px, py, cx, cy, halfW, halfH) {
    const nx = (px - cx) / halfW;
    const ny = -(py - cy) / halfH; // flip Y so heart points up
    const x2 = nx * nx;
    const y2 = ny * ny;
    const t = x2 + y2 - 1;
    return t * t * t - x2 * y2 * ny < 0;
}

function isInsideArc(px, py, cx, cy, w, h, inverted) {
    const nx = (px - cx) / (w * 0.5);
    const rawNy = (py - cy) / (h * 0.5);
    const ny = inverted ? -rawNy : rawNy;
    // Ellipse center shifted up so only the bottom arc is visible
    const ey = -0.65;
    const dy = ny - ey;
    const d2 = nx * nx + dy * dy;
    const outerR2 = 1.35 * 1.35;
    const innerR2 = 0.8 * 0.8;
    return d2 <= outerR2 && d2 >= innerR2 && ny > ey;
}

function testShapeHit(px, py, tx, ty, sw, sh, srx, sry, hitTest) {
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

function clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

function setBackendStatus() {
    if (!backendStatusEl) return;
    if (!STATE.glitchFxEnabled) {
        backendStatusEl.textContent = 'off';
        return;
    }
    if (backendError) {
        backendStatusEl.textContent = 'fail';
        return;
    }
    if (!rendererReady) {
        backendStatusEl.textContent = 'init';
        return;
    }
    backendStatusEl.textContent = rendererKind;
}

function setGlitchVisualActive(active) {
    glitchVisualActive = Boolean(active);
    if (faceEl) {
        faceEl.classList.toggle('use-glitch-fx', glitchVisualActive);
    }
    if (canvas) {
        canvas.style.display = glitchVisualActive ? 'block' : 'none';
    }
}

function logGlitchDiag(reason, frame = null) {
    if (!GLITCH_DIAG) return;

    const now = performance.now();
    if (reason === 'frame' && now - diagLastLogAt < 1000) return;
    diagLastLogAt = now;
}

function updateEffectivePixelMetrics() {
    const refFaceWidth = Math.max(1, faceW || faceEl?.getBoundingClientRect?.().width || 1);
    const scale = Math.max(0.16, Math.min(1.0, refFaceWidth / 1400));
    effectivePixelSize = Math.max(2, config.pixel.size * scale);
    effectivePixelGap = Math.max(0, config.pixel.gap * scale);
}

function getFeatureGlobalScale() {
    const isMain = containerEl?.id === 'center';
    const boost = isMain ? FEATURE_BOX_MAIN_BOOST : 0;
    return {
        x: FEATURE_BOX_GLOBAL_SCALE_X + boost,
        y: FEATURE_BOX_GLOBAL_SCALE_Y + boost,
    };
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
    const shapes = base.map((s) => ({ ...s }));
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

    // Tear shapes for crying — thin vertical rects below each eye
    if (profile.tears) {
        for (let i = 0; i < 2; i++) {
            const eye = shapes[i];
            const tearW = eye.w * 0.15;
            const tearH = eye.h * 1.0;
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

function getShapesBounds(shapes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < shapes.length; i++) {
        const s = shapes[i];
        minX = Math.min(minX, s.x);
        minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x + s.w);
        maxY = Math.max(maxY, s.y + s.h);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return { x: 0, y: 0, w: 1, h: 1 };
    }

    return {
        x: minX,
        y: minY,
        w: Math.max(1, maxX - minX),
        h: Math.max(1, maxY - minY),
    };
}

function getFeatureTargetBounds(W, H) {
    if (!faceEl) {
        return { x: 0, y: 0, w: W, h: H };
    }

    const faceRect = faceEl.getBoundingClientRect();
    const parts = [
        faceEl.querySelector('.eye.left'),
        faceEl.querySelector('.eye.right'),
        faceEl.querySelector('#mouth'),
    ].filter(Boolean);

    if (parts.length === 0) {
        return { x: 0, y: 0, w: W, h: H };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < parts.length; i++) {
        const r = parts[i].getBoundingClientRect();
        const x0 = r.left - faceRect.left;
        const y0 = r.top - faceRect.top;
        const x1 = x0 + r.width;
        const y1 = y0 + r.height;
        minX = Math.min(minX, x0);
        minY = Math.min(minY, y0);
        maxX = Math.max(maxX, x1);
        maxY = Math.max(maxY, y1);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return { x: 0, y: 0, w: W, h: H };
    }

    const padX = Math.max(2, (maxX - minX) * 0.06);
    const padY = Math.max(2, (maxY - minY) * 0.08);
    const rawX = Math.max(0, minX - padX);
    const rawY = Math.max(0, minY - padY);
    const rawW = Math.max(1, Math.min(W - rawX, (maxX - minX) + padX * 2));
    const rawH = Math.max(1, Math.min(H - rawY, (maxY - minY) + padY * 2));

    const cx = rawX + rawW * 0.5;
    const cy = rawY + rawH * 0.5;
    const scaledW = Math.max(1, Math.min(W, rawW * FEATURE_BOX_GLOBAL_SCALE_X));
    const scaledH = Math.max(1, Math.min(H, rawH * FEATURE_BOX_GLOBAL_SCALE_Y));
    const x = Math.max(0, Math.min(W - scaledW, cx - scaledW * 0.5));
    const y = Math.max(0, Math.min(H - scaledH, cy - scaledH * 0.5));

    return { x, y, w: scaledW, h: scaledH };
}

function getBlinkFactor(now) {
    if (!blinkActive) return 0;
    const elapsed = now - blinkStartTime;
    if (elapsed >= BLINK_TOTAL_MS) {
        blinkActive = false;
        return 0;
    }
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

function recreateCanvasElement() {
    if (!canvas) return;
    const next = document.createElement('canvas');
    next.id = 'glitch-fx-canvas';
    next.style.display = canvas.style.display || 'none';
    if (canvas.parentElement) {
        canvas.parentElement.replaceChild(next, canvas);
    }
    canvas = next;
    ctx = null;
    tempCanvas = null;
    tempCtx = null;
    gpuContext = null;
}

function computeFacePosition() {
    if (!faceEl || !containerEl) return;
    const cr = containerEl.getBoundingClientRect();
    const fr = faceEl.getBoundingClientRect();
    // Subtract current parallax transform to get the base position
    const lookX = parseFloat(faceEl.style.getPropertyValue('--face-look-x')) || 0;
    const lookY = parseFloat(faceEl.style.getPropertyValue('--face-look-y')) || 0;
    baseFaceX = fr.left - cr.left - lookX;
    baseFaceY = fr.top - cr.top - lookY;
    faceW = fr.width;
    faceH = fr.height;
    updateEffectivePixelMetrics();
}

function sizeCanvas() {
    if (!containerEl || !canvas) return;
    const cr = containerEl.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    containerCssW = cr.width;
    containerCssH = cr.height;

    const dpr = window.devicePixelRatio || 1;
    cachedDpr = dpr;

    const pw = Math.round(cr.width * dpr);
    const ph = Math.round(cr.height * dpr);
    const sizeChanged = canvas.width !== pw || canvas.height !== ph;

    if (sizeChanged) {
        canvas.width = pw;
        canvas.height = ph;
    }

    cachedGlowFilter = `blur(${Math.round(config.glow.pixelGlow * dpr)}px)`;

    if (rendererKind === 'canvas2d' && ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (!tempCanvas) {
            tempCanvas = document.createElement('canvas');
            tempCtx = tempCanvas.getContext('2d');
            if (tempCtx) tempCtx.imageSmoothingEnabled = false;
        }
        if (tempCanvas) {
            tempCanvas.width = pw;
            tempCanvas.height = ph;
        }
        if (sizeChanged) {
            rebuildScanlinePattern();
        }
    }

    if (rendererKind === 'webgpu' && gpuContext && gpuDevice) {
        gpuContext.configure({
            device: gpuDevice,
            format: gpuFormat,
            alphaMode: 'premultiplied',
        });
        createGpuSceneTarget();
    }

    computeFacePosition();
    logGlitchDiag('sizeCanvas');
}

function rebuildScanlinePattern() {
    if (!ctx || !config.glitch.scanlines) {
        scanlinePattern = null;
        return;
    }
    const spacing = Math.max(1, Math.round(config.glitch.scanlineSpacing * cachedDpr));
    const thickness = Math.max(1, Math.round(config.glitch.scanlineThickness * cachedDpr));
    const pc = document.createElement('canvas');
    pc.width = 4;
    pc.height = spacing;
    const pctx = pc.getContext('2d');
    if (!pctx) {
        scanlinePattern = null;
        return;
    }
    pctx.fillStyle = '#000';
    pctx.fillRect(0, 0, 4, thickness);
    scanlinePattern = ctx.createPattern(pc, 'repeat');
}

// ── Pixel grid computation ────────────────
// Pixel positions are face-relative CSS coordinates.
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
    const expr = getActiveExpression();
    const profile = EXPRESSION_PROFILES[expr] || null;
    const vb = config.svg.viewBox;
    const fitScale = Math.min(W / vb.w, H / vb.h);
    const globalScale = getFeatureGlobalScale();
    const drawW = vb.w * fitScale * globalScale.x;
    const drawH = vb.h * fitScale * globalScale.y;
    const offsetX = (W - drawW) * 0.5;
    const offsetY = (H - drawH) * 0.5;
    const mapScaleX = drawW / vb.w;
    const mapScaleY = drawH / vb.h;
    const sz = effectivePixelSize;
    const gap = effectivePixelGap;
    const stride = sz + gap;
    const hueVar = config.color.hueVariation;
    const brightVar = config.color.brightnessVariation;

    for (let si = 0; si < shapes.length; si++) {
        const shape = shapes[si];
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

        // Determine hit-test type for this shape
        let hitTest = 'rect';
        if (profile) {
            if (si <= 1 && profile.eyeShape) hitTest = profile.eyeShape;
            if (si === 2 && profile.mouthShape) hitTest = profile.mouthShape;
        }

        // Color override for this shape
        let shapeOverrideHSL = null;
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

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const px = gridOffX + c * stride;
                const py = gridOffY + r * stride;
                const cx = px + sz / 2;
                const cy = py + sz / 2;
                if (!testShapeHit(cx, cy, tx, ty, sw, sh, srx, sry, hitTest)) continue;

                // Eye skew for angry brows: shift Y based on X position
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
                    lut: getColorLUT(baseH + hOff, baseS),
                    overrideHSL: shapeOverrideHSL,
                });
                shapeGroups.push(si);
            }
        }
    }

    let minPX = Infinity;
    let minPY = Infinity;
    let maxPX = -Infinity;
    let maxPY = -Infinity;
    for (let i = 0; i < pixelGrid.length; i++) {
        const p = pixelGrid[i];
        minPX = Math.min(minPX, p.x);
        minPY = Math.min(minPY, p.y);
        maxPX = Math.max(maxPX, p.x + sz);
        maxPY = Math.max(maxPY, p.y + sz);
    }
    if (!Number.isFinite(minPX)) {
        minPX = 0; minPY = 0; maxPX = 0; maxPY = 0;
    }
    lastGridDebug = {
        faceW: W,
        faceH: H,
        drawW,
        drawH,
        offsetX,
        offsetY,
        mapScaleX,
        mapScaleY,
        pixelSize: sz,
        pixelGap: gap,
        minPX,
        minPY,
        maxPX,
        maxPY,
    };

    lastBuiltExpression = getActiveExpression();
    lastSleepingState = STATE.sleeping;

    if (rendererKind === 'webgpu') {
        updateGpuInstanceBuffer();
    }

    logGlitchDiag('grid');
}

function recolorPixelGrid() {
    colorLUTs.clear();
    for (let i = 0; i < pixelGrid.length; i++) {
        const p = pixelGrid[i];
        const base = p.overrideHSL || baseHSL;
        p.lut = getColorLUT(base.h + p.hueOff, base.s);
    }
}

// ── WebGPU backend ────────────────────────

function resetWebGpuResources() {
    if (gpuSceneTexture) {
        try { gpuSceneTexture.destroy(); } catch { }
    }
    if (gpuInstanceBuffer) {
        try { gpuInstanceBuffer.destroy(); } catch { }
    }
    if (gpuUniformBuffer) {
        try { gpuUniformBuffer.destroy(); } catch { }
    }
    if (gpuPostUniformBuffer) {
        try { gpuPostUniformBuffer.destroy(); } catch { }
    }
    gpuContext = null;
    gpuDevice = null;
    gpuPixelPipeline = null;
    gpuPostPipeline = null;
    gpuUniformBuffer = null;
    gpuPostUniformBuffer = null;
    gpuInstanceBuffer = null;
    gpuPixelBindGroup = null;
    gpuPostBindGroup = null;
    gpuSampler = null;
    gpuSceneTexture = null;
    gpuSceneTextureView = null;
    gpuSceneWidth = 0;
    gpuSceneHeight = 0;
    gpuInstanceCount = 0;
}

function updateGpuPixelBindGroup() {
    if (!gpuDevice || !gpuPixelPipeline || !gpuUniformBuffer || !gpuInstanceBuffer) return;
    gpuPixelBindGroup = gpuDevice.createBindGroup({
        layout: gpuPixelPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: gpuUniformBuffer } },
            { binding: 1, resource: { buffer: gpuInstanceBuffer } },
        ],
    });
}

function updateGpuPostBindGroup() {
    if (!gpuDevice || !gpuPostPipeline || !gpuPostUniformBuffer || !gpuSampler || !gpuSceneTextureView) return;
    gpuPostBindGroup = gpuDevice.createBindGroup({
        layout: gpuPostPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: gpuPostUniformBuffer } },
            { binding: 1, resource: gpuSampler },
            { binding: 2, resource: gpuSceneTextureView },
        ],
    });
}

function createGpuSceneTarget() {
    if (!gpuDevice || !canvas?.width || !canvas?.height) return;
    if (gpuSceneTexture && gpuSceneWidth === canvas.width && gpuSceneHeight === canvas.height) return;

    if (gpuSceneTexture) {
        try { gpuSceneTexture.destroy(); } catch { }
    }

    gpuSceneTexture = gpuDevice.createTexture({
        size: { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
        format: gpuSceneFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    gpuSceneTextureView = gpuSceneTexture.createView();
    gpuSceneWidth = canvas.width;
    gpuSceneHeight = canvas.height;
    updateGpuPostBindGroup();
}

function updateGpuInstanceBuffer() {
    if (!gpuDevice) return;

    const instanceCount = pixelGrid.length;
    const minFloats = 8;
    const floatCount = Math.max(minFloats, instanceCount * 8);
    const packed = new Float32Array(floatCount);

    for (let i = 0; i < instanceCount; i++) {
        const p = pixelGrid[i];
        const off = i * 8;
        packed[off + 0] = p.x;
        packed[off + 1] = p.y;
        packed[off + 2] = p.hueOff;
        packed[off + 3] = p.brightOff;
        packed[off + 4] = shapeGroups[i] || 0;
        const ovr = p.overrideHSL;
        packed[off + 5] = ovr ? 1 : 0;
        packed[off + 6] = ovr ? ((ovr.h % 360 + 360) % 360 / 360) : 0;
        packed[off + 7] = ovr ? (ovr.s / 100) : 0;
    }

    if (gpuInstanceBuffer) {
        try { gpuInstanceBuffer.destroy(); } catch { }
    }

    gpuInstanceBuffer = gpuDevice.createBuffer({
        size: packed.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    gpuDevice.queue.writeBuffer(gpuInstanceBuffer, 0, packed.buffer, packed.byteOffset, packed.byteLength);
    gpuInstanceCount = instanceCount;
    updateGpuPixelBindGroup();
}

async function createShaderModuleChecked(device, code, label = 'shader') {
    const module = device.createShaderModule({ code, label });
    if (typeof module.getCompilationInfo !== 'function') {
        return module;
    }

    const info = await module.getCompilationInfo();
    if (!info?.messages?.length) {
        return module;
    }

    const errors = info.messages.filter((m) => m.type === 'error');
    if (!errors.length) {
        return module;
    }

    const first = errors[0];
    throw new Error(`${label} WGSL error (${first.lineNum}:${first.linePos}) ${first.message}`);
}

async function initWebGpuRenderer() {
    if (!canvas || !navigator.gpu) return false;

    try {
        const context = canvas.getContext('webgpu');
        if (!context) return false;

        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return false;

        const device = await adapter.requestDevice();
        const format = navigator.gpu.getPreferredCanvasFormat
            ? navigator.gpu.getPreferredCanvasFormat()
            : 'bgra8unorm';

        const pixelShaderModule = await createShaderModuleChecked(device, WEBGPU_SHADER, 'glitch-pixel');
        const postShaderModule = await createShaderModuleChecked(device, WEBGPU_POST_SHADER, 'glitch-post');

        const pixelPipelineDescriptor = {
            layout: 'auto',
            vertex: {
                module: pixelShaderModule,
                entryPoint: 'vsMain',
            },
            fragment: {
                module: pixelShaderModule,
                entryPoint: 'fsMain',
                targets: [{
                    format: gpuSceneFormat,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            multisample: { count: 1 },
        };
        const pixelPipeline = typeof device.createRenderPipelineAsync === 'function'
            ? await device.createRenderPipelineAsync(pixelPipelineDescriptor)
            : device.createRenderPipeline(pixelPipelineDescriptor);

        const postPipelineDescriptor = {
            layout: 'auto',
            vertex: {
                module: postShaderModule,
                entryPoint: 'vsPost',
            },
            fragment: {
                module: postShaderModule,
                entryPoint: 'fsPost',
                targets: [{
                    format,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
            },
            multisample: { count: 1 },
        };
        const postPipeline = typeof device.createRenderPipelineAsync === 'function'
            ? await device.createRenderPipelineAsync(postPipelineDescriptor)
            : device.createRenderPipeline(postPipelineDescriptor);

        const uniformBuffer = device.createBuffer({
            size: GPU_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const postUniformBuffer = device.createBuffer({
            size: GPU_UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const placeholder = new Float32Array(8);
        const instanceBuffer = device.createBuffer({
            size: placeholder.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(instanceBuffer, 0, placeholder.buffer, placeholder.byteOffset, placeholder.byteLength);
        const sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        gpuContext = context;
        gpuDevice = device;
        gpuPixelPipeline = pixelPipeline;
        gpuPostPipeline = postPipeline;
        gpuUniformBuffer = uniformBuffer;
        gpuPostUniformBuffer = postUniformBuffer;
        gpuInstanceBuffer = instanceBuffer;
        gpuSampler = sampler;
        gpuInstanceCount = 0;
        gpuFormat = format;

        updateGpuPixelBindGroup();
        createGpuSceneTarget();
        updateGpuPostBindGroup();

        device.lost.then((info) => {
            console.warn('[GlitchFX] WebGPU device lost:', info?.message || info);
        }).catch(() => { });

        return true;
    } catch (err) {
        console.warn('[GlitchFX] WebGPU init failed, falling back to Canvas2D:', err);
        resetWebGpuResources();
        return false;
    }
}

function initCanvas2DRenderer() {
    if (!canvas) return false;

    ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
        || canvas.getContext('2d');
    if (!ctx) return false;

    ctx.imageSmoothingEnabled = false;

    tempCanvas = document.createElement('canvas');
    tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) tempCtx.imageSmoothingEnabled = false;

    rebuildScanlinePattern();
    return true;
}

function fallbackToCanvas2D(reason = 'fallback') {
    console.warn(`[GlitchFX] Switching to Canvas2D (${reason})`);
    resetWebGpuResources();
    rendererKind = 'canvas2d';
    rendererReady = false;
    backendError = '';

    if (!initCanvas2DRenderer()) {
        backendError = 'no-renderer';
        rendererReady = false;
        setBackendStatus();
        return false;
    }

    rendererReady = true;
    sizeCanvas();
    buildPixelGrid();
    setBackendStatus();
    return true;
}

async function initializeRendererBackend() {
    rendererReady = false;
    backendError = '';
    setBackendStatus();

    const preferred = normalizeRenderer(config.renderer);
    const shouldTryWebGpu = preferred === 'auto' || preferred === 'webgpu';

    if (shouldTryWebGpu) {
        const ok = await initWebGpuRenderer();
        if (ok) {
            rendererKind = 'webgpu';
            rendererReady = true;
            sizeCanvas();
            buildPixelGrid();
            setBackendStatus();
            return;
        }

        // If context mode got locked by a failed WebGPU attempt, swap canvas.
        recreateCanvasElement();
    }

    resetWebGpuResources();

    if (!initCanvas2DRenderer()) {
        console.error('[GlitchFX] Unable to initialize any renderer backend.');
        rendererKind = 'canvas2d';
        rendererReady = false;
        backendError = 'no-renderer';
        setGlitchVisualActive(false);
        setBackendStatus();
        return;
    }

    rendererKind = 'canvas2d';
    rendererReady = true;
    sizeCanvas();
    buildPixelGrid();
    setBackendStatus();
}

function ensureRendererBackendReady() {
    if (rendererReady) return Promise.resolve(true);
    if (!rendererInitPromise) {
        rendererInitPromise = initializeRendererBackend().then(() => rendererReady).catch((err) => {
            console.error('[GlitchFX] Renderer init error:', err);
            rendererReady = false;
            backendError = 'init-error';
            setBackendStatus();
            return false;
        });
    }
    return rendererInitPromise;
}

// ── Frame state ───────────────────────────

function computeFrameState(now) {
    const t = (now - startTime) / 1000;
    const dpr = cachedDpr;
    const pw = canvas.width;
    const ph = canvas.height;
    const W = containerCssW || (pw / dpr);
    const H = containerCssH || (ph / dpr);

    const sz = effectivePixelSize;

    const faceLookX = parseFloat(faceEl?.style.getPropertyValue('--face-look-x')) || 0;
    const faceLookY = parseFloat(faceEl?.style.getPropertyValue('--face-look-y')) || 0;
    const faceOX = baseFaceX + faceLookX;
    const faceOY = baseFaceY + faceLookY;

    const eyeGazeX = currentGazeX * faceW * GAZE_EYE_RANGE_X;
    const eyeGazeY = currentGazeY * faceH * GAZE_EYE_RANGE_Y;
    const mouthGazeX = currentGazeX * faceW * GAZE_MOUTH_RANGE_X;
    const mouthGazeY = currentGazeY * faceH * GAZE_MOUTH_RANGE_Y;

    const blinkF = getBlinkFactor(now);
    const mouthScale = getSpeakMouthScale(now);

    const bp = config.brightnessPulse;
    const pulseMod = bp.enabled
        ? bp.dim + (bp.bright - bp.dim) * Math.pow(0.5 + 0.5 * Math.sin(t * bp.speed * 0.3), 6)
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

    if (inBurst && !lastBurstState) {
        glitchBurstSeed = Math.random() * 1000;
    }
    lastBurstState = inBurst;

    const fl = config.glitch;
    const flickerMod = fl.flicker
        ? 1 - fl.flickerDepth * (0.5 + 0.5 * Math.sin(t * fl.flickerSpeed * 2))
        : 1;

    return {
        t,
        dpr,
        pw,
        ph,
        W,
        H,
        sz,
        faceOX,
        faceOY,
        eyeGazeX,
        eyeGazeY,
        mouthGazeX,
        mouthGazeY,
        blinkF,
        mouthScale,
        pulseMod,
        scanY,
        sbHalfW,
        chrOffX,
        chrOffY,
        inBurst,
        flickerMod,
    };
}

function writeGpuUniforms(frame) {
    if (!gpuDevice || !gpuUniformBuffer || !gpuPostUniformBuffer) return;

    const sb = config.scanBeam;
    const chr = config.chromatic;
    const gs = config.glitchSlice;
    const fl = config.glitch;

    const spacing = Math.max(1, fl.scanlineSpacing);
    const scanlineScroll = fl.scanlineMove ? (frame.t * fl.scanlineSpeed) % spacing : 0;
    const scanlineThicknessRatio = Math.min(0.95, Math.max(0.02, fl.scanlineThickness / spacing));
    const bloomIntensity = Math.max(0, config.glow.bloomIntensity);
    const glowStrength = Math.max(0, config.glow.pixelGlow / 24);

    gpuUniformData.fill(0);
    gpuPostUniformData.fill(0);

    const uniforms = [gpuUniformData, gpuPostUniformData];
    for (let i = 0; i < uniforms.length; i++) {
        const u = uniforms[i];

        // canvas
        u[0] = frame.W;
        u[1] = frame.H;
        u[2] = frame.dpr;
        u[3] = frame.t;

        // face
        u[4] = frame.faceOX;
        u[5] = frame.faceOY;
        u[6] = faceW;
        u[7] = faceH;

        // gaze
        u[8] = frame.eyeGazeX;
        u[9] = frame.eyeGazeY;
        u[10] = frame.mouthGazeX;
        u[11] = frame.mouthGazeY;

        // shape centers + blink
        u[12] = shapeCenters[0]?.cy || 0;
        u[13] = shapeCenters[1]?.cy || 0;
        u[14] = shapeCenters[2]?.cy || 0;
        u[15] = frame.blinkF;

        // motion
        u[16] = frame.mouthScale;
        u[17] = frame.sz;
        u[18] = config.color.opacityMin;
        u[19] = frame.pulseMod;

        // color (HSL normalized)
        u[20] = ((baseHSL.h % 360) + 360) % 360 / 360;
        u[21] = clamp01(baseHSL.s / 100);
        u[22] = clamp01(baseHSL.l / 100);
        u[23] = frame.flickerMod;

        // scan beam
        u[24] = frame.scanY;
        u[25] = frame.sbHalfW;
        u[26] = sb.brightness;
        u[27] = sb.glowStrength;

        // chroma
        u[28] = frame.chrOffX;
        u[29] = frame.chrOffY;
        u[30] = chr.intensity;
        u[31] = chr.enabled ? 1 : 0;

        // glitch
        u[32] = frame.inBurst ? 1 : 0;
        u[33] = gs.sliceCount;
        u[34] = gs.maxOffset;
        u[35] = gs.intensity;

        // glitch2
        u[36] = gs.gapChance;
        u[37] = glitchBurstSeed;
        u[38] = gs.interval / 1000;
        u[39] = gs.burstDuration / 1000;

        // scanline
        u[40] = fl.scanlines ? 1 : 0;
        u[41] = fl.scanlineIntensity;
        u[42] = spacing;
        u[43] = scanlineScroll;

        // flags
        u[44] = STATE.sleeping ? 1 : 0;
        u[45] = scanlineThicknessRatio;
        u[46] = bloomIntensity;
        u[47] = glowStrength;
    }

    // Pixel pass keeps the face draw simple; post pass does the heavy FX.
    gpuUniformData[23] = 1;
    gpuUniformData[31] = 0;
    gpuUniformData[32] = 0;
    gpuUniformData[40] = 0;

    gpuDevice.queue.writeBuffer(
        gpuUniformBuffer,
        0,
        gpuUniformData.buffer,
        gpuUniformData.byteOffset,
        GPU_UNIFORM_FLOATS * 4,
    );
    gpuDevice.queue.writeBuffer(
        gpuPostUniformBuffer,
        0,
        gpuPostUniformData.buffer,
        gpuPostUniformData.byteOffset,
        GPU_UNIFORM_FLOATS * 4,
    );
}

function renderFrameWebGpu(frame) {
    if (
        !gpuDevice || !gpuContext ||
        !gpuPixelPipeline || !gpuPostPipeline ||
        !gpuPixelBindGroup || !gpuPostBindGroup ||
        !gpuSceneTextureView ||
        gpuInstanceCount <= 0
    ) return false;

    writeGpuUniforms(frame);

    let texture;
    try {
        texture = gpuContext.getCurrentTexture();
    } catch (err) {
        console.warn('[GlitchFX] WebGPU frame acquire failed:', err);
        return false;
    }

    try {
        const encoder = gpuDevice.createCommandEncoder();

        const scenePass = encoder.beginRenderPass({
            colorAttachments: [{
                view: gpuSceneTextureView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
            }],
        });
        scenePass.setPipeline(gpuPixelPipeline);
        scenePass.setBindGroup(0, gpuPixelBindGroup);
        scenePass.draw(6, gpuInstanceCount, 0, 0);
        scenePass.end();

        const swapPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: texture.createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
            }],
        });

        swapPass.setPipeline(gpuPostPipeline);
        swapPass.setBindGroup(0, gpuPostBindGroup);
        swapPass.draw(6, 1, 0, 0);
        swapPass.end();

        gpuDevice.queue.submit([encoder.finish()]);
        return true;
    } catch (err) {
        console.warn('[GlitchFX] WebGPU frame render failed:', err);
        return false;
    }
}

// ── Canvas 2D backend ─────────────────────

function renderFrameCanvas2D(frame) {
    if (!ctx || !tempCtx || !tempCanvas) return false;

    const {
        t,
        dpr,
        pw,
        ph,
        W,
        H,
        sz,
        faceOX,
        faceOY,
        eyeGazeX,
        eyeGazeY,
        mouthGazeX,
        mouthGazeY,
        blinkF,
        mouthScale,
        pulseMod,
        scanY,
        sbHalfW,
        chrOffX,
        chrOffY,
        inBurst,
        flickerMod,
    } = frame;

    const sb = config.scanBeam;
    const chr = config.chromatic;
    const gs = config.glitchSlice;
    const fl = config.glitch;

    // Pass 1: sharp pixels
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

        // Tear decorators (groups 3+): follow eye gaze, animated flow
        if (group >= 3) {
            drawX += eyeGazeX;
            drawY += eyeGazeY;
            drawY += Math.sin(t * 1.5 + p.y * 0.05) * sz * 0.3;
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
        if (group >= 3) {
            ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 2 + (group - 3) * Math.PI);
        }
        ctx.fillStyle = p.lut[li];
        ctx.fillRect(drawX, drawY, sz, drawSzY);
        if (group >= 3) {
            ctx.globalAlpha = 1;
        }
    }

    // Pass 2: glow bloom
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

    // Pass 3: chromatic aberration
    if (chr.enabled && chr.intensity > 0) {
        ctx.filter = 'hue-rotate(40deg)';
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = chr.intensity * 0.35 * flickerMod;
        ctx.drawImage(tempCanvas, Math.round(chrOffX * dpr), Math.round(chrOffY * dpr));
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
    }

    // Pass 4: glitch slice
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

    // Pass 5: scan beam glow overlay
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

    // Pass 6: scanlines
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

    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
}

// ── Render loop ───────────────────────────

function renderFrame(now) {
    if (!STATE.glitchFxEnabled) {
        animFrameId = null;
        setGlitchVisualActive(false);
        setBackendStatus();
        return;
    }

    animFrameId = requestAnimationFrame(renderFrame);

    if (!rendererReady || !canvas) {
        setGlitchVisualActive(false);
        return;
    }

    const dprNow = window.devicePixelRatio || 1;
    if (Math.abs(dprNow - cachedDpr) > 0.001) {
        sizeCanvas();
        buildPixelGrid();
    }

    // Detect expression/sleep changes → rebuild grid
    const currentExpr = getActiveExpression();
    if (currentExpr !== lastBuiltExpression || STATE.sleeping !== lastSleepingState) {
        buildPixelGrid();
    }

    // Smooth gaze interpolation
    currentGazeX += (gazeTargetX - currentGazeX) * GAZE_LERP;
    currentGazeY += (gazeTargetY - currentGazeY) * GAZE_LERP;

    computeFacePosition();

    const frame = computeFrameState(now);
    if (!frame.pw || !frame.ph) {
        setGlitchVisualActive(false);
        return;
    }

    if (pixelGrid.length === 0) {
        buildPixelGrid();
        if (pixelGrid.length === 0) {
            setGlitchVisualActive(false);
            return;
        }
    }

    let drawn = false;
    if (rendererKind === 'webgpu') {
        drawn = renderFrameWebGpu(frame);
        if (!drawn) {
            const fallbackOk = fallbackToCanvas2D('webgpu-frame-failed');
            if (fallbackOk) {
                drawn = renderFrameCanvas2D(frame);
            }
        }
    } else {
        drawn = renderFrameCanvas2D(frame);
    }

    setGlitchVisualActive(drawn);
    logGlitchDiag('frame', frame);
}

function startRenderLoop() {
    if (!STATE.glitchFxEnabled || animFrameId || !rendererReady) return;
    computeFacePosition();
    sizeCanvas();
    buildPixelGrid();
    setGlitchVisualActive(false);
    startTime = performance.now();
    animFrameId = requestAnimationFrame(renderFrame);
}

// ── Public API ────────────────────────────

export function enableGlitchFx() {
    STATE.glitchFxEnabled = true;
    setBackendStatus();

    if (rendererReady) {
        startRenderLoop();
        return;
    }

    void ensureRendererBackendReady().then((ok) => {
        if (!STATE.glitchFxEnabled) return;
        if (!ok) {
            setGlitchVisualActive(false);
            return;
        }
        startRenderLoop();
    });
}

export function disableGlitchFx() {
    STATE.glitchFxEnabled = false;
    setGlitchVisualActive(false);
    setBackendStatus();

    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }

    if (rendererKind === 'canvas2d' && canvas && ctx) {
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
    const prevRenderer = normalizeRenderer(config.renderer);

    const withDefaults = mergeConfig(DEFAULT_CONFIG, config);
    config = mergeConfig(withDefaults, newConfig);

    applyDerivedColors(config.color.base);

    const nextRenderer = normalizeRenderer(config.renderer);
    if (nextRenderer !== prevRenderer) {
        rendererReady = false;
        rendererInitPromise = null;
        setBackendStatus();
        void ensureRendererBackendReady().then((ok) => {
            if (!STATE.glitchFxEnabled) return;
            if (!ok) {
                setGlitchVisualActive(false);
                return;
            }
            startRenderLoop();
        });
        return;
    }

    if (STATE.glitchFxEnabled && rendererReady) {
        sizeCanvas();
        buildPixelGrid();
    }
}

export function initGlitchFx() {
    config = structuredClone(DEFAULT_CONFIG);
    faceEl = document.getElementById('face');

    // Find viewport-filling container to host the canvas
    containerEl = document.getElementById('center')
        || document.getElementById('mini-root')
        || (faceEl && faceEl.parentElement);

    canvas = document.createElement('canvas');
    canvas.id = 'glitch-fx-canvas';
    canvas.style.display = 'none';
    backendStatusEl = document.getElementById('glitch-fx-backend');
    setBackendStatus();

    if (containerEl) {
        // Insert at start so effect can span the full viewport container.
        containerEl.insertBefore(canvas, containerEl.firstChild);
    }

    applyDerivedColors(config.color.base);

    // Wire toggle (with persistence)
    const toggle = document.getElementById('glitch-fx-toggle');
    if (toggle) {
        toggle.checked = Boolean(STATE.glitchFxEnabled);
        toggle.addEventListener('change', () => {
            if (toggle.checked) enableGlitchFx();
            else disableGlitchFx();
            fetch('/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ glitchFxEnabled: toggle.checked }),
            }).catch(() => { });
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
        resizeObserver = new ResizeObserver(() => {
            if (!STATE.glitchFxEnabled) return;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                computeFacePosition();
                sizeCanvas();
                buildPixelGrid();
            }, 80);
        });
        resizeObserver.observe(resizeTarget);
    }

    startTime = performance.now();

    // Initialize renderer backend, then respect current state
    rendererInitPromise = ensureRendererBackendReady();

    if (STATE.glitchFxEnabled) {
        enableGlitchFx();
    }
}
