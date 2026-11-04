// Mini Tubs inside the face window, for one-screen shows and recordings: the
// real mini app in an iframe, so it renders and voices Small exactly like the
// mini window does. Gone while a mini window is open anywhere in this browser,
// so Small is never on screen, or heard, twice.

import type { JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { openMiniWindow } from '../window-runtime.js';

export function MiniTile({ store }: { store: AppStore }): JSX.Element | null {
  const state = useAppSelector(store, (current) => ({
    dualOn: Boolean(current.config?.dualHeadEnabled && current.config.dualHeadMode !== 'off'),
    miniWindowOpen: current.peers.mini,
    visible: current.stage.miniTile,
    placement: current.stage.miniPlacement,
    size: current.stage.miniSize,
    perform: current.uiHidden,
  }));

  if (!state.dualOn || state.miniWindowOpen) {
    return null;
  }

  return (
    <div
      id="mini-tile"
      className={`mini-tile mini-tile-${state.placement} mini-tile-${state.size} ${state.visible ? '' : 'is-concealed'} ${state.perform ? 'is-perform' : ''}`}
    >
      {/* Stays loaded while concealed: hiding the tile must not silence Small. */}
      <iframe className="mini-tile-frame" src="/app-mini.html?embed=1" title="Mini Tubs" allow="autoplay" />
      {state.perform ? null : (
        <div className="mini-tile-bar">
          <span>Mini</span>
          <button id="mini-tile-popout" type="button" title="Open mini Tubs in its own window, e.g. for a second screen" onClick={() => openMiniWindow(store, true)}>
            Pop out
          </button>
        </div>
      )}
    </div>
  );
}
