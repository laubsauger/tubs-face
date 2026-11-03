import { afterEach, describe, expect, it } from 'vitest';
import { runtimeConfig } from '../config/runtime.js';
import { buildAssistantSystemInstruction, buildDualHeadSystemInstruction } from './prompt.js';

// src/persona/system-prompt.md uses {{PLACEHOLDER}} slots for the persona sections.
// If a slot reaches the model unfilled, that whole section (character, brevity,
// output format) is silently missing and the model sees raw template scaffolding.
describe('system instructions built from the persona template', () => {
  const originalPrompt = runtimeConfig.prompt;

  afterEach(() => {
    runtimeConfig.prompt = originalPrompt;
  });

  it.each([
    ['single', buildAssistantSystemInstruction],
    ['dual-head', buildDualHeadSystemInstruction],
  ])('%s mode sends no unfilled placeholders', (_mode, build) => {
    expect(build()).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('single mode carries the solo persona, the brevity rule and plain-text output rules', () => {
    const prompt = buildAssistantSystemInstruction();
    expect(prompt).toContain('Standup social critic energy');
    expect(prompt).toContain('Brevity IS the personality');
    expect(prompt).toContain('# OUTPUT FORMAT (Text Only)');
    expect(prompt).toContain('Plain text only.');
  });

  it('dual-head mode describes both heads and demands JSON beats', () => {
    const prompt = buildDualHeadSystemInstruction();
    expect(prompt).toContain('(Dual-Head Mode)');
    expect(prompt).toContain('Main (Voice A)');
    expect(prompt).toContain('Small (Voice B)');
    expect(prompt).toContain('# OUTPUT FORMAT (STRICT JSON ONLY)');
    expect(prompt).toContain('"beats" array');
  });

  it('adds an operator prompt override, but not the default placeholder value', () => {
    runtimeConfig.prompt = 'Talk like a pirate.';
    expect(buildAssistantSystemInstruction()).toContain('# ADDITIONAL INSTRUCTION\nTalk like a pirate.');

    runtimeConfig.prompt = 'Default personality';
    expect(buildAssistantSystemInstruction()).not.toContain('ADDITIONAL INSTRUCTION');
  });

  it('appends visual context after the persona and tells Tubs it can see', () => {
    const prompt = buildAssistantSystemInstruction('red hoodie, holding coffee');
    expect(prompt.endsWith('BACKGROUND VISUAL CONTEXT:\nred hoodie, holding coffee')).toBe(true);
    expect(prompt).toContain('A camera shows you the person in front of you');
    expect(prompt).not.toContain('camera is off');
  });

  // With the camera off, the old always-on vision rules made Tubs roast "that
  // jacket" it had never seen.
  it('tells Tubs it cannot see when there is no camera description', () => {
    for (const prompt of [buildAssistantSystemInstruction(), buildDualHeadSystemInstruction()]) {
      expect(prompt).toContain('Your camera is off right now');
      expect(prompt).not.toContain('BACKGROUND VISUAL CONTEXT');
    }
  });
});
