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

function formatTime(ms) {
  ms = Math.max(0, Number(ms) || 0);
  if (ms === 0) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
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
        step: `+${formatTime(deltaMs)}`,
        total: formatTime(timeMs),
      };
    });

    const eventWidth = Math.max('Event'.length, ...table.map((r) => r.event.length));
    const stepWidth = Math.max('Step'.length, ...table.map((r) => r.step.length));
    const totalWidth = Math.max('Total'.length, ...table.map((r) => r.total.length));

    const lines = [];
    if (title) lines.push(`${title}`);
    lines.push(`Timing Chart (${side}) | turn: ${turnId} | source: ${source}`);
    lines.push(`${padRight('Event', eventWidth)} | ${padLeft('Step', stepWidth)} | ${padLeft('Total', totalWidth)}`);
    lines.push(`${'-'.repeat(eventWidth)}-+-${'-'.repeat(stepWidth)}-+-${'-'.repeat(totalWidth)}`);
    for (const row of table) {
      lines.push(`${padRight(row.event, eventWidth)} | ${padLeft(row.step, stepWidth)} | ${padLeft(row.total, totalWidth)}`);
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
