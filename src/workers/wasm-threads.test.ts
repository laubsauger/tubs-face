import { describe, expect, it } from 'vitest';
import { wasmThreadsFor } from './wasm-threads.js';

// One thread ran face detection at 584 ms a frame, eight at 82. Threads only
// exist on a cross-origin isolated page; asking for them elsewhere fails.
describe('wasmThreadsFor', () => {
  it('uses up to eight threads on an isolated page, leaving two cores free', () => {
    expect(wasmThreadsFor(true, 14)).toBe(8);
    expect(wasmThreadsFor(true, 6)).toBe(4);
    expect(wasmThreadsFor(true, 2)).toBe(1);
  });

  it('stays on one thread when the page is not isolated', () => {
    expect(wasmThreadsFor(false, 14)).toBe(1);
  });
});
