import { describe, expect, it } from 'vitest';
import { createVisionStats } from './stats.js';

// The operator switches providers mid-show to compare them: the top line of
// /stats must show the call that just happened, whichever provider made it.
describe('vision stats', () => {
  it('show the latest call\'s latency on top, after a switch of provider too', () => {
    const stats = createVisionStats();
    stats.call('openai', { ok: true, ms: 6294 });
    stats.call('gemini', { ok: true, ms: 1661 });
    const view = stats.view({ provider: 'gemini', model: 'g', usedThisHour: 2, maxPerHour: 120 });
    expect(view.lastLatencyMs).toBe(1661);
    expect(view.byProvider.openai.lastLatencyMs).toBe(6294);
    expect(view.avgLatencyMs).toBe(Math.round((6294 + 1661) / 2));
  });
});
