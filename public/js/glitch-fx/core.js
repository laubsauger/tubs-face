// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Glitch FX — Pixel-art face with post-processing
//  Dual backend: WebGPU (preferred) + Canvas 2D fallback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { STATE } from '../state.js';
import { onGazeTargetChanged } from '../eye-tracking.js';
import { onBlink } from '../expressions.js';
import {
    BLINK_CLOSE_MS,
    BLINK_HOLD_MS,
    BLINK_OPEN_MS,
    BLINK_TOTAL_MS,
    DEFAULT_CONFIG,
    FEATURE_BOX_GLOBAL_SCALE_X,
    FEATURE_BOX_GLOBAL_SCALE_Y,
    FEATURE_BOX_MAIN_BOOST,
    GAZE_LERP,
    GLITCH_DIAG,
    GPU_UNIFORM_FLOATS,
    SPEAK_CYCLE_MS,
    SPEAK_MAX_SCALE,
    SPEAK_MIN_SCALE,
} from './constants.js';
import { WEBGPU_POST_SHADER, WEBGPU_SHADER } from './shaders.js';
import {
    hexToHSL,
    hslToRGB,
    mergeConfig,
    normalizeRenderer,
} from './utils.js';
import {
    buildPixelGrid as buildPixelGridData,
    getActiveExpression,
    recolorPixelGrid as recolorPixelGridData,
} from './pixel-grid.js';
import {
    computeFrameState as computeFrameStateData,
    renderFrameCanvas2D as renderFrameCanvas2DBackend,
    renderFrameWebGpu as renderFrameWebGpuBackend,
} from './frame.js';

// ── Default config (ROBOT_FX) ──────────────

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

// ── Utility ───────────────────────────────

function applyDerivedColors(hex) {
    const hsl = hexToHSL(hex);
    baseHSL = hsl;
    const sb = hslToRGB(hsl.h, 100, 50);
    cachedScanBeamRGBA = `rgba(${sb.r},${sb.g},${sb.b},0.26)`;
    cachedGlowFilter = `blur(${Math.round(config.glow.pixelGlow * cachedDpr)}px)`;
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
    const next = buildPixelGridData({
        faceEl,
        faceW,
        faceH,
        config,
        effectivePixelSize,
        effectivePixelGap,
        baseHSL,
        colorLUTs,
        getFeatureGlobalScale,
    });
    pixelGrid = next.pixelGrid;
    shapeGroups = next.shapeGroups;
    shapeCenters = next.shapeCenters;
    lastGridDebug = next.lastGridDebug;
    lastBuiltExpression = next.lastBuiltExpression;
    lastSleepingState = next.lastSleepingState;

    if (rendererKind === 'webgpu') {
        updateGpuInstanceBuffer();
    }

    logGlitchDiag('grid');
}

function recolorPixelGrid() {
    recolorPixelGridData({ pixelGrid, colorLUTs, baseHSL });
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
    const next = computeFrameStateData(now, {
        config,
        startTime,
        cachedDpr,
        canvas,
        containerCssW,
        containerCssH,
        effectivePixelSize,
        faceEl,
        baseFaceX,
        baseFaceY,
        currentGazeX,
        currentGazeY,
        faceW,
        faceH,
        getBlinkFactor,
        getSpeakMouthScale,
        lastBurstState,
        glitchBurstSeed,
    });
    lastBurstState = next.lastBurstState;
    glitchBurstSeed = next.glitchBurstSeed;
    return next.frame;
}

function renderFrameWebGpu(frame) {
    return renderFrameWebGpuBackend(frame, {
        gpuDevice,
        gpuContext,
        gpuPixelPipeline,
        gpuPostPipeline,
        gpuPixelBindGroup,
        gpuPostBindGroup,
        gpuSceneTextureView,
        gpuInstanceCount,
        gpuUniformBuffer,
        gpuPostUniformBuffer,
        gpuUniformData,
        gpuPostUniformData,
        config,
        faceW,
        faceH,
        shapeCenters,
        baseHSL,
        glitchBurstSeed,
    });
}

function renderFrameCanvas2D(frame) {
    return renderFrameCanvas2DBackend(frame, {
        canvas,
        ctx,
        tempCtx,
        tempCanvas,
        config,
        baseHSL,
        pixelGrid,
        shapeGroups,
        shapeCenters,
        cachedGlowFilter,
        cachedScanBeamRGBA,
        scanlinePattern,
    });
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
