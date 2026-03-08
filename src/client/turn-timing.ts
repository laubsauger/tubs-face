function padLeft(value: string | number, width: number): string {
  const text = String(value);
  if (text.length >= width) {
    return text;
  }
  return ' '.repeat(width - text.length) + text;
}

function padRight(value: string | number, width: number): string {
  const text = String(value);
  if (text.length >= width) {
    return text;
  }
  return text + ' '.repeat(width - text.length);
}

function formatTime(ms: number): string {
  const normalized = Math.max(0, Number(ms) || 0);
  if (normalized === 0) {
    return '0 ms';
  }
  if (normalized < 1000) {
    return `${Math.round(normalized)} ms`;
  }
  return `${(normalized / 1000).toFixed(2)} s`;
}

interface TurnTimerRow {
  event: string;
  atMs: number;
}

interface TurnTimerSpan {
  label: string;
  startMs: number;
  endMs: number;
}

interface CreateTurnTimerArgs {
  side?: 'frontend' | string;
  turnId?: string;
  source?: 'tts' | 'voice' | 'ws' | string;
}

export interface TurnTimer {
  startedAt: number;
  rows: TurnTimerRow[];
  mark(event: string, atMs?: number): void;
  span(label: string): () => void;
  chart(options?: { title?: string | null }): string;
  log(options?: { title?: string | null }): void;
}

export function createTurnTimer(args: CreateTurnTimerArgs = {}): TurnTimer {
  const startedAt = Date.now();
  const side = args.side ?? 'frontend';
  const turnId = args.turnId ?? 'n/a';
  const source = args.source ?? 'tts';
  const rows: TurnTimerRow[] = [];
  const spans: TurnTimerSpan[] = [];

  function mark(event: string, atMs = Date.now()): void {
    rows.push({ event, atMs: Number(atMs) || Date.now() });
  }

  function span(label: string): () => void {
    const spanStartMs = Date.now();
    rows.push({ event: `${label} ▸`, atMs: spanStartMs });
    return () => {
      const spanEndMs = Date.now();
      rows.push({ event: `${label} ◂`, atMs: spanEndMs });
      spans.push({ label, startMs: spanStartMs, endMs: spanEndMs });
    };
  }

  function chart(options: { title?: string | null } = {}): string {
    if (!rows.length) {
      return '';
    }

    const ordered = rows.slice().sort((left, right) => left.atMs - right.atMs);
    let previousAt = startedAt;
    const table = ordered.map((row) => {
      const totalMs = row.atMs - startedAt;
      const deltaMs = row.atMs - previousAt;
      previousAt = row.atMs;
      return {
        event: row.event,
        step: `+${formatTime(deltaMs)}`,
        total: formatTime(totalMs),
      };
    });

    const eventWidth = Math.max('Event'.length, ...table.map((row) => row.event.length));
    const stepWidth = Math.max('Step'.length, ...table.map((row) => row.step.length));
    const totalWidth = Math.max('Total'.length, ...table.map((row) => row.total.length));
    const lines: string[] = [];

    if (options.title) {
      lines.push(options.title);
    }
    lines.push(`Timing Chart (${side}) | turn: ${turnId} | source: ${source}`);
    lines.push(`${padRight('Event', eventWidth)} | ${padLeft('Step', stepWidth)} | ${padLeft('Total', totalWidth)}`);
    lines.push(`${'-'.repeat(eventWidth)}-+-${'-'.repeat(stepWidth)}-+-${'-'.repeat(totalWidth)}`);
    for (const row of table) {
      lines.push(`${padRight(row.event, eventWidth)} | ${padLeft(row.step, stepWidth)} | ${padLeft(row.total, totalWidth)}`);
    }

    // Append visual timeline if we have spans
    if (spans.length > 0) {
      lines.push('');
      lines.push(renderTimeline(startedAt, spans));
    }

    return lines.join('\n');
  }

  function log(options: { title?: string | null } = {}): void {
    const output = chart(options);
    if (output) {
      console.log(output);
    }
  }

  return {
    startedAt,
    rows,
    mark,
    span,
    chart,
    log,
  };
}

/**
 * Render a simple ASCII gantt chart showing spans as horizontal bars.
 * Overlapping bars are stacked vertically so you can see at a glance
 * whether phases run in parallel or sequentially.
 */
function renderTimeline(originMs: number, spans: TurnTimerSpan[]): string {
  if (spans.length === 0) {
    return '';
  }

  const TIMELINE_WIDTH = 60;
  const endMs = Math.max(...spans.map((s) => s.endMs));
  const totalMs = endMs - originMs;
  if (totalMs <= 0) {
    return '';
  }

  const labelWidth = Math.max(12, ...spans.map((s) => s.label.length));
  const lines: string[] = [];
  lines.push(`Timeline (${formatTime(totalMs)} total):`);

  for (const s of spans) {
    const relStart = s.startMs - originMs;
    const relEnd = s.endMs - originMs;
    const startCol = Math.round((relStart / totalMs) * TIMELINE_WIDTH);
    const endCol = Math.max(startCol + 1, Math.round((relEnd / totalMs) * TIMELINE_WIDTH));
    const duration = s.endMs - s.startMs;

    const bar =
      ' '.repeat(startCol) +
      '█'.repeat(endCol - startCol) +
      ' '.repeat(Math.max(0, TIMELINE_WIDTH - endCol));

    lines.push(`  ${padRight(s.label, labelWidth)} |${bar}| ${formatTime(duration)}`);
  }

  // Footer with time markers
  const t25 = formatTime(totalMs * 0.25);
  const t50 = formatTime(totalMs * 0.5);
  const t75 = formatTime(totalMs * 0.75);
  const tEnd = formatTime(totalMs);
  const footer = `  ${' '.repeat(labelWidth)} |${'0'}${' '.repeat(Math.floor(TIMELINE_WIDTH * 0.25) - 1)}${t25}${' '.repeat(Math.max(1, Math.floor(TIMELINE_WIDTH * 0.25) - t25.length))}${t50}${' '.repeat(Math.max(1, Math.floor(TIMELINE_WIDTH * 0.25) - t50.length))}${t75}${' '.repeat(Math.max(1, TIMELINE_WIDTH - Math.floor(TIMELINE_WIDTH * 0.75) - t75.length))}| ${tEnd}`;
  lines.push(footer);

  return lines.join('\n');
}
