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

interface CreateTurnTimerArgs {
  side?: 'frontend' | string;
  turnId?: string;
  source?: 'tts' | 'voice' | 'ws' | string;
}

export interface TurnTimer {
  startedAt: number;
  rows: TurnTimerRow[];
  mark(event: string, atMs?: number): void;
  chart(options?: { title?: string | null }): string;
  log(options?: { title?: string | null }): void;
}

export function createTurnTimer(args: CreateTurnTimerArgs = {}): TurnTimer {
  const startedAt = Date.now();
  const side = args.side ?? 'frontend';
  const turnId = args.turnId ?? 'n/a';
  const source = args.source ?? 'tts';
  const rows: TurnTimerRow[] = [];

  function mark(event: string, atMs = Date.now()): void {
    rows.push({ event, atMs: Number(atMs) || Date.now() });
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
    chart,
    log,
  };
}
