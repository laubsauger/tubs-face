import { STATE } from './state.js';
import { face } from './dom.js';
import { buildFallbackFaceShapeLibrary, loadNormalizedFaceShapes } from './svg-shape-normalizer.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VALID_RENDER_MODES = new Set(['css', 'svg']);
const MODE_STORAGE_KEY = 'tubs.faceRenderMode';

const TALK_SEQUENCE = Object.freeze(['talk1', 'talk2', 'talk3', 'talk2']);
const SHAPE_KEY_BY_EXPRESSION = Object.freeze({
    idle: 'neutral',
    'idle-flat': 'neutral',
    listening: 'talk1',
    speaking: 'talk2',
    smile: 'smile',
    happy: 'happy',
    sad: 'sad',
    crying: 'crying',
    love: 'love',
    thinking: 'thinking',
    sleep: 'sleep',
    angry: 'angry',
    surprised: 'surprised',
});

const MOTION_PROFILE = Object.freeze({
    expression: { duration: 0.24, ease: 'sine.inOut' },
    speaking: {
        enterDuration: 0.1,
        frameDuration: 0.11,
        intervalMs: 120,
        ease: 'sine.inOut',
    },
});

const PARALLAX_PROFILE = Object.freeze({
    eyeXMult: 0.44,
    eyeYMult: 0.4,
    mouthXMult: 0.22,
    mouthYMult: 0.2,
    eyeXMax: 2.8,
    eyeYMax: 1.7,
    mouthXMax: 1.6,
    mouthYMax: 1.0,
});

const gazeCss = {
    eyeX: 0,
    eyeY: 0,
    mouthX: 0,
    mouthY: 0,
};

let initialized = false;
let syncingSelect = false;
let currentExpression = 'idle';
let activeRenderer = 'css';
let speakingTimer = null;
let speakingIndex = 0;
let blinkTimer = null;

const NO_BLINK_EXPRESSIONS = new Set(['sleep', 'love']);

let shapeLibrary = null;
let shapeLoadDegraded = false;

let svgLayerEl = null;
let eyeGazeGroup = null;
let mouthGazeGroup = null;
let decorGroup = null;
let leftEyePathEl = null;
let rightEyePathEl = null;
let mouthPathEl = null;
let modeSelectEl = null;
let modeStatusEl = null;

const decorEls = [];
const MAX_DECOR_PATHS = 6;

const featureState = {
    leftEye: null,
    rightEye: null,
    mouth: null,
};

function normalizeMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    return VALID_RENDER_MODES.has(normalized) ? normalized : 'svg';
}

function getGsap() {
    const api = globalThis.gsap;
    if (!api || typeof api.to !== 'function') return null;
    return api;
}

function readStoredMode() {
    try {
        return localStorage.getItem(MODE_STORAGE_KEY);
    } catch {
        return null;
    }
}

function writeStoredMode(mode) {
    try {
        localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
        // no-op
    }
}

function resolveInitialMode() {
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('faceRenderMode');
    if (fromQuery) return normalizeMode(fromQuery);

    const fromState = normalizeMode(STATE.faceRenderMode);
    if (VALID_RENDER_MODES.has(fromState)) return fromState;

    const fromStorage = readStoredMode();
    if (fromStorage) return normalizeMode(fromStorage);

    return 'svg';
}

function createSvgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, String(value));
    }
    return el;
}

