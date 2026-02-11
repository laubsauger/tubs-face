const CANONICAL_VIEWBOX = Object.freeze({ x: 0, y: 0, width: 55.44, height: 33.34 });

const SHAPE_FILES = Object.freeze([
    { key: 'neutral', url: '/shapes/neutral.svg' },
    { key: 'talk1', url: '/shapes/talk-1.svg' },
    { key: 'talk2', url: '/shapes/talk-2.svg' },
    { key: 'talk3', url: '/shapes/talk-3.svg' },
    { key: 'smile', url: '/shapes/smile.svg' },
    { key: 'happy', url: '/shapes/happy.svg' },
    { key: 'sad', url: '/shapes/sad.svg' },
    { key: 'thinking', url: '/shapes/thinking.svg' },
    { key: 'sleep', url: '/shapes/sleep.svg' },
    { key: 'love', url: '/shapes/love.svg' },
    { key: 'crying', url: '/shapes/crying.svg' },
    { key: 'angry', url: '/shapes/angry.svg' },
    { key: 'surprised', url: '/shapes/surprised.svg' },
]);

const SOURCE_SAMPLE_POINTS = 64;
const EYE_POINTS = 36;
const MOUTH_POINTS = 44;
const DECOR_POINTS = 44;

let measurePathEl = null;

function toNum(raw, fallback = 0) {
    const parsed = Number.parseFloat(String(raw ?? ''));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseViewBox(svgEl) {
    const raw = String(svgEl.getAttribute('viewBox') || '').trim();
    if (!raw) return CANONICAL_VIEWBOX;

    const values = raw.split(/[\s,]+/).map(v => Number.parseFloat(v));
    if (values.length !== 4 || values.some(v => !Number.isFinite(v))) {
        return CANONICAL_VIEWBOX;
    }

    return {
        x: values[0],
        y: values[1],
        width: values[2],
        height: values[3],
    };
}

function parseInlineStyle(styleText) {
    const out = {};
    const raw = String(styleText || '').trim();
    if (!raw) return out;

    for (const chunk of raw.split(';')) {
        const [k, v] = chunk.split(':');
        if (!k || !v) continue;
        out[k.trim().toLowerCase()] = v.trim();
    }
    return out;
}

function readStyleOrAttr(el, attrName, cssName, fallback = '') {
    const attrValue = el.getAttribute(attrName);
    if (attrValue != null && String(attrValue).trim() !== '') return String(attrValue).trim();
    const styleMap = parseInlineStyle(el.getAttribute('style'));
    if (styleMap[cssName]) return styleMap[cssName];
    return fallback;
}

function normalizeColor(value, fallback = 'none') {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === 'none' || raw === 'transparent') return 'none';
    return raw;
}

function normalizeOpacity(value, fallback = 1) {
    const parsed = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(1, parsed));
}

function parsePaint(el, defaults = {}) {
    const fill = normalizeColor(readStyleOrAttr(el, 'fill', 'fill', defaults.fill || 'none'), defaults.fill || 'none');
    const stroke = normalizeColor(readStyleOrAttr(el, 'stroke', 'stroke', defaults.stroke || 'none'), defaults.stroke || 'none');

    let strokeWidth = toNum(readStyleOrAttr(el, 'stroke-width', 'stroke-width', defaults.strokeWidth || 0), defaults.strokeWidth || 0);
    if (stroke !== 'none' && strokeWidth <= 0) strokeWidth = 4;

    return {
        fill,
        stroke,
        strokeWidth,
        linecap: String(readStyleOrAttr(el, 'stroke-linecap', 'stroke-linecap', defaults.linecap || 'round')).trim() || 'round',
        linejoin: String(readStyleOrAttr(el, 'stroke-linejoin', 'stroke-linejoin', defaults.linejoin || 'round')).trim() || 'round',
        opacity: normalizeOpacity(readStyleOrAttr(el, 'opacity', 'opacity', defaults.opacity || 1), defaults.opacity || 1),
    };
}

