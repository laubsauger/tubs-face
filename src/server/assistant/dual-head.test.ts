import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeConfig } from '../config/runtime.js';
import { mergeDonationSignalFromBeats, parseDualHeadScript, rescueBeatsFromRawText } from './dual-head.js';

// Dual-head turns depend on turning loose model output into a playable beat
// script. If parsing fails the whole turn is lost (or costs a repair call), and if
// it is too lenient the heads say JSON, labels or markers out loud.
describe('parseDualHeadScript', () => {
  const originalPolicy = runtimeConfig.dualHeadTurnPolicy;

  afterEach(() => {
    runtimeConfig.dualHeadTurnPolicy = originalPolicy;
  });

  it('parses a well-formed beat script in model order', () => {
    const script = parseDualHeadScript(JSON.stringify({
      beats: [
        { actor: 'main', action: 'speak', text: 'You again?', emoji: '😏' },
        { actor: 'small', action: 'react', emoji: '😄', delayMs: 260 },
        { actor: 'small', action: 'speak', text: 'Bring snacks next time.' },
      ],
    }));
    expect(script?.beats.map((beat) => [beat.actor, beat.action, beat.text ?? null])).toEqual([
      ['main', 'speak', 'You again?'],
      ['small', 'react', null],
      ['small', 'speak', 'Bring snacks next time.'],
    ]);
    expect(script?.beats[0]?.emotion?.emoji).toBe('😏');
    expect(script?.beats[1]?.delayMs).toBe(260);
  });

  it('accepts JSON wrapped in a markdown code fence', () => {
    const script = parseDualHeadScript('```json\n{"beats":[{"actor":"main","action":"speak","text":"Fenced but fine."}]}\n```');
    expect(script?.beats[0]?.text).toBe('Fenced but fine.');
  });

  it('turns a react beat that carries text into a speak beat, so the line is not lost', () => {
    const script = parseDualHeadScript('{"beats":[{"actor":"small","action":"react","text":"Wow."}]}');
    expect(script?.beats[0]).toMatchObject({ actor: 'small', action: 'speak', text: 'Wow.' });
  });

  it('strips speaker labels and formatting from spoken text', () => {
    const script = parseDualHeadScript('{"beats":[{"actor":"main","action":"speak","text":"main: **Absolutely** not."}]}');
    expect(script?.beats[0]?.text).toBe('Absolutely not.');
  });

  it('clamps beat delays to the 120-2500 ms window', () => {
    const script = parseDualHeadScript(JSON.stringify({
      beats: [
        { actor: 'main', action: 'speak', text: 'Quick.', delayMs: 5 },
        { actor: 'small', action: 'speak', text: 'Slow.', delayMs: 99999 },
      ],
    }));
    expect(script?.beats.map((beat) => beat.delayMs)).toEqual([120, 2500]);
  });

  it('caps the script at 7 beats', () => {
    const beats = Array.from({ length: 10 }, (_value, index) => ({ actor: 'main', action: 'speak', text: `Line ${index}.` }));
    expect(parseDualHeadScript(JSON.stringify({ beats }))?.beats).toHaveLength(7);
  });

  it('rejects a script with no spoken line', () => {
    expect(parseDualHeadScript('{"beats":[{"actor":"small","action":"react","emoji":"😄"}]}')).toBeNull();
    expect(parseDualHeadScript('not json at all')).toBeNull();
  });

  it('applies the main_first turn policy', () => {
    runtimeConfig.dualHeadTurnPolicy = 'main_first';
    const script = parseDualHeadScript(JSON.stringify({
      beats: [
        { actor: 'small', action: 'speak', text: 'Me first.' },
        { actor: 'main', action: 'speak', text: 'No, me.' },
      ],
    }));
    expect(script?.beats.map((beat) => beat.actor)).toEqual(['main', 'small']);
  });
});

describe('rescueBeatsFromRawText', () => {
  it('recovers beats from truncated JSON so the turn is not lost', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const truncated = '{"beats":[{"actor":"main","action":"speak","text":"Nice jacket."},{"actor":"small","action":"speak","text":"Stolen, probably."';
    expect(parseDualHeadScript(truncated)).toBeNull();
    const rescued = rescueBeatsFromRawText(truncated);
    expect(rescued?.beats.map((beat) => [beat.actor, beat.text])).toEqual([
      ['main', 'Nice jacket.'],
      ['small', 'Stolen, probably.'],
    ]);
  });

  it('recovers "main:" / "small:" lines when the model ignores JSON entirely', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const rescued = rescueBeatsFromRawText('main: You look lost.\nsmall: Or hungry.');
    expect(rescued?.beats.map((beat) => [beat.actor, beat.text])).toEqual([
      ['main', 'You look lost.'],
      ['small', 'Or hungry.'],
    ]);
  });
});

describe('mergeDonationSignalFromBeats', () => {
  it('raises one QR signal for the turn and keeps the marker out of every spoken line', () => {
    const script = parseDualHeadScript(JSON.stringify({
      beats: [
        { actor: 'main', action: 'speak', text: 'Fund my wheels. [[SHOW_QR]]' },
        { actor: 'small', action: 'speak', text: 'Please.' },
      ],
    }));
    const merged = mergeDonationSignalFromBeats(script!.beats);
    expect(merged.donation.show).toBe(true);
    expect(merged.beats.map((beat) => beat.text)).toEqual(['Fund my wheels.', 'Please.']);
    expect(JSON.stringify(merged.beats)).not.toMatch(/SHOW_QR|_hadDonationMarker/);
  });
});
