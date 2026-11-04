// What the face screen shows besides the face, in perform mode and out of it.
// Saved and shared with the other operator windows (see syncStagePrefs).

import type { JSX } from 'react';
import type { AppStore, MiniTilePlacement, MiniTileSize, StagePrefs } from '../../state/app-state.js';
import { ControlGroup, SelectControl, ToggleControl } from '../panels/controls.js';
import { PanelHeader } from '../panels/PanelHeader.js';
import { useAppSelector } from '../react-store.js';

const PLACEMENTS: Array<{ value: MiniTilePlacement; label: string }> = [
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'top-left', label: 'Top left' },
  { value: 'side', label: 'Side by side' },
];

const SIZES: Array<{ value: MiniTileSize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

export function StageSettings({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({ stage: current.stage }));
  const set = (patch: Partial<StagePrefs>) => store.setState((current) => ({ ...current, stage: { ...current.stage, ...patch } }));

  return (
    <article id="stage-settings" className="dock-section">
      <PanelHeader title="Stage" meta="Perform: Z · Fullscreen: X" />
      <div className="panel-body panel-content flex flex-col gap-3">
        <ControlGroup title="Overlays">
          <ToggleControl label="Subtitles" checked={state.stage.subtitles} onChange={(subtitles) => set({ subtitles })} />
          <ToggleControl label="Floating transcript (T)" checked={state.stage.transcript} onChange={(transcript) => set({ transcript })} />
          <ToggleControl label="Listening dot" checked={state.stage.listening} onChange={(listening) => set({ listening })} />
          <ToggleControl label="Mini tile" checked={state.stage.miniTile} onChange={(miniTile) => set({ miniTile })} />
        </ControlGroup>
        <ControlGroup title="Mini tile">
          <SelectControl label="Placement" value={state.stage.miniPlacement} options={PLACEMENTS} onChange={(miniPlacement) => set({ miniPlacement })} />
          <SelectControl label="Size" value={state.stage.miniSize} options={SIZES} onChange={(miniSize) => set({ miniSize })} />
          <p className="text-[11px] leading-snug text-slate-500">
            Shown while two heads are on and no mini window is open. A hidden tile still voices Small.
          </p>
        </ControlGroup>
      </div>
    </article>
  );
}
