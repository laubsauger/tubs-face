export function recreateCanvasElement(canvas) {
    if (!canvas) return null;

    const next = document.createElement('canvas');
    next.id = 'glitch-fx-canvas';
    next.style.display = canvas.style.display || 'none';
    if (canvas.parentElement) {
        canvas.parentElement.replaceChild(next, canvas);
    }
    return next;
}

export function rebuildScanlinePattern(ctx, config, cachedDpr) {
    if (!ctx || !config.glitch.scanlines) return null;

    const spacing = Math.max(1, Math.round(config.glitch.scanlineSpacing * cachedDpr));
    const thickness = Math.max(1, Math.round(config.glitch.scanlineThickness * cachedDpr));
    const patternCanvas = document.createElement('canvas');
    patternCanvas.width = 4;
    patternCanvas.height = spacing;
    const patternCtx = patternCanvas.getContext('2d');
    if (!patternCtx) return null;

    patternCtx.fillStyle = '#000';
    patternCtx.fillRect(0, 0, 4, thickness);
    return ctx.createPattern(patternCanvas, 'repeat');
}

export function initCanvas2DRenderer(canvas, config, cachedDpr) {
    if (!canvas) {
        return {
            ok: false,
            ctx: null,
            tempCanvas: null,
            tempCtx: null,
            scanlinePattern: null,
        };
    }

    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
        || canvas.getContext('2d');
    if (!ctx) {
        return {
            ok: false,
            ctx: null,
            tempCanvas: null,
            tempCtx: null,
            scanlinePattern: null,
        };
    }

    ctx.imageSmoothingEnabled = false;

    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) tempCtx.imageSmoothingEnabled = false;

    const scanlinePattern = rebuildScanlinePattern(ctx, config, cachedDpr);

    return {
        ok: true,
        ctx,
        tempCanvas,
        tempCtx,
        scanlinePattern,
    };
}

export function sizeCanvasLayout({
    containerEl,
    canvas,
    config,
    rendererKind,
    ctx,
    tempCanvas,
    tempCtx,
    scanlinePattern,
    configureWebGpuCanvas,
}) {
    if (!containerEl || !canvas) return null;

    const rect = containerEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(rect.width * dpr);
    const ph = Math.round(rect.height * dpr);
    const sizeChanged = canvas.width !== pw || canvas.height !== ph;

    if (sizeChanged) {
        canvas.width = pw;
        canvas.height = ph;
    }

    let nextTempCanvas = tempCanvas;
    let nextTempCtx = tempCtx;
    let nextScanlinePattern = scanlinePattern;

    if (rendererKind === 'canvas2d' && ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (!nextTempCanvas) {
            nextTempCanvas = document.createElement('canvas');
            nextTempCtx = nextTempCanvas.getContext('2d');
            if (nextTempCtx) nextTempCtx.imageSmoothingEnabled = false;
        }

        if (nextTempCanvas) {
            nextTempCanvas.width = pw;
            nextTempCanvas.height = ph;
        }

        if (sizeChanged) {
            nextScanlinePattern = rebuildScanlinePattern(ctx, config, dpr);
        }
    }

    if (rendererKind === 'webgpu' && typeof configureWebGpuCanvas === 'function') {
        configureWebGpuCanvas();
    }

    return {
        containerCssW: rect.width,
        containerCssH: rect.height,
        cachedDpr: dpr,
        cachedGlowFilter: `blur(${Math.round(config.glow.pixelGlow * dpr)}px)`,
        tempCanvas: nextTempCanvas,
        tempCtx: nextTempCtx,
        scanlinePattern: nextScanlinePattern,
    };
}