function getMeasurePathEl() {
    if (measurePathEl) return measurePathEl;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('width', '0');
    root.setAttribute('height', '0');
    root.style.position = 'absolute';
    root.style.left = '-9999px';
    root.style.top = '-9999px';
    root.style.width = '0';
    root.style.height = '0';
    root.style.overflow = 'hidden';
    root.style.pointerEvents = 'none';

    measurePathEl = document.createElementNS(SVG_NS, 'path');
    root.appendChild(measurePathEl);
    document.body.appendChild(root);

    return measurePathEl;
}

function pathFromRect(rect) {
    const x = toNum(rect.getAttribute('x'));
    const y = toNum(rect.getAttribute('y'));
    const width = Math.max(0, toNum(rect.getAttribute('width')));
    const height = Math.max(0, toNum(rect.getAttribute('height')));
    const rxRaw = Math.max(0, toNum(rect.getAttribute('rx')));
    const ryRaw = Math.max(0, toNum(rect.getAttribute('ry') || rect.getAttribute('rx')));

    if (width <= 0 || height <= 0) return '';

    const rx = Math.min(rxRaw, width / 2);
    const ry = Math.min(ryRaw, height / 2);

    if (rx <= 0 && ry <= 0) {
        return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
    }

    return [
        `M ${x + rx} ${y}`,
        `H ${x + width - rx}`,
        `A ${rx} ${ry} 0 0 1 ${x + width} ${y + ry}`,
        `V ${y + height - ry}`,
        `A ${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height}`,
        `H ${x + rx}`,
        `A ${rx} ${ry} 0 0 1 ${x} ${y + height - ry}`,
        `V ${y + ry}`,
        `A ${rx} ${ry} 0 0 1 ${x + rx} ${y}`,
        'Z',
    ].join(' ');
}

function pathFromLine(line) {
    const x1 = toNum(line.getAttribute('x1'));
    const y1 = toNum(line.getAttribute('y1'));
    const x2 = toNum(line.getAttribute('x2'));
    const y2 = toNum(line.getAttribute('y2'));
    return `M ${x1} ${y1} L ${x2} ${y2}`;
}

function pathFromCircle(circle) {
    const cx = toNum(circle.getAttribute('cx'));
    const cy = toNum(circle.getAttribute('cy'));
    const r = Math.max(0, toNum(circle.getAttribute('r')));
    if (r <= 0) return '';
    return [
        `M ${cx - r} ${cy}`,
        `A ${r} ${r} 0 1 0 ${cx + r} ${cy}`,
        `A ${r} ${r} 0 1 0 ${cx - r} ${cy}`,
        'Z',
    ].join(' ');
}

function scalePointToCanonical(point, from) {
    const sx = CANONICAL_VIEWBOX.width / Math.max(0.0001, from.width);
    const sy = CANONICAL_VIEWBOX.height / Math.max(0.0001, from.height);

    return {
        x: (point.x - from.x) * sx + CANONICAL_VIEWBOX.x,
        y: (point.y - from.y) * sy + CANONICAL_VIEWBOX.y,
    };
}

function samplePathPoints(pathD, count, closed) {
    if (!pathD || count <= 0) return [];

    const pathEl = getMeasurePathEl();
    pathEl.setAttribute('d', pathD);

    let totalLength = 0;
    try {
        totalLength = pathEl.getTotalLength();
    } catch {
        return [];
    }

    if (!Number.isFinite(totalLength) || totalLength <= 0.0001) {
        return [];
    }

    const points = [];
    const denominator = closed ? count : Math.max(1, count - 1);

    for (let i = 0; i < count; i += 1) {
        const t = i / denominator;
        const distance = Math.max(0, Math.min(totalLength, totalLength * t));
        const p = pathEl.getPointAtLength(distance);
        points.push({ x: p.x, y: p.y });
    }

    return points;
}

