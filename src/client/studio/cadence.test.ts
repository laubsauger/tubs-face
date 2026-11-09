import { describe, expect, it } from 'vitest';
import { STALL_MS, createCadenceMeter } from './cadence.js';

// The published face janked with an average frame rate that looked fine: a
// few held frames now and then. The report has to show the largest gap and
// count the stalls, or the next jank hides behind "30 fps" again.
describe('render cadence', () => {
  it('reports the frame rate, the largest gap and the stalls over the window', () => {
    const meter = createCadenceMeter();
    let t = 0;
    for (let i = 0; i < 60; i += 1) {
      meter.frame(t);
      t += i === 30 ? 140 : 1000 / 60;
    }
    const summary = meter.take(t);
    expect(summary.maxGapMs).toBe(140);
    expect(summary.stalls).toBe(1);
    expect(summary.fps).toBeGreaterThan(50);
    expect(STALL_MS).toBe(50);
  });

  it('counts a window without frames as one long gap, then starts afresh', () => {
    const meter = createCadenceMeter();
    meter.frame(0);
    expect(meter.take(5000).maxGapMs).toBe(5000);
    meter.frame(5010);
    meter.frame(5027);
    expect(meter.take(5030)).toMatchObject({ maxGapMs: 17, stalls: 0 });
  });
});
