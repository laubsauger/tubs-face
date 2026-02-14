function padLeft(value, width) {
  const s = String(value);
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}

function padRight(value, width) {
  const s = String(value);
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function formatMs(ms) {
  return (Math.max(0, ms) / 1000).toFixed(2);
}

function createTurnTimer({ side = 'backend', turnId = 'n/a', source = 'voice' } = {}) {
  const startedAt = Date.now();
  const rows = [];

  function mark(event, atMs = Date.now()) {
    rows.push({ event, atMs: Number(atMs) || Date.now() });
  }

  function chart({ title = null } = {}) {
    if (!rows.length) return '';

    const ordered = rows.slice().sort((a, b) => a.atMs - b.atMs);
    const firstAt = startedAt;
    let prevAt = firstAt;

    const table = ordered.map((row) => {
      const timeMs = row.atMs - firstAt;
      const deltaMs = row.atMs - prevAt;
      prevAt = row.atMs;
      return {
        event: row.event,
        time: formatMs(timeMs),
        delta: formatMs(deltaMs),
      };
    });

    const eventWidth = Math.max('Event'.length, ...table.map((r) => r.event.length));
    const timeWidth = Math.max('Time (s)'.length, ...table.map((r) => r.time.length));
    const deltaWidth = Math.max('Δ+'.length, ...table.map((r) => r.delta.length));

    const lines = [];
    if (title) lines.push(`${title}`);
    lines.push(`Timing Chart (${side}): turn=${turnId} source=${source}`);
    lines.push(`${padRight('Event', eventWidth)} | ${padLeft('Time (s)', timeWidth)} | ${padLeft('Δ+', deltaWidth)}`);
    lines.push(`${'-'.repeat(eventWidth)}-+-${'-'.repeat(timeWidth)}-+-${'-'.repeat(deltaWidth)}`);
    for (const row of table) {
      lines.push(`${padRight(row.event, eventWidth)} | ${padLeft(row.time, timeWidth)} | ${padLeft(row.delta, deltaWidth)}`);
    }
    return lines.join('\n');
  }

  function log({ title = null } = {}) {
    const output = chart({ title });
    if (output) console.log(output);
  }

  return {
    startedAt,
    mark,
    chart,
    log,
    rows,
  };
}

module.exports = {
  createTurnTimer,
};