function buildBounds(points) {
    if (!points.length) {
        return {
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0,
            width: 0,
            height: 0,
            cx: 0,
            cy: 0,
        };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }

    const width = Math.max(0, maxX - minX);
    const height = Math.max(0, maxY - minY);

    return {
        minX,
        minY,
        maxX,
        maxY,
        width,
        height,
        cx: minX + width / 2,
        cy: minY + height / 2,
    };
}

function parseColorToRgb(color) {
    const value = String(color || '').trim().toLowerCase();
    if (!value || value === 'none' || value === 'transparent') return null;

    if (value.startsWith('#')) {
        const hex = value.slice(1);
        if (hex.length === 3) {
            const r = Number.parseInt(hex[0] + hex[0], 16);
            const g = Number.parseInt(hex[1] + hex[1], 16);
            const b = Number.parseInt(hex[2] + hex[2], 16);
            if ([r, g, b].every(Number.isFinite)) return { r, g, b };
        }
        if (hex.length === 6) {
            const r = Number.parseInt(hex.slice(0, 2), 16);
            const g = Number.parseInt(hex.slice(2, 4), 16);
            const b = Number.parseInt(hex.slice(4, 6), 16);
            if ([r, g, b].every(Number.isFinite)) return { r, g, b };
        }
    }

    const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/);
    if (rgbMatch) {
        const parts = rgbMatch[1].split(',').map(v => Number.parseFloat(v.trim()));
        if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
            return { r: parts[0], g: parts[1], b: parts[2] };
        }
    }

    const named = {
        white: { r: 255, g: 255, b: 255 },
        black: { r: 0, g: 0, b: 0 },
        red: { r: 255, g: 0, b: 0 },
    };

    return named[value] || null;
}

function isBlueTone(style) {
    const source = style.fill !== 'none' ? style.fill : style.stroke;
    const rgb = parseColorToRgb(source);
    if (!rgb) return false;
    return rgb.b > rgb.r + 24 && rgb.b > rgb.g + 8;
}

function stylePrimaryColor(style) {
    if (style.fill && style.fill !== 'none') return style.fill;
    if (style.stroke && style.stroke !== 'none') return style.stroke;
    return '#ffffff';
}

function resamplePolyline(points, count, closed = false) {
    if (!Array.isArray(points) || points.length === 0 || count <= 0) return [];
    if (points.length === 1) return Array.from({ length: count }, () => ({ x: points[0].x, y: points[0].y }));

    const ring = closed ? [...points, points[0]] : [...points];

    const cumulative = [0];
    for (let i = 1; i < ring.length; i += 1) {
        const dx = ring[i].x - ring[i - 1].x;
        const dy = ring[i].y - ring[i - 1].y;
        cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
    }

    const total = cumulative[cumulative.length - 1];
    if (!Number.isFinite(total) || total <= 0.00001) {
        return Array.from({ length: count }, () => ({ x: points[0].x, y: points[0].y }));
    }

    const out = [];
    const denominator = closed ? count : Math.max(1, count - 1);

    let seg = 1;
    for (let i = 0; i < count; i += 1) {
        const target = (i / denominator) * total;
        while (seg < cumulative.length - 1 && cumulative[seg] < target) seg += 1;

        const d0 = cumulative[seg - 1];
        const d1 = cumulative[seg];
        const p0 = ring[seg - 1];
        const p1 = ring[seg];

        const t = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
        out.push({
            x: p0.x + (p1.x - p0.x) * t,
            y: p0.y + (p1.y - p0.y) * t,
        });
    }

    return out;
}

function createPrimitive({ key, id, pathD, closed, style, viewBox }) {
    const sampled = samplePathPoints(pathD, SOURCE_SAMPLE_POINTS, closed);
    if (!sampled.length) return null;

    const canonicalPoints = sampled.map(p => scalePointToCanonical(p, viewBox));
    const bounds = buildBounds(canonicalPoints);

    return {
        key,
        id,
        pathD,
        closed,
        style,
        points: canonicalPoints,
        bounds,
        color: stylePrimaryColor(style),
    };
}

