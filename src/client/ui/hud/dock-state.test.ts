import { describe, expect, it } from 'vitest';
import { createAppStore, parseStagePrefs, parseUiPrefs, persistedDockTab, type AppState } from '../../state/app-state.js';
import { applyFxEditorVisibility, clampDockWidth, clickDockTab, closeFxTab, dockTabsFor, isFxEditorVisible, toggleDockFolded, toggleFxTab } from './dock-state.js';

function state(fields: Partial<AppState> = {}): AppState {
  return { ...createAppStore().getState(), ...fields };
}

describe('dock tabs', () => {
  it('opens a clicked tab and unfolds the dock to show it', () => {
    const next = clickDockTab(state({ dockTab: 'chat', dockFolded: true }), 'mind');
    expect([next.dockTab, next.dockFolded]).toEqual(['mind', false]);
  });

  it('folds the dock when the open tab is clicked again', () => {
    expect(clickDockTab(state({ dockTab: 'mind' }), 'mind').dockFolded).toBe(true);
  });

  it('unfolds on the same tab rather than folding again when folded', () => {
    const next = clickDockTab(state({ dockTab: 'mind', dockFolded: true }), 'mind');
    expect([next.dockTab, next.dockFolded]).toEqual(['mind', false]);
  });

  it('folds and unfolds with backtick without losing the tab', () => {
    const folded = toggleDockFolded(state({ dockTab: 'stats' }));
    expect([folded.dockTab, folded.dockFolded]).toEqual(['stats', true]);
    expect(toggleDockFolded(folded).dockFolded).toBe(false);
  });

  it('has no Chat tab on the dashboard, where the chat log has its own column', () => {
    expect(dockTabsFor('dashboard')).not.toContain('chat');
    expect(dockTabsFor('face')).toContain('chat');
  });
});

// The FX editor is a tab now, so the face stays visible while editing. E and
// Escape must still get the operator back to exactly where they were.
describe('FX tab', () => {
  it('E opens FX from a folded dock and E again returns to the tab and fold from before', () => {
    const opened = toggleFxTab(state({ dockTab: 'people', dockFolded: true }));
    expect(isFxEditorVisible(opened)).toBe(true);
    const closed = toggleFxTab(opened);
    expect([closed.dockTab, closed.dockFolded]).toEqual(['people', true]);
  });

  it('E in perform mode shows the editor, and closing it goes back to perform mode', () => {
    const opened = toggleFxTab(state({ uiHidden: true, dockTab: 'chat' }));
    expect([opened.uiHidden, isFxEditorVisible(opened)]).toEqual([false, true]);
    expect(closeFxTab(opened).uiHidden).toBe(true);
  });

  it('Escape does nothing to the dock when FX is not the open tab', () => {
    const current = state({ dockTab: 'log' });
    expect(closeFxTab(current)).toBe(current);
  });

  it('only counts as open while the tab is on screen, so a folded FX tab lets the face sleep and show its mood', () => {
    expect(isFxEditorVisible(state({ dockTab: 'fx' }))).toBe(true);
    expect(isFxEditorVisible(state({ dockTab: 'fx', dockFolded: true }))).toBe(false);
    expect(isFxEditorVisible(state({ dockTab: 'fx', uiHidden: true }))).toBe(false);
  });

  it('previews the chosen expression while open and hands back to idle on close', () => {
    const open = applyFxEditorVisibility(state({ dockTab: 'fx', fxExpressionSelected: 'angry' }));
    expect([open.fxEditorOpen, open.currentExpression]).toEqual([true, 'angry']);
    const closed = applyFxEditorVisibility({ ...open, dockTab: 'chat' });
    expect([closed.fxEditorOpen, closed.currentExpression]).toEqual([false, 'idle']);
  });

  it('is never saved as the open tab, so a reload never boots into the editor', () => {
    const opened = toggleFxTab(state({ dockTab: 'mind' }));
    expect(persistedDockTab(opened)).toBe('mind');
  });
});

describe('dock width', () => {
  it('stays usable and always leaves the face room', () => {
    expect(clampDockWidth(100, 1280)).toBe(300);
    expect(clampDockWidth(2000, 1280)).toBe(760);
    expect(clampDockWidth(2000, 900)).toBe(580);
  });
});

describe('stored prefs', () => {
  it('ignores broken or unknown values instead of booting into a bad layout', () => {
    expect(parseUiPrefs({ dockTab: 'nope', dockFolded: 'yes', dockWidth: Number.NaN, uiHidden: true })).toEqual({ uiHidden: true });
    expect(parseStagePrefs({ subtitles: false, miniPlacement: 'center', miniSize: 'large' })).toMatchObject({
      subtitles: false,
      transcript: true,
      miniPlacement: 'bottom-right',
      miniSize: 'large',
    });
  });
});
