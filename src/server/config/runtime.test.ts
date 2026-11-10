import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROPS } from '../../shared/contracts/config.js';
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
    applyRuntimeConfigPatch({ renderQuality: 'low', llmMaxOutputTokens: 512 });
    expect(runtimeConfig.renderQuality).toBe('low');
    expect(runtimeConfig.llmMaxOutputTokens).toBe(512);
  });

  // The operator flips it from the Voice panel mid-session; it must stick, and
  // start off (with speakers the mic hears Tubs, who would cut himself off).
  it('turns Interruptible on and off, and starts off', () => {
    expect(snapshot.interruptible).toBe(false);
    applyRuntimeConfigPatch({ interruptible: true });
    expect(runtimeConfig.interruptible).toBe(true);
    applyRuntimeConfigPatch({ interruptible: false });
    expect(runtimeConfig.interruptible).toBe(false);
  });

  // The director and the panel pick what each head wears by id. Main starts
  // bare and Small in its propeller cap (the user's pick for Small's look), and
  // a typo must say which ids exist rather than quietly leave the old hat on.
  it('takes a prop per head, starts Main bare and Small in the propeller cap, and rejects an unknown one naming the valid ids', () => {
    expect(snapshot).toMatchObject({ propMain: 'none', propSmall: 'propeller-cap' });
    applyRuntimeConfigPatch({ propMain: 'top-hat', propSmall: 'crown' });
    expect(runtimeConfig).toMatchObject({ propMain: 'top-hat', propSmall: 'crown' });
    let error: unknown;
    try {
      applyRuntimeConfigPatch({ propSmall: 'sombrero' as never });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ name: 'BadRequestError', message: `propSmall must be one of: ${PROPS.join(', ')}` });
    expect(runtimeConfig.propSmall).toBe('crown');
  });

  it('rejects an unknown enum value with a BadRequestError', () => {
    expect(() => applyRuntimeConfigPatch({ renderQuality: 'hologram' as never })).toThrow(/renderQuality must be one of/);
    expect(runtimeConfig.renderQuality).toBe(snapshot.renderQuality);
  });

  it('keeps the old value when a number is out of range', () => {
    applyRuntimeConfigPatch({ llmMaxOutputTokens: 99999 });
    expect(runtimeConfig.llmMaxOutputTokens).toBe(snapshot.llmMaxOutputTokens);
  });

  // Known bug: fields are applied one by one, so a bad field later in the patch
  // throws after earlier fields already changed. Flip to `it` once patches are atomic.
  it.fails('leaves the config untouched when any field in the patch is invalid', () => {
    expect(() => applyRuntimeConfigPatch({ llmMaxOutputTokens: 512, renderQuality: 'hologram' as never })).toThrow();
    expect(runtimeConfig.llmMaxOutputTokens).toBe(snapshot.llmMaxOutputTokens);
  });

});

// Applying the built-in character must give Small its propeller cap back
// (the user's pick for Small's look), and leave Main bare.
describe('built-in Tubs preset look', () => {
  it('puts Small in the propeller cap and Main in nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const preset = JSON.parse(readFileSync(new URL('../../../config/presets/tubs.json', import.meta.url), 'utf8')) as { look: Record<string, unknown> };
    expect(preset.look).toMatchObject({ propMain: 'none', propSmall: 'propeller-cap' });
  });
});
