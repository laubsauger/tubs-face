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
  side?: 'backend' | 'frontend' | string;
  turnId?: string;
  source?: 'voice' | 'ws' | string;
  startedAt?: number;
}

export interface TurnTimer {
  startedAt: number;
  rows: TurnTimerRow[];
  mark(event: string, atMs?: number): void;
  span(label: string): () => void;
  setMeta(key: string, value: string): void;
  chart(options?: { title?: string | null }): string;
  log(options?: { title?: string | null }): void;
}

export function createTurnTimer(args: CreateTurnTimerArgs = {}): TurnTimer {
  const startedAt = args.startedAt ?? Date.now();
  const side = args.side ?? 'backend';
  const turnId = args.turnId ?? 'n/a';
  const source = args.source ?? 'voice';
  const rows: TurnTimerRow[] = [];
  const spans: TurnTimerSpan[] = [];
  const meta: Array<[string, string]> = [];

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

  function setMeta(key: string, value: string): void {
    meta.push([key, value]);
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

    // Conversation context
    if (meta.length > 0) {
      for (const [key, value] of meta) {
        lines.push(`${key}: ${value}`);
      }
      lines.push('');
    }

    lines.push(`Timing Chart (${side}) | turn: ${turnId} | source: ${source}`);
    lines.push(`${padRight('Event', eventWidth)} | ${padLeft('Step', stepWidth)} | ${padLeft('Total', totalWidth)}`);
    lines.push(`${'-'.repeat(eventWidth)}-+-${'-'.repeat(stepWidth)}-+-${'-'.repeat(totalWidth)}`);
    for (const row of table) {
      lines.push(`${padRight(row.event, eventWidth)} | ${padLeft(row.step, stepWidth)} | ${padLeft(row.total, totalWidth)}`);
    }

    // Append visual timeline if we have spans or marks
    if (spans.length > 0 || rows.length > 0) {
      const timeline = renderTimeline(startedAt, spans, rows);
      if (timeline) {
        lines.push('');
        lines.push(timeline);
      }
    }

    return lines.join('\n');
  }

  function log(options: { title?: string | null } = {}): void {
    const output = chart(options);
    if (output) {
      const wrapped = [
        '[Turn Timing Begin]',
        output,
        '[Turn Timing End]',
      ].join('\n');
      process.stdout.write(`${wrapped}\n`);
    }
  }

  return {
    startedAt,
    rows,
    mark,
    span,
    setMeta,
    chart,
    log,
  };
}

/**
 * Render a simple ASCII gantt chart showing spans as horizontal bars
 * and standalone marks as point markers (▼).
 * Overlapping bars are stacked vertically so you can see at a glance
 * whether phases run in parallel or sequentially.
 */
function renderTimeline(originMs: number, spans: TurnTimerSpan[], rows: TurnTimerRow[]): string {
  if (spans.length === 0 && rows.length === 0) {
    return '';
  }

  const TIMELINE_WIDTH = 60;
  const spanEndMs = spans.length > 0 ? Math.max(...spans.map((s) => s.endMs)) : originMs;
  const rowEndMs = rows.length > 0 ? Math.max(...rows.map((r) => r.atMs)) : originMs;
  const endMs = Math.max(spanEndMs, rowEndMs);
  const totalMs = endMs - originMs;
  if (totalMs <= 0) {
    return '';
  }

  // Identify standalone marks (not part of any span's ▸/◂ markers)
  const spanMarkerEvents = new Set<string>();
  for (const s of spans) {
    spanMarkerEvents.add(`${s.label} ▸`);
    spanMarkerEvents.add(`${s.label} ◂`);
  }
  const pointMarks = rows.filter((r) => !spanMarkerEvents.has(r.event));

  const allLabels = [
    ...spans.map((s) => s.label),
    ...pointMarks.map((m) => m.event),
  ];
  const labelWidth = Math.max(12, ...allLabels.map((label) => label.length));
  const lines: string[] = [];
  lines.push(`Timeline (${formatTime(totalMs)} total):`);

  // Collect all items (spans + point marks) sorted by start time
  interface TimelineItem {
    kind: 'span' | 'mark';
    label: string;
    startMs: number;
    endMs?: number;
  }
  const items: TimelineItem[] = [
    ...spans.map((s) => ({ kind: 'span' as const, label: s.label, startMs: s.startMs, endMs: s.endMs })),
    ...pointMarks.map((m) => ({ kind: 'mark' as const, label: m.event, startMs: m.atMs })),
  ].sort((a, b) => a.startMs - b.startMs);

  for (const item of items) {
    if (item.kind === 'span') {
      const relStart = item.startMs - originMs;
      const relEnd = item.endMs! - originMs;
      const startCol = Math.round((relStart / totalMs) * TIMELINE_WIDTH);
      const endCol = Math.max(startCol + 1, Math.round((relEnd / totalMs) * TIMELINE_WIDTH));
      const duration = item.endMs! - item.startMs;

      const bar =
        ' '.repeat(startCol) +
        '█'.repeat(endCol - startCol) +
        ' '.repeat(Math.max(0, TIMELINE_WIDTH - endCol));

      lines.push(`  ${padRight(item.label, labelWidth)} |${bar}| ${formatTime(duration)}`);
    } else {
      const rel = item.startMs - originMs;
      const col = Math.min(TIMELINE_WIDTH - 1, Math.round((rel / totalMs) * TIMELINE_WIDTH));
      const marker =
        ' '.repeat(col) +
        '▼' +
        ' '.repeat(Math.max(0, TIMELINE_WIDTH - col - 1));

      lines.push(`  ${padRight(item.label, labelWidth)} |${marker}| ${formatTime(rel)}`);
    }
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
