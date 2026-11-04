// Which dock tab is open, folding, and the FX editor's place among the tabs.
// Pure state transitions, so the rules can be tested without a browser.

import { DOCK_TABS, type AppState, type DockTab } from '../../state/app-state.js';

type DockSlice = Pick<AppState, 'dockTab' | 'dockFolded' | 'dockReturn' | 'uiHidden'>;

export const DOCK_TAB_LABELS: Record<DockTab, string> = {
  chat: 'Chat',
  voice: 'Voice',
  mind: 'Mind',
  people: 'People',
  controls: 'Controls',
  stats: 'Stats',
  log: 'Log',
  settings: 'Settings',
  fx: 'FX',
};

export const DEFAULT_DOCK_WIDTH = 380;
const MIN_DOCK_WIDTH = 300;
const MAX_DOCK_WIDTH = 760;
// The face keeps at least this much of the window next to the dock.
const MIN_STAGE_WIDTH = 320;

/** Opens a tab, unfolding the dock. Entering FX remembers where to go back to. */
export function openDockTab<S extends DockSlice>(state: S, tab: DockTab): S {
  const enteringFx = tab === 'fx' && state.dockTab !== 'fx';
  const visible = !state.dockFolded && !state.uiHidden;
  if (visible && state.dockTab === tab) return state;
  return {
    ...state,
    dockTab: tab,
    dockFolded: false,
    uiHidden: false,
    dockReturn: enteringFx
      ? { tab: state.dockTab, folded: state.dockFolded, uiHidden: state.uiHidden }
      : state.dockReturn,
  };
}

/** A rail click: another tab opens, the open tab's own icon folds the dock. */
export function clickDockTab<S extends DockSlice>(state: S, tab: DockTab): S {
  if (state.dockTab === tab && !state.dockFolded) {
    return { ...state, dockFolded: true };
  }
  return openDockTab(state, tab);
}

export function toggleDockFolded<S extends DockSlice>(state: S): S {
  return { ...state, dockFolded: !state.dockFolded };
}

/** E: open the FX tab, or close it again. */
export function toggleFxTab<S extends DockSlice>(state: S): S {
  return isFxEditorVisible(state) ? closeFxTab(state) : openDockTab(state, 'fx');
}

/** Escape and the editor's Close button: back to the tab, fold and mode from before FX. */
export function closeFxTab<S extends DockSlice>(state: S): S {
  if (state.dockTab !== 'fx') return state;
  const back = state.dockReturn;
  return {
    ...state,
    dockTab: back.tab === 'fx' ? 'chat' : back.tab,
    dockFolded: back.folded,
    uiHidden: back.uiHidden,
  };
}

/** The FX editor is live only while its tab is actually on screen. */
export function isFxEditorVisible(state: Pick<AppState, 'dockTab' | 'dockFolded' | 'uiHidden'>): boolean {
  return state.dockTab === 'fx' && !state.dockFolded && !state.uiHidden;
}

/**
 * Keeps fxEditorOpen in step with the FX tab. While open the face previews the
 * chosen expression; on close it goes back to idle (or sleep).
 */
export function applyFxEditorVisibility(state: AppState): AppState {
  const visible = isFxEditorVisible(state);
  if (visible === state.fxEditorOpen) return state;
  return {
    ...state,
    fxEditorOpen: visible,
    currentExpression: visible ? state.fxExpressionSelected : (state.sleeping ? 'sleep' : 'idle'),
  };
}

export function clampDockWidth(width: number, viewportWidth: number): number {
  const max = Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, viewportWidth - MIN_STAGE_WIDTH));
  return Math.round(Math.max(MIN_DOCK_WIDTH, Math.min(max, width)));
}

/** The dashboard shows the chat log beside the dock, so it has no Chat tab. */
export function dockTabsFor(view: 'face' | 'dashboard'): DockTab[] {
  return view === 'dashboard' ? DOCK_TABS.filter((tab) => tab !== 'chat') : [...DOCK_TABS];
}
