import { describe, expect, it } from 'vitest';
import { formatMicSource, parseMicSource } from './studio.js';

// The mic source decides who Tubs hears. A typo must be refused, not quietly
// turned into "the default mic": that would listen to the wrong room.
describe('mic source', () => {
  it('reads every form the studio contract names', () => {
    expect(parseMicSource('local')).toEqual({ kind: 'local' });
    expect(parseMicSource('local:MacBook Pro Microphone')).toEqual({ kind: 'local', label: 'MacBook Pro Microphone' });
    expect(parseMicSource('site:cam-c920')).toEqual({ kind: 'site', path: 'cam-c920' });
    expect(parseMicSource('site:mic-room/left')).toEqual({ kind: 'site', path: 'mic-room/left' });
    expect(parseMicSource('off')).toEqual({ kind: 'off' });
  });

  it('refuses anything else instead of guessing', () => {
    for (const bad of ['', 'Local', 'default', 'local:', 'local:   ', 'site:', 'site:/abs', 'site:../x', 'site:a b', 'site:mic?x=1', 42, null]) {
      expect(parseMicSource(bad), String(bad)).toBeNull();
    }
  });

  it('writes back what it read, so GET /studio shows the source as set', () => {
    for (const value of ['local', 'local:USB Audio', 'site:mic-guest', 'off']) {
      expect(formatMicSource(parseMicSource(value)!)).toBe(value);
    }
  });
});
