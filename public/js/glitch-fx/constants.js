export const DEFAULT_CONFIG = {
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

export const EXPRESSION_PROFILES = {
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

export const BLINK_CLOSE_MS = 80;
export const BLINK_HOLD_MS = 60;
export const BLINK_OPEN_MS = 80;
export const BLINK_TOTAL_MS = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS;

export const SPEAK_CYCLE_MS = 320;
export const SPEAK_MIN_SCALE = 0.75;
export const SPEAK_MAX_SCALE = 1.05;

export const GAZE_EYE_RANGE_X = 0.14;
export const GAZE_EYE_RANGE_Y = 0.09;
export const GAZE_MOUTH_RANGE_X = 0.06;
export const GAZE_MOUTH_RANGE_Y = 0.04;
export const GAZE_LERP = 0.12;

export const GLOW_ALPHA = 0.65;
export const FEATURE_BOX_GLOBAL_SCALE_X = 0.92;
export const FEATURE_BOX_GLOBAL_SCALE_Y = 0.92;
export const FEATURE_MOUTH_SCALE_X = 0.92;
export const FEATURE_MOUTH_SCALE_Y = 0.9;
export const FEATURE_BOX_MAIN_BOOST = 0.03;
export const GLITCH_DIAG = true;

export const GPU_UNIFORM_FLOATS = 64; // 16-byte aligned blocks