function toFixed(value) {
    return Number(value).toFixed(2);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function clonePoints(points) {
    return points.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
}

function cloneFeature(feature) {
    return {
        points: clonePoints(feature.points || []),
        closed: Boolean(feature.closed),
        fill: feature.fill || 'none',
        stroke: feature.stroke || 'none',
        strokeWidth: Number(feature.strokeWidth) || 0,
        linecap: feature.linecap || 'round',
        linejoin: feature.linejoin || 'round',
        opacity: Number.isFinite(Number(feature.opacity)) ? Number(feature.opacity) : 1,
        className: feature.className || '',
    };
}

function pointsToPath(points, closed = false) {
    if (!Array.isArray(points) || points.length === 0) return '';

    let d = `M ${toFixed(points[0].x)} ${toFixed(points[0].y)}`;
    for (let i = 1; i < points.length; i += 1) {
        d += ` L ${toFixed(points[i].x)} ${toFixed(points[i].y)}`;
    }
    if (closed) d += ' Z';
    return d;
}

function applyFeatureStyle(el, feature) {
    const fill = feature.fill && feature.fill !== 'transparent' ? feature.fill : 'none';
    const stroke = feature.stroke && feature.stroke !== 'transparent' ? feature.stroke : 'none';
    const strokeWidth = stroke !== 'none' ? Math.max(0, Number(feature.strokeWidth) || 0) : 0;

    el.setAttribute('fill', fill);
    el.setAttribute('stroke', stroke);
    el.setAttribute('stroke-width', toFixed(strokeWidth));
    el.setAttribute('stroke-linecap', feature.linecap || 'round');
    el.setAttribute('stroke-linejoin', feature.linejoin || 'round');
    el.setAttribute('opacity', toFixed(Number.isFinite(feature.opacity) ? feature.opacity : 1));
}

function renderFeatureToElement(el, feature) {
    if (!el || !feature) return;
    el.setAttribute('d', pointsToPath(feature.points, feature.closed));
    applyFeatureStyle(el, feature);
}

function renderMainFeatures() {
    if (featureState.leftEye) renderFeatureToElement(leftEyePathEl, featureState.leftEye);
    if (featureState.rightEye) renderFeatureToElement(rightEyePathEl, featureState.rightEye);
    if (featureState.mouth) renderFeatureToElement(mouthPathEl, featureState.mouth);
}

function getProfileByShapeKey(shapeKey) {
    const profiles = shapeLibrary?.profilesByKey || {};
    return profiles[shapeKey] || profiles.neutral || null;
}

function expressionToShapeKey(expression) {
    const normalized = String(expression || 'idle').trim().toLowerCase();
    return SHAPE_KEY_BY_EXPRESSION[normalized] || 'neutral';
}

function resolveExpressionKey() {
    if (document.body.classList.contains('sleeping')) return 'sleep';
    if (currentExpression === 'idle' && face.classList.contains('idle-flat')) return 'idle-flat';
    return currentExpression;
}

function ensureFeatureState(part, targetFeature) {
    if (!featureState[part]) {
        featureState[part] = cloneFeature(targetFeature);
        return;
    }

    const state = featureState[part];
    if (!Array.isArray(state.points) || state.points.length !== targetFeature.points.length) {
        state.points = clonePoints(targetFeature.points);
    }
}

function morphFeature(part, targetFeature, duration, ease) {
    if (!targetFeature) return;

    ensureFeatureState(part, targetFeature);
    const state = featureState[part];

    const fromPoints = clonePoints(state.points);
    const toPoints = targetFeature.points;

    state.closed = targetFeature.closed;
    state.fill = targetFeature.fill;
    state.stroke = targetFeature.stroke;
    state.linecap = targetFeature.linecap;
    state.linejoin = targetFeature.linejoin;

    const gsap = getGsap();
    if (!gsap || duration <= 0) {
        state.points = clonePoints(toPoints);
        state.strokeWidth = Number(targetFeature.strokeWidth) || 0;
        state.opacity = Number.isFinite(Number(targetFeature.opacity)) ? Number(targetFeature.opacity) : 1;
        renderMainFeatures();
        return;
    }

    if (state.tween) {
        state.tween.kill();
        state.tween = null;
    }

    const driver = {
        t: 0,
        strokeWidth: Number(state.strokeWidth) || 0,
        opacity: Number.isFinite(Number(state.opacity)) ? Number(state.opacity) : 1,
    };

    state.tween = gsap.to(driver, {
        t: 1,
        strokeWidth: Number(targetFeature.strokeWidth) || 0,
        opacity: Number.isFinite(Number(targetFeature.opacity)) ? Number(targetFeature.opacity) : 1,
        duration,
        ease,
        overwrite: true,
        onUpdate: () => {
            for (let i = 0; i < state.points.length; i += 1) {
                state.points[i].x = fromPoints[i].x + (toPoints[i].x - fromPoints[i].x) * driver.t;
                state.points[i].y = fromPoints[i].y + (toPoints[i].y - fromPoints[i].y) * driver.t;
            }
            state.strokeWidth = driver.strokeWidth;
            state.opacity = driver.opacity;
            renderMainFeatures();
        },
        onComplete: () => {
            state.tween = null;
        },
    });
}

function setMouthWaveActive(enabled) {
    if (!mouthPathEl) return;
    mouthPathEl.classList.toggle('wave-active', Boolean(enabled));
}

function applyDecor(decorFeatures = [], duration = 0, ease = 'sine.inOut') {
    const gsap = getGsap();

    for (let i = 0; i < MAX_DECOR_PATHS; i += 1) {
        const el = decorEls[i];
        if (!el) continue;

        const feature = decorFeatures[i] || null;

        if (feature) {
            el.setAttribute('class', `svg-decor ${feature.className || ''}`.trim());
            el.setAttribute('d', pointsToPath(feature.points, feature.closed));
            applyFeatureStyle(el, feature);

            if (gsap && duration > 0) {
                gsap.to(el, { duration, ease, opacity: Number.isFinite(Number(feature.opacity)) ? Number(feature.opacity) : 1, overwrite: true });
            } else {
                el.style.opacity = String(Number.isFinite(Number(feature.opacity)) ? Number(feature.opacity) : 1);
            }
        } else {
            // Reset class to prevent CSS rules (e.g. .svg-tear opacity/animation) from overriding
            el.setAttribute('class', 'svg-decor');
            el.removeAttribute('d');
            if (gsap && duration > 0) {
                gsap.to(el, { duration, ease, opacity: 0, overwrite: true });
            } else {
                el.style.opacity = '0';
            }
        }
    }
}

function applyGazeTransforms() {
    if (!eyeGazeGroup || !mouthGazeGroup || !shapeLibrary?.viewBox) return;

    const width = Math.max(1, face.clientWidth || 1);
    const height = Math.max(1, face.clientHeight || 1);

    const vb = shapeLibrary.viewBox;

    const rawEyeX = gazeCss.eyeX * (vb.width / width);
    const rawEyeY = gazeCss.eyeY * (vb.height / height);
    const rawMouthX = gazeCss.mouthX * (vb.width / width);
    const rawMouthY = gazeCss.mouthY * (vb.height / height);

    const eyeX = clamp(rawEyeX * PARALLAX_PROFILE.eyeXMult, -PARALLAX_PROFILE.eyeXMax, PARALLAX_PROFILE.eyeXMax);
    const eyeY = clamp(rawEyeY * PARALLAX_PROFILE.eyeYMult, -PARALLAX_PROFILE.eyeYMax, PARALLAX_PROFILE.eyeYMax);
    const mouthX = clamp(rawMouthX * PARALLAX_PROFILE.mouthXMult, -PARALLAX_PROFILE.mouthXMax, PARALLAX_PROFILE.mouthXMax);
    const mouthY = clamp(rawMouthY * PARALLAX_PROFILE.mouthYMult, -PARALLAX_PROFILE.mouthYMax, PARALLAX_PROFILE.mouthYMax);

    eyeGazeGroup.setAttribute('transform', `translate(${toFixed(eyeX)} ${toFixed(eyeY)})`);
    mouthGazeGroup.setAttribute('transform', `translate(${toFixed(mouthX)} ${toFixed(mouthY)})`);
}

function applyShapeProfile(shapeKey, options = {}) {
    const profile = getProfileByShapeKey(shapeKey);
    if (!profile) return;

    const duration = options.instant ? 0 : (Number.isFinite(options.duration) ? options.duration : MOTION_PROFILE.expression.duration);
    const ease = options.ease || MOTION_PROFILE.expression.ease;

    if (!options.mouthOnly) {
        morphFeature('leftEye', profile.leftEye, duration, ease);
        morphFeature('rightEye', profile.rightEye, duration, ease);
    }
    morphFeature('mouth', profile.mouth, duration, ease);

    applyDecor(profile.decor || [], duration, ease);
    setMouthWaveActive(Boolean(profile.wave));

    if (svgLayerEl) {
        svgLayerEl.dataset.svgTint = profile.tint || 'neutral';
    }
}

function squashFeature(feature, squashRatio = 0.08) {
    if (!feature || !feature.points || feature.points.length === 0) return null;

    // Find vertical center of the eye
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of feature.points) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    const centerY = (minY + maxY) / 2;

    // Squash all Y coords toward center
    const squashedPoints = feature.points.map(p => ({
        x: p.x,
        y: centerY + (p.y - centerY) * squashRatio,
    }));

    return {
        ...feature,
        points: squashedPoints,
    };
}

