import { describe, expect, it } from 'vitest';
import { IDLE_SETTLE_MS } from '../behavior/emotion-runtime.js';
import { chooseIdleAction, type IdleAction } from './behavior-runtime.js';

// An idle face that smiles every few seconds stops meaning anything by it;
// it just flickers. Idle changes should be rare and deliberate, and the face
// should get to rest at idle before the next one.

function shares(context: Parameters<typeof chooseIdleAction>[1]): Record<IdleAction, number> {
  const counts: Record<IdleAction, number> = { smile: 0, wander: 0, none: 0 };
  const steps = 1000;
  for (let i = 0; i < steps; i += 1) counts[chooseIdleAction(i / steps, context)] += 1;
  return { smile: counts.smile / steps, wander: counts.wander / steps, none: counts.none / steps };
}

const SETTLED = { tracking: false, idleForMs: 60_000, sinceWanderMs: 60_000 };

describe('idle behaviour', () => {
  it('most idle steps change nothing; a smile is the exception', () => {
    const settled = shares(SETTLED);
    expect(settled.smile).toBeGreaterThan(0.05);
    expect(settled.smile).toBeLessThanOrEqual(0.2);
    expect(settled.none).toBeGreaterThan(0.6);
  });

  it('never smiles right after the face came back to idle', () => {
    expect(shares({ ...SETTLED, idleForMs: IDLE_SETTLE_MS - 1 }).smile).toBe(0);
  });

  it('looks around only with nobody in view, and not right after the last time', () => {
    expect(shares(SETTLED).wander).toBeGreaterThan(0);
    expect(shares({ ...SETTLED, tracking: true }).wander).toBe(0);
    expect(shares({ ...SETTLED, sinceWanderMs: 2000 }).wander).toBe(0);
  });
});
