import { describe, expect, it } from 'vitest';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import { DEFAULT_POKE, poke, pokeContext, reasonOf } from './poke.js';

// The lever must wake the heads and get a reaction even with nobody in view: a wake to every page
// plus a proactive turn (which itself waits for quiet and never cuts a reply off).
describe('studio poke (the lever)', () => {
  it('wakes both heads and starts a reaction that names the event', () => {
    const sent: WsServerMessage[] = [];
    const turns: string[] = [];
    let awake = false;
    poke('Someone pulled the lever.', {
      broadcast: (m) => sent.push(m),
      noteAwake: () => { awake = true; },
      startProactiveTurn: (context) => turns.push(context),
    });
    expect(awake).toBe(true);
    expect(sent).toEqual([{ type: 'wake' }]);
    expect(turns).toEqual([pokeContext('Someone pulled the lever.')]);
    expect(turns[0]).toContain('no visitor said this');
  });

  it('uses the lever by default and keeps a given reason short', () => {
    expect(reasonOf({})).toBe(DEFAULT_POKE);
    expect(reasonOf({ reason: '  ' })).toBe(DEFAULT_POKE);
    expect(reasonOf({ reason: 'x'.repeat(500) })).toHaveLength(300);
  });
});
