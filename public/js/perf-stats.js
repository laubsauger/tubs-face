const MAX_TIMING_ROWS = 10;
const MAX_EVENT_ROWS = 12;
const MAX_GAUGE_ROWS = 8;
const SMOOTH_ALPHA = 0.45;

function clampAnchor(anchor) {
    const normalized = String(anchor || '').trim().toLowerCase();
    if (normalized === 'top-left') return 'top-left';
    if (normalized === 'bottom-left') return 'bottom-left';
    if (normalized === 'bottom-right') return 'bottom-right';
    return 'top-right';
}

function anchorStyle(anchor) {
    switch (anchor) {
        case 'top-left':
            return { top: '8px', left: '8px' };
        case 'bottom-left':
            return { bottom: '8px', left: '8px' };
        case 'bottom-right':
            return { bottom: '8px', right: '8px' };
        case 'top-right':
        default:
            return { top: '8px', right: '8px' };
    }
}

function smooth(prev, next, alpha = SMOOTH_ALPHA) {
    if (!Number.isFinite(prev)) return next;
    return prev * (1 - alpha) + next * alpha;
}

function fmtRate(v) {
    if (!Number.isFinite(v) || v < 0.01) return '0.0';
    return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

function fmtMs(v) {
    if (!Number.isFinite(v) || v < 0.01) return '0.00';
    if (v >= 100) return v.toFixed(0);
    if (v >= 10) return v.toFixed(1);
    return v.toFixed(2);
}

function createPanel({ anchorPos, topOffsetPx = 0, minWidth = 170 }) {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.zIndex = '12000';
    el.style.pointerEvents = 'none';
    el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    el.style.fontSize = '11px';
    el.style.lineHeight = '1.34';
    el.style.color = '#d8e1ff';
    el.style.background = 'rgba(7, 11, 20, 0.82)';
    el.style.border = '1px solid rgba(118, 145, 255, 0.34)';
    el.style.borderRadius = '6px';
    el.style.padding = '6px 8px';
    el.style.minWidth = `${minWidth}px`;
    el.style.whiteSpace = 'pre';
    el.style.opacity = '0.95';

    if (anchorPos.top) {
        el.style.top = `${parseInt(anchorPos.top, 10) + topOffsetPx}px`;
    }
    if (anchorPos.left) el.style.left = anchorPos.left;
    if (anchorPos.right) el.style.right = anchorPos.right;
    if (anchorPos.bottom) {
        el.style.bottom = `${parseInt(anchorPos.bottom, 10) + topOffsetPx}px`;
    }
    return el;
}

export function createPerfStats({ label = 'Perf', anchor = 'top-right' } = {}) {
    const anchorPos = anchorStyle(clampAnchor(anchor));
    const StatsCtor = globalThis.Stats;

    let statsInstance = null;
    let statsDom = null;
    let fpsPanel = null;
    let useFallbackFps = false;

    // Always compute a numeric FPS estimate so we can print it in text panel.
    let frameCount = 0;
    let frameWindowStart = performance.now();
    let fpsEstimate = 0;

    if (typeof StatsCtor === 'function') {
        statsInstance = new StatsCtor();
        statsInstance.showPanel(0);
        statsDom = statsInstance.dom || statsInstance.domElement;
        statsDom.style.position = 'fixed';
        statsDom.style.zIndex = '12000';
        statsDom.style.pointerEvents = 'none';
        statsDom.style.opacity = '0.95';
        statsDom.style.transform = 'scale(0.9)';
        statsDom.style.transformOrigin = 'top left';
        if (anchorPos.top) statsDom.style.top = anchorPos.top;
        if (anchorPos.left) statsDom.style.left = anchorPos.left;
        if (anchorPos.right) statsDom.style.right = anchorPos.right;
        if (anchorPos.bottom) statsDom.style.bottom = anchorPos.bottom;
        document.body.appendChild(statsDom);
    } else {
        useFallbackFps = true;
        fpsPanel = createPanel({ anchorPos, topOffsetPx: 0, minWidth: 110 });
        fpsPanel.textContent = 'FPS --.-';
        document.body.appendChild(fpsPanel);
    }

    const textPanel = createPanel({ anchorPos, topOffsetPx: 52, minWidth: 250 });
    document.body.appendChild(textPanel);

    const counterCounts = new Map();
    const counterOrder = [];
    const counterSmoothedRate = new Map();

    const timingBuckets = new Map(); // key -> { sumMs, count }
    const timingOrder = [];
    const timingSmoothed = new Map(); // key -> { budgetMsPerSec, avgMs, hz }

    const gauges = new Map();
    const gaugeOrder = [];

    let longTaskMsWindow = 0;
    let longTaskCountWindow = 0;
    let longTaskMsSmoothed = 0;
    let longTaskHzSmoothed = 0;

    let eventLoopLagAccum = 0;
    let eventLoopLagSamples = 0;
    let eventLoopLagMsSmoothed = 0;
    let lastLagTickAt = performance.now();

    let lastFlushAt = performance.now();
    let flushTimer = null;
    let frameRaf = null;
    let lagTimer = null;
    let longTaskObserver = null;
    let destroyed = false;

    if (typeof PerformanceObserver === 'function') {
        try {
            const supported = PerformanceObserver.supportedEntryTypes || [];
            if (supported.includes('longtask')) {
                longTaskObserver = new PerformanceObserver((list) => {
                    const entries = list.getEntries();
                    for (const entry of entries) {
                        const d = Number(entry.duration) || 0;
                        longTaskMsWindow += d;
                        longTaskCountWindow += 1;
                    }
                });
                longTaskObserver.observe({ entryTypes: ['longtask'] });
            }
        } catch {
            longTaskObserver = null;
        }
    }

    lagTimer = setInterval(() => {
        const now = performance.now();
        const expected = lastLagTickAt + 500;
        const lag = Math.max(0, now - expected);
        eventLoopLagAccum += lag;
        eventLoopLagSamples += 1;
        lastLagTickAt = now;
    }, 500);

    function touchOrder(list, key) {
        if (!list.includes(key)) list.push(key);
    }

    function mark(name, count = 1) {
        if (destroyed) return;
        const key = String(name || '').trim();
        if (!key) return;
        touchOrder(counterOrder, key);
        const next = (counterCounts.get(key) || 0) + Math.max(0, Number(count) || 0);
        counterCounts.set(key, next);
    }

    function time(name, ms) {
        if (destroyed) return;
        const key = String(name || '').trim();
        const value = Number(ms);
        if (!key || !Number.isFinite(value) || value < 0) return;
        touchOrder(timingOrder, key);
        const bucket = timingBuckets.get(key) || { sumMs: 0, count: 0 };
        bucket.sumMs += value;
        bucket.count += 1;
        timingBuckets.set(key, bucket);
    }

    function gauge(name, value) {
        if (destroyed) return;
        const key = String(name || '').trim();
        const num = Number(value);
        if (!key || !Number.isFinite(num)) return;
        touchOrder(gaugeOrder, key);
        gauges.set(key, num);
    }

    function flush() {
        const now = performance.now();
        const elapsedSec = Math.max(0.2, (now - lastFlushAt) / 1000);
        lastFlushAt = now;

        if (performance && performance.memory && Number.isFinite(performance.memory.usedJSHeapSize)) {
            gauge('heap_used_mb', performance.memory.usedJSHeapSize / (1024 * 1024));
        }

        for (const key of counterOrder) {
            const count = counterCounts.get(key) || 0;
            counterCounts.set(key, 0);
            const rate = count / elapsedSec;
            const prev = counterSmoothedRate.get(key);
            counterSmoothedRate.set(key, smooth(prev, rate));
        }

        for (const key of timingOrder) {
            const bucket = timingBuckets.get(key) || { sumMs: 0, count: 0 };
            timingBuckets.set(key, { sumMs: 0, count: 0 });
            const budgetMsPerSec = bucket.sumMs / elapsedSec;
            const avgMs = bucket.count > 0 ? bucket.sumMs / bucket.count : 0;
            const hz = bucket.count / elapsedSec;
            const prev = timingSmoothed.get(key) || { budgetMsPerSec: 0, avgMs: 0, hz: 0 };
            timingSmoothed.set(key, {
                budgetMsPerSec: smooth(prev.budgetMsPerSec, budgetMsPerSec),
                avgMs: smooth(prev.avgMs, avgMs),
                hz: smooth(prev.hz, hz),
            });
        }

        const lagMs = eventLoopLagSamples > 0 ? (eventLoopLagAccum / eventLoopLagSamples) : 0;
        eventLoopLagAccum = 0;
        eventLoopLagSamples = 0;
        eventLoopLagMsSmoothed = smooth(eventLoopLagMsSmoothed, lagMs, 0.35);

        const longTaskMsPerSec = longTaskMsWindow / elapsedSec;
        const longTaskHz = longTaskCountWindow / elapsedSec;
        longTaskMsWindow = 0;
        longTaskCountWindow = 0;
        longTaskMsSmoothed = smooth(longTaskMsSmoothed, longTaskMsPerSec, 0.35);
        longTaskHzSmoothed = smooth(longTaskHzSmoothed, longTaskHz, 0.35);

        const lines = [];
        lines.push(String(label));
        lines.push(`fps ${fmtRate(fpsEstimate)}  lag ${fmtMs(eventLoopLagMsSmoothed)}ms  lt ${fmtMs(longTaskMsSmoothed)}ms/s @${fmtRate(longTaskHzSmoothed)}/s`);

        if (gaugeOrder.length > 0) {
            lines.push('gauges');
            for (const key of gaugeOrder.slice(0, MAX_GAUGE_ROWS)) {
                lines.push(`  ${key.padEnd(18)} ${fmtMs(gauges.get(key) || 0)}`);
            }
        }

        const timingRows = timingOrder
            .map((key) => ({ key, ...(timingSmoothed.get(key) || { budgetMsPerSec: 0, avgMs: 0, hz: 0 }) }))
            .sort((a, b) => b.budgetMsPerSec - a.budgetMsPerSec)
            .slice(0, MAX_TIMING_ROWS);
        const totalTimedMsPerSec = timingOrder.reduce((sum, key) => {
            const row = timingSmoothed.get(key);
            return sum + (row?.budgetMsPerSec || 0);
        }, 0);
        const perfBoundHint = fpsEstimate < 45 && totalTimedMsPerSec < 180 && longTaskMsSmoothed < 35
            ? 'gpu/compositor?'
            : (totalTimedMsPerSec >= 300 || longTaskMsSmoothed >= 60)
                ? 'main-thread'
                : 'mixed';
        lines.push(`js ${fmtMs(totalTimedMsPerSec)}ms/s  bound ${perfBoundHint}`);
        if (timingRows.length > 0) {
            lines.push('timings (ms/s, avg, hz)');
            for (const row of timingRows) {
                lines.push(`  ${row.key.padEnd(18)} ${fmtMs(row.budgetMsPerSec).padStart(6)}  ${fmtMs(row.avgMs).padStart(6)}  ${fmtRate(row.hz).padStart(6)}`);
            }
        }

        const eventRows = counterOrder
            .map((key) => ({ key, rate: counterSmoothedRate.get(key) || 0 }))
            .sort((a, b) => b.rate - a.rate)
            .slice(0, MAX_EVENT_ROWS);
        if (eventRows.length > 0) {
            lines.push('events (/s)');
            for (const row of eventRows) {
                lines.push(`  ${row.key.padEnd(18)} ${fmtRate(row.rate).padStart(6)}`);
            }
        }

        textPanel.textContent = lines.join('\n');
    }

    function frameLoop() {
        if (destroyed) return;

        frameCount += 1;
        const now = performance.now();
        const elapsed = now - frameWindowStart;
        if (elapsed >= 450) {
            fpsEstimate = (frameCount * 1000) / elapsed;
            frameCount = 0;
            frameWindowStart = now;
            if (useFallbackFps && fpsPanel) {
                fpsPanel.textContent = `FPS ${fmtRate(fpsEstimate)}`;
            }
        }

        if (statsInstance && typeof statsInstance.begin === 'function' && typeof statsInstance.end === 'function') {
            statsInstance.begin();
            statsInstance.end();
        }

        frameRaf = requestAnimationFrame(frameLoop);
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (flushTimer) clearInterval(flushTimer);
        if (lagTimer) clearInterval(lagTimer);
        if (frameRaf != null) cancelAnimationFrame(frameRaf);
        if (longTaskObserver) {
            try {
                longTaskObserver.disconnect();
            } catch {
                // ignore
            }
        }
        if (statsDom) statsDom.remove();
        if (fpsPanel) fpsPanel.remove();
        textPanel.remove();
    }

    flushTimer = setInterval(flush, 1000);
    flush();
    frameLoop();

    return {
        mark,
        time,
        gauge,
        destroy,
    };
}