function parseShapeSvg(svgText, key) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (!svgEl) throw new Error('No <svg> root');

    const viewBox = parseViewBox(svgEl);
    const primitives = [];
    let index = 0;

    const addPrimitive = (pathD, closed, style) => {
        const primitive = createPrimitive({
            key,
            id: `${key}-${index += 1}`,
            pathD,
            closed,
            style,
            viewBox,
        });
        if (primitive) primitives.push(primitive);
    };

    for (const el of doc.querySelectorAll('rect')) {
        const pathD = pathFromRect(el);
        const style = parsePaint(el, { fill: '#fff', stroke: 'none', strokeWidth: 0, linecap: 'round', linejoin: 'round', opacity: 1 });
        addPrimitive(pathD, true, style);
    }

    for (const el of doc.querySelectorAll('line')) {
        const pathD = pathFromLine(el);
        const style = parsePaint(el, { fill: 'none', stroke: '#fff', strokeWidth: 4, linecap: 'round', linejoin: 'round', opacity: 1 });
        addPrimitive(pathD, false, style);
    }

    for (const el of doc.querySelectorAll('circle')) {
        const pathD = pathFromCircle(el);
        const style = parsePaint(el, { fill: '#fff', stroke: 'none', strokeWidth: 0, linecap: 'round', linejoin: 'round', opacity: 1 });
        addPrimitive(pathD, true, style);
    }

    for (const el of doc.querySelectorAll('path')) {
        const pathD = String(el.getAttribute('d') || '').trim();
        if (!pathD) continue;

        const style = parsePaint(el, { fill: 'none', stroke: '#fff', strokeWidth: 4, linecap: 'round', linejoin: 'round', opacity: 1 });
        const closes = /(?:z|Z)\s*$/.test(pathD) || (style.fill !== 'none' && style.fill !== 'transparent');
        addPrimitive(pathD, closes, style);
    }

    return primitives;
}

function toFeature(primitive, pointCount, className = '') {
    return {
        points: resamplePolyline(primitive.points, pointCount, primitive.closed),
        closed: primitive.closed,
        fill: primitive.style.fill,
        stroke: primitive.style.stroke,
        strokeWidth: primitive.style.strokeWidth,
        linecap: primitive.style.linecap,
        linejoin: primitive.style.linejoin,
        opacity: primitive.style.opacity,
        className,
    };
}

function pickEyes(candidates, centerX) {
    if (!candidates.length) return { left: null, right: null };

    const top = [...candidates].sort((a, b) => a.bounds.cy - b.bounds.cy).slice(0, Math.min(8, candidates.length));

    const leftPool = top.filter(p => p.bounds.cx <= centerX - 0.2).sort((a, b) => a.bounds.cy - b.bounds.cy || a.bounds.cx - b.bounds.cx);
    const rightPool = top.filter(p => p.bounds.cx >= centerX + 0.2).sort((a, b) => a.bounds.cy - b.bounds.cy || b.bounds.cx - a.bounds.cx);

    const fallbackLeft = [...candidates].sort((a, b) => a.bounds.cx - b.bounds.cx)[0] || null;
    const fallbackRight = [...candidates].sort((a, b) => b.bounds.cx - a.bounds.cx)[0] || null;

    const left = leftPool[0] || fallbackLeft;
    let right = rightPool[0] || fallbackRight;

    if (left && right && left.id === right.id) {
        right = rightPool.find(p => p.id !== left.id) || [...candidates].find(p => p.id !== left.id) || null;
    }

    return { left: left || null, right: right || null };
}

