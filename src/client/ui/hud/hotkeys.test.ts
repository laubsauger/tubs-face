import { describe, expect, it } from 'vitest';
import { SHORTCUT_KEYS, resolveHotkey, type HotkeyContext } from './hotkeys.js';

const base: HotkeyContext = {
  key: 'a',
  code: 'KeyA',
  modifier: false,
  inTextField: false,
  view: 'face',
  fxOpen: false,
  perform: false,
  chatInputVisible: true,
};
const press = (key: string, ctx: Partial<HotkeyContext> = {}) => resolveHotkey({ ...base, key, ...ctx });

// An operator should be able to just start typing to Tubs, wherever the dock is.
describe('typing reaches a chat input', () => {
  it('goes to the dock chat input while the Chat tab is open', () => {
    expect(press('h')).toBe('focus-chat');
  });

  it('reaches the floating transcript input when the dock is folded or on another tab', () => {
    expect(press('h', { chatInputVisible: false })).toBe('focus-quick');
    expect(press('Enter', { chatInputVisible: false })).toBe('focus-quick');
  });

  it('reaches the chat input from the FX tab, where letters used to be swallowed', () => {
    expect(press('h', { fxOpen: true, chatInputVisible: false })).toBe('focus-quick');
  });

  it('goes to the chat column on the dashboard', () => {
    expect(press('h', { view: 'dashboard', chatInputVisible: false })).toBe('focus-chat');
  });

  it('pops nothing up on the audience screen in perform mode', () => {
    expect(press('h', { perform: true, chatInputVisible: false })).toBeNull();
  });

  it('leaves keys alone while the operator types or uses a modifier', () => {
    expect(press('h', { inTextField: true })).toBeNull();
    expect(press('m', { inTextField: true })).toBeNull();
    expect(press('c', { modifier: true })).toBeNull();
  });

  it('never steals a shortcut letter for typing', () => {
    for (const key of SHORTCUT_KEYS) {
      expect(press(key)).not.toBe('focus-chat');
      expect(press(key, { chatInputVisible: false })).not.toBe('focus-quick');
    }
  });
});

describe('shortcuts', () => {
  it('keeps the existing single-key shortcuts', () => {
    expect(press('e')).toBe('fx-toggle');
    expect(press('m')).toBe('mute');
    expect(press('s')).toBe('sleep-toggle');
    expect(press('c')).toBe('camera');
    expect(press('f')).toBe('enroll');
    expect(press('d')).toBe('debug');
    expect(press('x')).toBe('fullscreen');
    expect(press('Z')).toBe('perform-toggle');
    expect(press('o')).toBe('open-mini');
  });

  it('adds T for the floating transcript and backtick for the dock', () => {
    expect(press('t')).toBe('transcript-toggle');
    expect(press('`', { code: 'Backquote' })).toBe('dock-fold');
    // Layouts where backtick is a dead key still have the physical key.
    expect(press('Dead', { code: 'Backquote' })).toBe('dock-fold');
  });

  it('lets the other shortcuts work while the FX tab is open, since the face stays visible', () => {
    expect(press('m', { fxOpen: true })).toBe('mute');
    expect(press('z', { fxOpen: true })).toBe('perform-toggle');
  });

  it('closes the FX editor with Escape before it ever sleeps the face', () => {
    expect(press('Escape', { fxOpen: true })).toBe('fx-close');
    expect(press('Escape')).toBe('sleep-toggle');
    expect(press('Escape', { inTextField: true })).toBe('sleep-toggle');
  });

  it('drops face-window shortcuts on the dashboard, which has no face of its own', () => {
    for (const key of ['f', 't', 'x', 'z', 'o']) {
      expect(press(key, { view: 'dashboard' })).toBeNull();
    }
    expect(press('m', { view: 'dashboard' })).toBe('mute');
    expect(press('e', { view: 'dashboard' })).toBe('fx-toggle');
  });
});