export function blinkSvgEyes() {
    if (activeRenderer !== 'svg') return;

    const exprKey = resolveExpressionKey();
    const shapeKey = expressionToShapeKey(exprKey);
    if (NO_BLINK_EXPRESSIONS.has(shapeKey)) return;

    // Don't overlap blinks
    if (blinkTimer) return;

    const gsap = getGsap();
    const leftState = featureState.leftEye;
    const rightState = featureState.rightEye;
    if (!leftState || !rightState) return;

    // Snapshot current open-eye features to restore after blink
    const openLeft = cloneFeature(leftState);
    const openRight = cloneFeature(rightState);

    // Create squashed "closed" eye features
    const closedLeft = squashFeature(openLeft);
    const closedRight = squashFeature(openRight);
    if (!closedLeft || !closedRight) return;

    const CLOSE_MS = 60;
    const HOLD_MS = 80;
    const OPEN_MS = 70;

    // Close eyes
    morphFeature('leftEye', closedLeft, CLOSE_MS / 1000, 'sine.in');
    morphFeature('rightEye', closedRight, CLOSE_MS / 1000, 'sine.in');

    // Reopen after hold
    blinkTimer = setTimeout(() => {
        morphFeature('leftEye', openLeft, OPEN_MS / 1000, 'sine.out');
        morphFeature('rightEye', openRight, OPEN_MS / 1000, 'sine.out');

        blinkTimer = setTimeout(() => {
            blinkTimer = null;
        }, OPEN_MS + 20);
    }, CLOSE_MS + HOLD_MS);
}

