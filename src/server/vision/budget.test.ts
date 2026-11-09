import { describe, expect, it } from 'vitest';
import { createVisionBudget } from './budget.js';

// Vision is one of the main running costs. The cap must hold whatever sends
// pictures; a sleeping Tubs needs no refreshes; but a new visitor is always
// looked at once (that is what the greeting is made of).

const rules = { off: false, sleeping: false, whileAsleep: false, maxPerHour: 3 };

describe('vision budget', () => {
  it('stops at the hourly cap, and lets pictures through again an hour after the oldest', () => {
    let now = 0;
    const budget = createVisionBudget({ now: () => now, log: () => {} });
    expect([1, 2, 3].map(() => budget.admit('refresh', rules).ok)).toEqual([true, true, true]);
    expect(budget.admit('refresh', rules)).toEqual({ ok: false, reason: 'cap' });
    expect(budget.admit('appearance', rules)).toEqual({ ok: false, reason: 'cap' });
    now = 60 * 60_000 + 1;
    expect(budget.admit('refresh', rules).ok).toBe(true);
  });

  it('skips refreshes while Tubs sleeps, but still looks at a new visitor', () => {
    const budget = createVisionBudget({ log: () => {} });
    expect(budget.admit('refresh', { ...rules, sleeping: true })).toEqual({ ok: false, reason: 'asleep' });
    expect(budget.admit('appearance', { ...rules, sleeping: true }).ok).toBe(true);
    expect(budget.admit('refresh', { ...rules, sleeping: true, whileAsleep: true }).ok).toBe(true);
  });

  it('sends nothing with the provider off, and does not count it', () => {
    const budget = createVisionBudget({ log: () => {} });
    expect(budget.admit('appearance', { ...rules, off: true })).toEqual({ ok: false, reason: 'off' });
    expect(budget.usedThisHour()).toBe(0);
  });

  it('logs a skip once, not per frame', () => {
    const lines: string[] = [];
    const budget = createVisionBudget({ log: (line) => lines.push(line) });
    for (let i = 0; i < 20; i += 1) budget.admit('refresh', { ...rules, sleeping: true });
    expect(lines).toHaveLength(1);
    budget.admit('refresh', rules);
    expect(lines).toHaveLength(2);
  });
});
