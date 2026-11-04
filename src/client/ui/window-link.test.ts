import { describe, expect, it } from 'vitest';
import { alivePeers } from './window-link.js';

// The face window shows its mini tile only while no mini window is open. A
// mini window that crashes never says goodbye, so it must time out, or Small
// would vanish from the face window for good.
describe('alivePeers', () => {
  it('counts a window heard from recently', () => {
    const seen = new Map([['mini-1', { kind: 'mini' as const, at: 1000 }]]);
    expect(alivePeers(seen, 2000, 4500)).toEqual({ face: false, mini: true, dashboard: false });
  });

  it('forgets a window that stopped answering', () => {
    const seen = new Map([['mini-1', { kind: 'mini' as const, at: 1000 }]]);
    expect(alivePeers(seen, 1000 + 4500, 4500).mini).toBe(false);
  });

  it('keeps a kind alive while any one of its windows answers', () => {
    const seen = new Map([
      ['dash-old', { kind: 'dashboard' as const, at: 0 }],
      ['dash-new', { kind: 'dashboard' as const, at: 9000 }],
    ]);
    expect(alivePeers(seen, 10_000, 4500).dashboard).toBe(true);
  });
});