function startSpeakingCycle() {
    if (speakingTimer || activeRenderer !== 'svg') return;

    const motion = MOTION_PROFILE.speaking;
    speakingIndex = 0;
    // Only animate mouth — preserve current expression's eyes/decor
    applyShapeProfile(TALK_SEQUENCE[speakingIndex], { mouthOnly: true, duration: motion.enterDuration, ease: motion.ease });

    speakingTimer = setInterval(() => {
        speakingIndex = (speakingIndex + 1) % TALK_SEQUENCE.length;
        applyShapeProfile(TALK_SEQUENCE[speakingIndex], {
            mouthOnly: true,
            duration: motion.frameDuration,
            ease: motion.ease,
        });
    }, motion.intervalMs);
}

function stopSpeakingCycle() {
    if (!speakingTimer) return;
    clearInterval(speakingTimer);
    speakingTimer = null;
}

function applyExpressionProfile(expressionKey, options = {}) {
    if (expressionKey === 'speaking') {
        startSpeakingCycle();
        return;
    }

    // If currently speaking, update eyes/decor but keep mouth cycling
    if (speakingTimer) {
        const shapeKey = expressionToShapeKey(expressionKey);
        const profile = getProfileByShapeKey(shapeKey);
        if (profile) {
            const duration = options.instant ? 0 : (Number.isFinite(options.duration) ? options.duration : MOTION_PROFILE.expression.duration);
            const ease = options.ease || MOTION_PROFILE.expression.ease;
            morphFeature('leftEye', profile.leftEye, duration, ease);
            morphFeature('rightEye', profile.rightEye, duration, ease);
            applyDecor(profile.decor || [], duration, ease);
            if (svgLayerEl) {
                svgLayerEl.dataset.svgTint = profile.tint || 'neutral';
            }
        }
        return;
    }

    stopSpeakingCycle();
    const shapeKey = expressionToShapeKey(expressionKey);
    applyShapeProfile(shapeKey, options);
}

function updateModeStatus(mode) {
    if (!modeStatusEl) return;

    const useSvg = mode === 'svg';
    modeStatusEl.textContent = useSvg ? (shapeLoadDegraded ? 'SVG*' : 'SVG') : 'CSS';
    modeStatusEl.classList.remove('svg', 'fallback');
    if (useSvg) modeStatusEl.classList.add('svg');
    if (useSvg && shapeLoadDegraded) modeStatusEl.classList.add('fallback');
}

