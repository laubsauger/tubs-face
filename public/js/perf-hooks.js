let perfSink = null;

export function setPerfSink(nextSink) {
    perfSink = nextSink && typeof nextSink === 'object' ? nextSink : null;
}

export function clearPerfSink() {
    perfSink = null;
}

export function perfMark(name, count = 1) {
    if (!perfSink || typeof perfSink.mark !== 'function') return;
    perfSink.mark(name, count);
}

export function perfTime(name, ms) {
    if (!perfSink || typeof perfSink.time !== 'function') return;
    perfSink.time(name, ms);
}

export function perfGauge(name, value) {
    if (!perfSink || typeof perfSink.gauge !== 'function') return;
    perfSink.gauge(name, value);
}

export function perfSpan(name) {
    const start = performance.now();
    return () => {
        perfTime(name, performance.now() - start);
    };
}