function pickMouth(candidates, usedIds, centerX) {
    const pool = candidates.filter(p => !usedIds.has(p.id));
    if (!pool.length) return null;

    const mouthBandY = 25.8;

    const sorted = [...pool].sort((a, b) => {
        const scoreA = Math.abs(a.bounds.cx - centerX) * 2.8 + Math.abs(a.bounds.cy - mouthBandY) * 0.55 - a.bounds.height * 0.08;
        const scoreB = Math.abs(b.bounds.cx - centerX) * 2.8 + Math.abs(b.bounds.cy - mouthBandY) * 0.55 - b.bounds.height * 0.08;
        return scoreA - scoreB;
    });

    return sorted[0] || null;
}

function inferTint(leftEye, rightEye, mouth) {
    const colors = [leftEye, rightEye, mouth]
        .map((feature) => parseColorToRgb(feature ? stylePrimaryColor(feature.style || feature) : null))
        .filter(Boolean);

    if (!colors.length) return 'neutral';

    const avg = colors.reduce((acc, color) => ({
        r: acc.r + color.r,
        g: acc.g + color.g,
        b: acc.b + color.b,
    }), { r: 0, g: 0, b: 0 });

    avg.r /= colors.length;
    avg.g /= colors.length;
    avg.b /= colors.length;

    if (avg.r > 220 && avg.g < 110 && avg.b < 130) return 'red';
    if (avg.r > 220 && avg.g < 150 && avg.b > 130) return 'pink';
    return 'neutral';
}

function buildProfileFromPrimitives(key, primitives) {
    if (!Array.isArray(primitives) || primitives.length < 3) return null;

    const centerX = CANONICAL_VIEWBOX.width / 2;
    const visible = primitives.filter(p => p.points.length >= 2);
    if (visible.length < 3) return null;

    const nonBlue = visible.filter(p => !isBlueTone(p.style));
    const faceCandidates = nonBlue.length >= 3 ? nonBlue : visible;

    const { left, right } = pickEyes(faceCandidates, centerX);
    if (!left || !right) return null;

    const used = new Set([left.id, right.id]);
    let mouth = pickMouth(faceCandidates, used, centerX);
    if (!mouth) mouth = pickMouth(visible, used, centerX);
    if (!mouth) return null;

    used.add(mouth.id);

    const decor = visible
        .filter(p => !used.has(p.id))
        .map((primitive) => {
            const isTear = isBlueTone(primitive.style);
            const className = isTear ? 'svg-tear' : 'svg-decor';
            return toFeature(primitive, DECOR_POINTS, className);
        });

    return {
        leftEye: toFeature(left, EYE_POINTS),
        rightEye: toFeature(right, EYE_POINTS),
        mouth: toFeature(mouth, MOUTH_POINTS),
        decor,
        wave: key === 'thinking',
        tint: inferTint(left, right, mouth),
    };
}

function createRoundedRectFeature({ x, y, width, height, rx = 0, fill = '#fff', stroke = 'none', strokeWidth = 0 }, pointCount = EYE_POINTS) {
    const pathD = pathFromRect({
        getAttribute(name) {
            if (name === 'x') return x;
            if (name === 'y') return y;
            if (name === 'width') return width;
            if (name === 'height') return height;
            if (name === 'rx') return rx;
            if (name === 'ry') return rx;
            return '';
        },
    });

    const points = samplePathPoints(pathD, SOURCE_SAMPLE_POINTS, true)
        .map((p) => scalePointToCanonical(p, CANONICAL_VIEWBOX));

    return {
        points: resamplePolyline(points, pointCount, true),
        closed: true,
        fill,
        stroke,
        strokeWidth,
        linecap: 'round',
        linejoin: 'round',
        opacity: 1,
        className: '',
    };
}

function createLineFeature({ x1, y1, x2, y2, stroke = '#fff', strokeWidth = 4 }, pointCount = MOUTH_POINTS) {
    const pathD = `M ${x1} ${y1} L ${x2} ${y2}`;
    const points = samplePathPoints(pathD, SOURCE_SAMPLE_POINTS, false)
        .map((p) => scalePointToCanonical(p, CANONICAL_VIEWBOX));

    return {
        points: resamplePolyline(points, pointCount, false),
        closed: false,
        fill: 'none',
        stroke,
        strokeWidth,
        linecap: 'round',
        linejoin: 'round',
        opacity: 1,
        className: '',
    };
}