function syncModeSelect() {
    if (!modeSelectEl) return;
    const next = normalizeMode(STATE.faceRenderMode);
    if (modeSelectEl.value === next) return;

    syncingSelect = true;
    modeSelectEl.value = next;
    syncingSelect = false;
}

function syncRenderer(options = {}) {
    const mode = normalizeMode(STATE.faceRenderMode);
    const useSvg = mode === 'svg';

    activeRenderer = useSvg ? 'svg' : 'css';
    face.classList.toggle('use-svg-renderer', useSvg);
    updateModeStatus(mode);

    if (!useSvg) {
        stopSpeakingCycle();
        return;
    }

    applyGazeTransforms();
    applyExpressionProfile(resolveExpressionKey(), options);
}

function buildSvgLayer() {
    if (svgLayerEl) return;

    const vb = shapeLibrary?.viewBox || { x: 0, y: 0, width: 55.44, height: 33.34 };

    svgLayerEl = createSvgEl('svg', {
        id: 'face-svg-layer',
        viewBox: `${vb.x} ${vb.y} ${vb.width} ${vb.height}`,
        preserveAspectRatio: 'xMidYMid meet',
        'aria-hidden': 'true',
        'data-svg-tint': 'neutral',
        style: 'overflow: visible;', // Ensure features aren't clipped
    });

    const defs = createSvgEl('defs');

    // Scanline Pattern (approx 1% height of viewport ~0.33 units)
    // We strive for ~2-3px visual density. If VB height is 33, and screen height is ~300px, 1 unit = 9px.
    // 0.3 units ~ 2.7px.
    const scanHeight = 0.25;
    const scanPattern = createSvgEl('pattern', {
        id: 'scanline-pattern',
        width: '100', // Wider than viewport
        height: scanHeight,
        patternUnits: 'userSpaceOnUse',
        patternTransform: 'translate(0,0)',
    });

    const scanAnim = createSvgEl('animateTransform', {
        attributeName: 'patternTransform',
        type: 'translate',
        from: '0 0',
        to: `0 ${scanHeight}`,
        dur: '3s',
        repeatCount: 'indefinite',
    });
    scanPattern.appendChild(scanAnim);

    // Base White (Full Opacity - Visible Content)
    const baseRect = createSvgEl('rect', {
        width: '100',
        height: scanHeight,
        fill: '#ffffff',
    });
    scanPattern.appendChild(baseRect);

    // Dark Line (Partial Opacity -> Gray in Mask -> Dims Content)
    const lineRect = createSvgEl('rect', {
        y: '0',
        width: '100',
        height: scanHeight * 0.4,
        fill: '#b0b0b0', // Light gray = slightly transparent in mask = dim scanline
    });
    scanPattern.appendChild(lineRect);

    defs.appendChild(scanPattern);

    // Mask
    const mask = createSvgEl('mask', {
        id: 'scanline-mask',
        maskUnits: 'userSpaceOnUse',
        x: '-50',
        y: '-50',
        width: '200',
        height: '200',
    });
    const maskRect = createSvgEl('rect', {
        x: '-50',
        y: '-50',
        width: '200',
        height: '200',
        fill: 'url(#scanline-pattern)',
    });
    mask.appendChild(maskRect);
    defs.appendChild(mask);

    svgLayerEl.appendChild(defs);

    // Apply mask to groups so it covers eyes + decor but not empty space
    eyeGazeGroup = createSvgEl('g', { class: 'svg-eye-gaze', mask: 'url(#scanline-mask)' });
    mouthGazeGroup = createSvgEl('g', { class: 'svg-mouth-gaze', mask: 'url(#scanline-mask)' });
    decorGroup = createSvgEl('g', { class: 'svg-decor-gaze' });

    leftEyePathEl = createSvgEl('path', { class: 'svg-eye left' });
    rightEyePathEl = createSvgEl('path', { class: 'svg-eye right' });
    mouthPathEl = createSvgEl('path', { class: 'svg-mouth svg-mouth-wave' });

    eyeGazeGroup.appendChild(leftEyePathEl);
    eyeGazeGroup.appendChild(rightEyePathEl);
    eyeGazeGroup.appendChild(decorGroup);

    for (let i = 0; i < MAX_DECOR_PATHS; i += 1) {
        const decorEl = createSvgEl('path', { class: 'svg-decor', opacity: '0' });
        decorGroup.appendChild(decorEl);
        decorEls.push(decorEl);
    }

    mouthGazeGroup.appendChild(mouthPathEl);

    // Append groups directly to svgLayerEl
    svgLayerEl.appendChild(eyeGazeGroup);
    svgLayerEl.appendChild(mouthGazeGroup);

    const anchor = face.querySelector('#zzz-anchor');
    if (anchor) {
        face.insertBefore(svgLayerEl, anchor);
    } else {
        face.appendChild(svgLayerEl);
    }
}

