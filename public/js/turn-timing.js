let sequence = 0;

const pending = [];
const tracesById = new Map();
const tracesByTurnId = new Map();

function nowMs() {
    return performance.now();
}

function createTrace(source = 'frontend') {
    const id = `trace-${++sequence}`;
    const trace = {
        id,
        source,
        turnId: null,
        events: [],
        printed: false,
        createdAt: nowMs(),
    };
    tracesById.set(id, trace);
    pending.push(id);
    return trace;
}

function getTraceById(traceId) {
    if (!traceId) return null;
    return tracesById.get(traceId) || null;
}

function removePending(traceId) {
    for (let i = 0; i < pending.length; i++) {
        if (pending[i] === traceId) {
            pending.splice(i, 1);
            return;
        }
    }
}

function ensureTraceByTurn(turnId) {
    if (!turnId) return null;
    if (tracesByTurnId.has(turnId)) {
        return tracesByTurnId.get(turnId);
    }

    let trace = null;
    while (pending.length > 0 && !trace) {
        const candidateId = pending.shift();
        const candidate = tracesById.get(candidateId);
        if (!candidate) continue;
        if (candidate.turnId) continue;
        trace = candidate;
    }

    if (!trace) {
        trace = createTrace('frontend-fallback');
        pending.pop();
    }

    trace.turnId = turnId;
    tracesByTurnId.set(turnId, trace);
    markTrace(trace, 'Turn started (WS)');
    return trace;
}

function markTrace(trace, event, at = nowMs()) {
    if (!trace || !event) return;
    trace.events.push({ event: String(event), at: Number(at) || nowMs() });
}

function beginLocalTurn(source = 'vad') {
    const trace = createTrace(source);
    return trace.id;
}

export function markPendingTurn(traceId, event, at = nowMs()) {
    const trace = getTraceById(traceId);
    if (!trace) return;
    markTrace(trace, event, at);
}

export function attachTurnToPending(traceId, turnId) {
    if (!turnId) return null;

    let trace = getTraceById(traceId);
    if (!trace) {
        trace = ensureTraceByTurn(turnId);
        return trace?.id || null;
    }

    trace.turnId = turnId;
    tracesByTurnId.set(turnId, trace);
    if (!trace.events.some((evt) => evt.event === 'Turn started (WS)')) {
        markTrace(trace, 'Turn started (WS)');
    }

    for (let i = 0; i < pending.length; i++) {
        if (pending[i] === trace.id) {
            pending.splice(i, 1);
            break;
        }
    }

    return trace.id;
}

export function beginVadTurn() {
    const traceId = beginLocalTurn('vad');
    markPendingTurn(traceId, 'VAD started');
    return traceId;
}

export function onTurnStart(turnId) {
    ensureTraceByTurn(turnId);
}

export function markTurn(turnId, event, at = nowMs()) {
    if (!turnId) return;
    const trace = ensureTraceByTurn(turnId);
    markTrace(trace, event, at);
}

export function abandonPendingTurn(traceId, event = 'Turn ignored') {
    const trace = getTraceById(traceId);
    if (!trace) return;
    markTrace(trace, event);
    removePending(traceId);
}

function padLeft(value, width) {
    const s = String(value);
    return s.length >= width ? s : `${' '.repeat(width - s.length)}${s}`;
}

function padRight(value, width) {
    const s = String(value);
    return s.length >= width ? s : `${s}${' '.repeat(width - s.length)}`;
}

function formatSeconds(ms) {
    return (Math.max(0, ms) / 1000).toFixed(2);
}

function buildChart(trace) {
    if (!trace || !trace.events.length) return null;

    const rows = trace.events.slice().sort((a, b) => a.at - b.at);
    const firstAt = rows[0].at;
    let prevAt = firstAt;

    const tableRows = rows.map((row) => {
        const t = row.at - firstAt;
        const d = row.at - prevAt;
        prevAt = row.at;
        return {
            event: row.event,
            time: formatSeconds(t),
            delta: formatSeconds(d),
        };
    });

    const eventWidth = Math.max('Event'.length, ...tableRows.map((r) => r.event.length));
    const timeWidth = Math.max('Time (s)'.length, ...tableRows.map((r) => r.time.length));
    const deltaWidth = Math.max('Δ+'.length, ...tableRows.map((r) => r.delta.length));

    const lines = [];
    lines.push(`Timing Chart (frontend): turn=${trace.turnId || 'pending'} source=${trace.source}`);
    lines.push(`${padRight('Event', eventWidth)} | ${padLeft('Time (s)', timeWidth)} | ${padLeft('Δ+', deltaWidth)}`);
    lines.push(`${'-'.repeat(eventWidth)}-+-${'-'.repeat(timeWidth)}-+-${'-'.repeat(deltaWidth)}`);
    for (const row of tableRows) {
        lines.push(`${padRight(row.event, eventWidth)} | ${padLeft(row.time, timeWidth)} | ${padLeft(row.delta, deltaWidth)}`);
    }
    return lines.join('\n');
}

export function logTurnTiming(turnId, { force = false } = {}) {
    if (!turnId) return;
    const trace = tracesByTurnId.get(turnId);
    if (!trace) return;
    if (trace.printed && !force) return;

    const chart = buildChart(trace);
    if (!chart) return;
    console.log(chart);
    trace.printed = true;
}

export function markAndLog(turnId, event, { forceLog = false } = {}) {
    markTurn(turnId, event);
    logTurnTiming(turnId, { force: forceLog });
}