function createFallbackProfiles() {
    const neutralEyeLeft = createRoundedRectFeature({ x: 0, y: 0, width: 14.59, height: 22.47, rx: 5.94 }, EYE_POINTS);
    const neutralEyeRight = createRoundedRectFeature({ x: 40.85, y: 0, width: 14.59, height: 22.47, rx: 5.94 }, EYE_POINTS);

    const neutral = {
        leftEye: neutralEyeLeft,
        rightEye: neutralEyeRight,
        mouth: createLineFeature({ x1: 22.41, y1: 25.82, x2: 32.85, y2: 25.82 }, MOUTH_POINTS),
        decor: [],
        wave: false,
        tint: 'neutral',
    };

    const talk1 = {
        ...neutral,
        mouth: createRoundedRectFeature({ x: 20.53, y: 23.86, width: 14.38, height: 2.44, rx: 1.17 }, MOUTH_POINTS),
    };

    const talk2 = {
        ...neutral,
        mouth: createRoundedRectFeature({ x: 20.53, y: 23.86, width: 14.38, height: 6.44, rx: 1.95 }, MOUTH_POINTS),
    };

    const talk3 = {
        ...neutral,
        mouth: createRoundedRectFeature({ x: 20.53, y: 23.86, width: 14.38, height: 9.47, rx: 1.95 }, MOUTH_POINTS),
    };

    const sleep = {
        leftEye: createRoundedRectFeature({ x: 1.3, y: 9.5, width: 12, height: 4, rx: 2, fill: '#fff' }, EYE_POINTS),
        rightEye: createRoundedRectFeature({ x: 42.15, y: 9.5, width: 12, height: 4, rx: 2, fill: '#fff' }, EYE_POINTS),
        mouth: createRoundedRectFeature({ x: 24.5, y: 25, width: 6.5, height: 3, rx: 1.5, fill: '#fff' }, MOUTH_POINTS),
        decor: [],
        wave: false,
        tint: 'neutral',
    };

    return {
        neutral,
        talk1,
        talk2,
        talk3,
        smile: neutral,
        happy: neutral,
        sad: neutral,
        thinking: neutral,
        sleep,
        love: neutral,
        crying: neutral,
        angry: neutral,
        surprised: neutral,
    };
}

function ensureRequiredProfiles(profilesByKey) {
    const fallback = createFallbackProfiles();

    for (const required of ['neutral', 'talk1', 'talk2', 'talk3']) {
        if (!profilesByKey[required]) profilesByKey[required] = fallback[required];
    }

    for (const [key, value] of Object.entries(fallback)) {
        if (!profilesByKey[key]) profilesByKey[key] = value;
    }

    return profilesByKey;
}

async function fetchSvgText(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
    return res.text();
}

export function buildFallbackFaceShapeLibrary() {
    return {
        viewBox: CANONICAL_VIEWBOX,
        profilesByKey: ensureRequiredProfiles({}),
        failedKeys: [],
    };
}

export async function loadNormalizedFaceShapes() {
    const profilesByKey = {};
    const failedKeys = [];

    await Promise.all(SHAPE_FILES.map(async ({ key, url }) => {
        try {
            const svgText = await fetchSvgText(url);
            const primitives = parseShapeSvg(svgText, key);
            const profile = buildProfileFromPrimitives(key, primitives);
            if (profile) {
                profilesByKey[key] = profile;
            } else {
                failedKeys.push(key);
            }
        } catch (err) {
            failedKeys.push(key);
            console.warn(`[FaceSVG] Shape load failed for ${key}:`, err);
        }
    }));

    return {
        viewBox: CANONICAL_VIEWBOX,
        profilesByKey: ensureRequiredProfiles(profilesByKey),
        failedKeys,
    };
}