function initModeControl() {
    modeSelectEl = document.getElementById('face-render-mode');
    modeStatusEl = document.getElementById('face-render-active');

    if (!modeSelectEl) return;

    modeSelectEl.value = normalizeMode(STATE.faceRenderMode);
    modeSelectEl.addEventListener('change', () => {
        if (syncingSelect) return;
        setFaceRenderMode(modeSelectEl.value, { persist: true });
    });
}

async function initializeShapeLibrary() {
    try {
        const loaded = await loadNormalizedFaceShapes();
        shapeLibrary = loaded;
        shapeLoadDegraded = Array.isArray(loaded.failedKeys) && loaded.failedKeys.length > 0;
    } catch (err) {
        shapeLoadDegraded = true;
        console.warn('[FaceSVG] Using fallback shape library:', err);
    }

    if (svgLayerEl && shapeLibrary?.viewBox) {
        const vb = shapeLibrary.viewBox;
        svgLayerEl.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
    }

    syncRenderer({ instant: true });
}

export function initFaceRenderer() {
    if (initialized) return;
    initialized = true;

    if (!shapeLibrary) {
        shapeLibrary = buildFallbackFaceShapeLibrary();
    }

    STATE.faceRenderMode = resolveInitialMode();
    buildSvgLayer();
    initModeControl();
    syncModeSelect();
    writeStoredMode(STATE.faceRenderMode);

    const neutral = getProfileByShapeKey('neutral');
    if (neutral) {
        featureState.leftEye = cloneFeature(neutral.leftEye);
        featureState.rightEye = cloneFeature(neutral.rightEye);
        featureState.mouth = cloneFeature(neutral.mouth);
        renderMainFeatures();
        applyDecor(neutral.decor || [], 0);
    }

    syncRenderer({ instant: true });
    void initializeShapeLibrary();
}

export function setFaceRenderMode(mode, options = {}) {
    const nextMode = normalizeMode(mode);
    STATE.faceRenderMode = nextMode;
    writeStoredMode(nextMode);

    syncModeSelect();
    syncRenderer();

    if (options.persist) {
        void persistMode(nextMode);
    }
}

export function setFaceRendererExpression(expression) {
    currentExpression = String(expression || 'idle').toLowerCase();
    syncRenderer();
}

export function setFaceRendererSpeaking(active) {
    if (activeRenderer !== 'svg') return;
    if (active) {
        startSpeakingCycle();
    } else {
        stopSpeakingCycle();
        // Restore current expression's mouth shape
        const shapeKey = expressionToShapeKey(resolveExpressionKey());
        const profile = getProfileByShapeKey(shapeKey);
        if (profile) {
            morphFeature('mouth', profile.mouth, MOTION_PROFILE.expression.duration, MOTION_PROFILE.expression.ease);
            setMouthWaveActive(Boolean(profile.wave));
        }
    }
}

export function setFaceRendererGaze({ eyeX = 0, eyeY = 0, mouthX = 0, mouthY = 0 } = {}) {
    gazeCss.eyeX = eyeX;
    gazeCss.eyeY = eyeY;
    gazeCss.mouthX = mouthX;
    gazeCss.mouthY = mouthY;

    if (activeRenderer === 'svg') {
        applyGazeTransforms();
    }
}

async function persistMode(mode) {
    try {
        await fetch('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ faceRenderMode: mode }),
        });
    } catch {
        // ignore persistence errors
    }
}
