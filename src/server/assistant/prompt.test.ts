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
    expect(prompt).toContain('brevity is the personality');
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

  // Small was defined by attitude ("creepy, mean and funny, with an open,
  // cartoonish threat now and then") and came out as stock threats. It gets
  // techniques that start from what was said, silence as an option, and no
  // example line to copy.
  it('defines Small by what it does with what was just said, not by attitude', () => {
    const prompt = buildDualHeadSystemInstruction();
    expect(prompt).not.toContain('cartoonish threat');
    expect(prompt).toContain('starts from one specific word or detail that was just said');
    expect(prompt).toContain('takes it literally');
    expect(prompt).toContain('Small stays quiet or only reacts');
    expect(prompt).not.toMatch(/"actor":"small","action":"speak"/);
  });

  // The body and "humans" stayed on the stay-off list all night on 9 Nov:
  // the persona itself kept them in front of the model. With the straps still
  // in it, "plastic straps" came back three turns running in a check run.
  it('describes the body once, plainly, and real questions get real answers', () => {
    const prompt = buildAssistantSystemInstruction();
    for (const pull of ['lunchbox', 'questionable engineering', 'cheap computer', 'Your lens is humans', 'ratchet straps']) expect(prompt).not.toContain(pull);
    expect(prompt).toContain('two plastic storage tubs');
    expect(prompt).toContain('A real question gets a real answer');
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

  // The studio dropped the begging-for-wheels story and payments; Tubs must
  // not be told to ask visitors for money in any mode.
  it('never tells Tubs to ask for money or wheels', () => {
    for (const prompt of [buildAssistantSystemInstruction(), buildDualHeadSystemInstruction()]) {
      expect(prompt).not.toMatch(/venmo|donat|SHOW_QR|would like wheels/i);
    }
  });
});

// In the studio the characters know where they are and talk about it in places.
describe('studio context in the system prompt', () => {
  it('is there in studio mode, next to what the camera sees, and not otherwise', async () => {
    const { studioSettings } = await import('../studio/state.js');
    const { noteStudioContext, forgetStudioContext } = await import('../studio/context.js');
    const { buildDualHeadSystemInstruction } = await import('./prompt.js');
    noteStudioContext({ reason: 'turn', heads: { main: { zone: 'cinema', window: 'book', near: true, mode: 'engaged', speaking: false } }, people: [], reference: null, ts: 1 });
    expect(buildDualHeadSystemInstruction('Left: a red coat.')).not.toContain('IN THE STUDIO');
    studioSettings.enabled = true;
    try {
      const prompt = buildDualHeadSystemInstruction('Left: a red coat.');
      expect(prompt).toContain('You speak in places');
      expect(prompt).toContain('through the walls of the otherside');
      expect(prompt).toContain('You are behind the book, next to the cinema.');
      // Right before the camera's description (the persona template mentions that block earlier too).
      expect(prompt.indexOf('IN THE STUDIO')).toBeLessThan(prompt.lastIndexOf('BACKGROUND VISUAL CONTEXT'));
    } finally {
      studioSettings.enabled = false;
      forgetStudioContext();
    }
  });
});
