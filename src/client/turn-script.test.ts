import { describe, expect, it } from 'vitest';
import { buildLocalTurnTimeline } from './turn-script.js';
import type { TurnBeat } from '../shared/contracts/turn-script.js';

const beats: TurnBeat[] = [
  { actor: 'main', action: 'speak', text: 'Main line.' },
  { actor: 'small', action: 'speak', text: 'Small line.' },
];

describe('buildLocalTurnTimeline', () => {
  // With a mini screen, the small head's lines are its job: main waits for it.
  it('waits for the other head in two-head mode', () => {
    expect(buildLocalTurnTimeline(beats, 'main', { includeRemoteWait: true }).map((item) => item.action)).toEqual(['speak', 'wait_remote']);
  });

  // Without one, a "Small" beat from Manual Beats was silently dropped.
  it('voices every head on the one screen in single-head mode', () => {
    const timeline = buildLocalTurnTimeline(beats, 'main', { includeRemoteWait: false, voiceAllActors: true });
    expect(timeline.map((item) => [item.action, item.actor, item.text])).toEqual([
      ['speak', 'main', 'Main line.'],
      ['speak', 'small', 'Small line.'],
    ]);
  });
});
