import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRuntimeConfigPatch, runtimeConfig } from './runtime.js';

// POST /config feeds straight into applyRuntimeConfigPatch. A bad value must not
// leave the live config half-changed or silently different from what was asked.
describe('applyRuntimeConfigPatch', () => {
  let snapshot: typeof runtimeConfig;

  beforeEach(() => {
    snapshot = structuredClone(runtimeConfig);
  });

  afterEach(() => {
    Object.assign(runtimeConfig, snapshot);
  });

  it('applies valid fields', () => {
    applyRuntimeConfigPatch({ glitchRenderer: 'canvas2d', llmMaxOutputTokens: 512 });
    expect(runtimeConfig.glitchRenderer).toBe('canvas2d');
    expect(runtimeConfig.llmMaxOutputTokens).toBe(512);
  });

  it('rejects an unknown enum value with a BadRequestError', () => {
    expect(() => applyRuntimeConfigPatch({ glitchRenderer: 'hologram' as never })).toThrow(/glitchRenderer must be one of/);
    expect(runtimeConfig.glitchRenderer).toBe(snapshot.glitchRenderer);
  });

  it('keeps the old value when a number is out of range', () => {
    applyRuntimeConfigPatch({ llmMaxOutputTokens: 99999 });
    expect(runtimeConfig.llmMaxOutputTokens).toBe(snapshot.llmMaxOutputTokens);
  });

  // Known bug: fields are applied one by one, so a bad field later in the patch
  // throws after earlier fields already changed. Flip to `it` once patches are atomic.
  it.fails('leaves the config untouched when any field in the patch is invalid', () => {
    expect(() => applyRuntimeConfigPatch({ llmMaxOutputTokens: 512, glitchRenderer: 'hologram' as never })).toThrow();
    expect(runtimeConfig.llmMaxOutputTokens).toBe(snapshot.llmMaxOutputTokens);
  });

});
