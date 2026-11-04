import { describe, expect, it } from 'vitest';
import type { AppState } from '../state/app-state.js';
import { parseScriptPayload, parseSingleBeat } from './manual-beats.js';

// What an operator types mid-show must become a valid beat script, or a
// clear error in the panel; never a half-formed turn sent to the heads.

const form = (overrides: Partial<AppState>) => ({
  manualActor: 'main', manualAction: 'speak', manualText: '', manualDelay: '', manualExpression: '', manualEmoji: '', ...overrides,
}) as AppState;

describe('parseSingleBeat', () => {
  it('builds a speak beat with emotion and a clamped delay', () => {
    expect(parseSingleBeat(form({ manualText: '  Happy\topening   night ', manualDelay: '50', manualEmoji: '😏', manualExpression: 'Smug' }))).toEqual({
      actor: 'main', action: 'speak', text: 'Happy opening night', delayMs: 120, emotion: { expression: 'smug', emoji: '😏' },
    });
  });

  it('refuses a speak beat with nothing to say, or an emoji the faces cannot show', () => {
    expect(() => parseSingleBeat(form({ manualText: '   ' }))).toThrow(/Text is required/);
    expect(() => parseSingleBeat(form({ manualText: 'Hi.', manualEmoji: '🍕' }))).toThrow(/Unsupported emoji/);
    expect(() => parseSingleBeat(form({ manualText: 'Hi.', manualDelay: 'soon' }))).toThrow(/Delay must be a number/);
  });
});

describe('parseScriptPayload', () => {
  it('accepts a bare array, {beats} or a pasted {turn_script: {beats}}', () => {
    const beats = [{ actor: 'main', action: 'speak', text: 'One.' }];
    expect(parseScriptPayload(JSON.stringify(beats))).toEqual({ beats });
    expect(parseScriptPayload(JSON.stringify({ beats }))).toEqual({ beats });
    expect(parseScriptPayload(JSON.stringify({ turn_script: { beats } }))).toEqual({ beats });
  });

  it('explains what is wrong with a bad paste', () => {
    expect(() => parseScriptPayload('')).toThrow(/empty/);
    expect(() => parseScriptPayload('{beats:')).toThrow(/invalid/);
    expect(() => parseScriptPayload('{"text":"hi"}')).toThrow(/array or include beats/);
  });
});
