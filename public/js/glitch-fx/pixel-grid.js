import { STATE } from '../state.js';
import {
    EXPRESSION_PROFILES,
    FEATURE_BOX_GLOBAL_SCALE_X,
    FEATURE_BOX_GLOBAL_SCALE_Y,
    FEATURE_MOUTH_SCALE_X,
    FEATURE_MOUTH_SCALE_Y,
} from './constants.js';
import {
    getColorLUT as getColorLUTFromCache,
    hexToHSL,
    testShapeHit,
} from './utils.js';

function getColorLUT(colorLUTs, h, s) {
    return getColorLUTFromCache(colorLUTs, h, s);
}

export function getActiveExpression() {
    if (STATE.sleeping) return 'sleep';
    return STATE.expression || 'idle';
}

export function getModifiedShapes(config) {
    const expr = getActiveExpression();
    const profile = EXPRESSION_PROFILES[expr] || null;
    const base = config.svg.shapes;
    const shapes = base.map((s) => ({ ...s }));
    if (!profile) return shapes;

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

    const m = shapes[2];
    const mcx = m.x + m.w / 2;
    const mcy = m.y + m.h / 2;
    if (profile.mouthW) { m.w *= profile.mouthW; m.x = mcx - m.w / 2; }
    if (profile.mouthH) { m.h *= profile.mouthH; m.y = mcy - m.h / 2; }
    if (profile.mouthRound) { m.rx = Math.min(m.w, m.h) / 2; m.ry = m.rx; }
    m.rx = Math.min(m.rx, m.w / 2);
    m.ry = Math.min(m.ry, m.h / 2);

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

export function getShapesBounds(shapes) {
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

export function getFeatureTargetBounds(faceEl, W, H) {
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

export function buildPixelGrid({
    faceEl,
    faceW,
    faceH,
    config,
    effectivePixelSize,
    effectivePixelGap,
    baseHSL,
    colorLUTs,
    getFeatureGlobalScale,
}) {
    colorLUTs.clear();

    if (!faceEl) {
        return {
            pixelGrid: [],
            shapeGroups: [],
            shapeCenters: [],
            lastGridDebug: null,
            lastBuiltExpression: getActiveExpression(),
            lastSleepingState: STATE.sleeping,
        };
    }

    const W = faceW || faceEl.getBoundingClientRect().width;
    const H = faceH || faceEl.getBoundingClientRect().height;
    if (!W || !H) {
        return {
            pixelGrid: [],
            shapeGroups: [],
            shapeCenters: [],
            lastGridDebug: null,
            lastBuiltExpression: getActiveExpression(),
            lastSleepingState: STATE.sleeping,
        };
    }

    const pixelGrid = [];
    const shapeGroups = [];
    const shapeCenters = [];
    const shapes = getModifiedShapes(config);
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

        let hitTest = 'rect';
        if (profile) {
            if (si <= 1 && profile.eyeShape) hitTest = profile.eyeShape;
            if (si === 2 && profile.mouthShape) hitTest = profile.mouthShape;
        }

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
                    lut: getColorLUT(colorLUTs, baseH + hOff, baseS),
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
        minPX = 0;
        minPY = 0;
        maxPX = 0;
        maxPY = 0;
    }

    return {
        pixelGrid,
        shapeGroups,
        shapeCenters,
        lastGridDebug: {
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
        },
        lastBuiltExpression: expr,
        lastSleepingState: STATE.sleeping,
    };
}

export function recolorPixelGrid({ pixelGrid, colorLUTs, baseHSL }) {
    colorLUTs.clear();
    for (let i = 0; i < pixelGrid.length; i++) {
        const p = pixelGrid[i];
        const base = p.overrideHSL || baseHSL;
        p.lut = getColorLUT(colorLUTs, base.h + p.hueOff, base.s);
    }
}
