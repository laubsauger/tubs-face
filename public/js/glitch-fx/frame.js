import { STATE } from '../state.js';
import {
    GAZE_EYE_RANGE_X,
    GAZE_EYE_RANGE_Y,
    GAZE_MOUTH_RANGE_X,
    GAZE_MOUTH_RANGE_Y,
    GLOW_ALPHA,
    GPU_UNIFORM_FLOATS,
} from './constants.js';
import { clamp01 } from './utils.js';

export function computeFrameState(now, deps) {
    const {
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
    } = deps;

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

    let nextGlitchBurstSeed = glitchBurstSeed;
    if (inBurst && !lastBurstState) {
        nextGlitchBurstSeed = Math.random() * 1000;
    }
    const nextLastBurstState = inBurst;

    const fl = config.glitch;
    const flickerMod = fl.flicker
        ? 1 - fl.flickerDepth * (0.5 + 0.5 * Math.sin(t * fl.flickerSpeed * 2))
        : 1;

    return {
        frame: {
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
        },
        lastBurstState: nextLastBurstState,
        glitchBurstSeed: nextGlitchBurstSeed,
    };
}

export function writeGpuUniforms(frame, deps) {
    const {
        gpuDevice,
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
    } = deps;

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

        u[0] = frame.W;
        u[1] = frame.H;
        u[2] = frame.dpr;
        u[3] = frame.t;

        u[4] = frame.faceOX;
        u[5] = frame.faceOY;
        u[6] = faceW;
        u[7] = faceH;

        u[8] = frame.eyeGazeX;
        u[9] = frame.eyeGazeY;
        u[10] = frame.mouthGazeX;
        u[11] = frame.mouthGazeY;

        u[12] = shapeCenters[0]?.cy || 0;
        u[13] = shapeCenters[1]?.cy || 0;
        u[14] = shapeCenters[2]?.cy || 0;
        u[15] = frame.blinkF;

        u[16] = frame.mouthScale;
        u[17] = frame.sz;
        u[18] = config.color.opacityMin;
        u[19] = frame.pulseMod;

        u[20] = ((baseHSL.h % 360) + 360) % 360 / 360;
        u[21] = clamp01(baseHSL.s / 100);
        u[22] = clamp01(baseHSL.l / 100);
        u[23] = frame.flickerMod;

        u[24] = frame.scanY;
        u[25] = frame.sbHalfW;
        u[26] = sb.brightness;
        u[27] = sb.glowStrength;

        u[28] = frame.chrOffX;
        u[29] = frame.chrOffY;
        u[30] = chr.intensity;
        u[31] = chr.enabled ? 1 : 0;

        u[32] = frame.inBurst ? 1 : 0;
        u[33] = gs.sliceCount;
        u[34] = gs.maxOffset;
        u[35] = gs.intensity;

        u[36] = gs.gapChance;
        u[37] = glitchBurstSeed;
        u[38] = gs.interval / 1000;
        u[39] = gs.burstDuration / 1000;

        u[40] = fl.scanlines ? 1 : 0;
        u[41] = fl.scanlineIntensity;
        u[42] = spacing;
        u[43] = scanlineScroll;

        u[44] = STATE.sleeping ? 1 : 0;
        u[45] = scanlineThicknessRatio;
        u[46] = bloomIntensity;
        u[47] = glowStrength;
    }

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

export function renderFrameWebGpu(frame, deps) {
    const {
        gpuDevice,
        gpuContext,
        gpuPixelPipeline,
        gpuPostPipeline,
        gpuPixelBindGroup,
        gpuPostBindGroup,
        gpuSceneTextureView,
        gpuInstanceCount,
    } = deps;

    if (
        !gpuDevice || !gpuContext ||
        !gpuPixelPipeline || !gpuPostPipeline ||
        !gpuPixelBindGroup || !gpuPostBindGroup ||
        !gpuSceneTextureView ||
        gpuInstanceCount <= 0
    ) return false;

    writeGpuUniforms(frame, deps);

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

export function renderFrameCanvas2D(frame, deps) {
    const {
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
    } = deps;

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

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const bsl = baseHSL.l;
    for (let i = 0; i < pixelGrid.length; i++) {
        const p = pixelGrid[i];
        const group = shapeGroups[i];

        let drawX = p.x + faceOX;
        let drawY = p.y + faceOY;
        let drawSzY = sz;

        if (group <= 1) {
            drawX += eyeGazeX;
            drawY += eyeGazeY;
            if (blinkF > 0 && shapeCenters[group]) {
                const centerY = shapeCenters[group].cy + faceOY + eyeGazeY;
                drawY = centerY + (drawY - centerY) * (1 - blinkF);
                drawSzY = Math.max(2, sz * (1 - blinkF * 0.85));
            }
        }

        if (group === 2) {
            drawX += mouthGazeX;
            drawY += mouthGazeY;
            if (mouthScale !== 1 && shapeCenters[2]) {
                const centerY = shapeCenters[2].cy + faceOY + mouthGazeY;
                drawY = centerY + (drawY - centerY) * mouthScale;
            }
        }

        if (group >= 3) {
            drawX += eyeGazeX;
            drawY += eyeGazeY;
            drawY += Math.sin(t * 1.5 + p.y * 0.05) * sz * 0.3;
        }

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

    tempCtx.setTransform(1, 0, 0, 1, 0, 0);
    tempCtx.clearRect(0, 0, pw, ph);
    tempCtx.drawImage(deps.canvas, 0, 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);

    ctx.filter = cachedGlowFilter;
    ctx.globalAlpha = GLOW_ALPHA * config.glow.bloomIntensity * flickerMod;
    ctx.drawImage(tempCanvas, 0, 0);

    ctx.filter = 'none';
    ctx.globalAlpha = flickerMod;
    ctx.drawImage(tempCanvas, 0, 0);

    if (chr.enabled && chr.intensity > 0) {
        ctx.filter = 'hue-rotate(40deg)';
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = chr.intensity * 0.35 * flickerMod;
        ctx.drawImage(tempCanvas, Math.round(chrOffX * dpr), Math.round(chrOffY * dpr));
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
    }

    if (inBurst) {
        tempCtx.clearRect(0, 0, pw, ph);
        tempCtx.drawImage(deps.canvas, 0, 0);
        ctx.clearRect(0, 0, pw, ph);

        const sliceH = Math.ceil(ph / gs.sliceCount);
        for (let j = 0; j < gs.sliceCount; j++) {
            if (Math.random() < gs.gapChance) continue;
            const sy = j * sliceH;
            const off = ((Math.random() - 0.5) * 2 * gs.maxOffset * gs.intensity * dpr) | 0;
            ctx.drawImage(tempCanvas, 0, sy, pw, sliceH, off, sy, pw, sliceH);
        }
    }

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
