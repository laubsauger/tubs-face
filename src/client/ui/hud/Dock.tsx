// The operator dock beside the face: one tab open at a time, folds to an icon
// rail, resizable. Every tab stays mounted while hidden: the People tab holds
// the camera <video> the face runtime reads, and a <video> taken out of the
// document stops playing.

import { useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import type { AppStore, DockTab } from '../../state/app-state.js';
import type { AppShellControls } from '../app-shell.js';
import { ChatPanel } from '../panels/ChatPanel.js';
import { ConnectionPanel } from '../panels/ConnectionPanel.js';
import { ControlsPanel } from '../panels/ControlsPanel.js';
import { EventLogPanel } from '../panels/EventLogPanel.js';
import { FacePanel } from '../panels/FacePanel.js';
import { PeopleNotesPanel } from '../panels/FieldNotes.js';
import { FxEditor } from '../panels/FxEditor.js';
import { ManualPanel } from '../panels/ManualPanel.js';
import { MemoryPanel } from '../panels/MemoryPanel.js';
import { MindPanel } from '../panels/MindPanel.js';
import { StatsPanel } from '../panels/StatsPanel.js';
import { StudioPanel } from '../panels/StudioPanel.js';
import { VoicePanel } from '../panels/VoicePanel.js';
import { useAppSelector } from '../react-store.js';
import { DEFAULT_DOCK_WIDTH, DOCK_TAB_LABELS, clampDockWidth, clickDockTab, dockTabsFor } from './dock-state.js';
import { DockIcon } from './icons.js';
import { StageSettings } from './StageSettings.js';

export function Dock({ store, controls, view, defaultWidth = DEFAULT_DOCK_WIDTH }: {
  store: AppStore;
  controls?: AppShellControls | undefined;
  view: 'face' | 'dashboard';
  defaultWidth?: number;
}): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    tab: current.dockTab,
    folded: current.dockFolded,
    width: current.dockWidth,
    errorCount: current.logs.filter((entry) => entry.level === 'error').length,
  }));
  const paneRef = useRef<HTMLDivElement | null>(null);
  const tabs = dockTabsFor(view);
  const width = clampDockWidth(state.width ?? defaultWidth, typeof window === 'undefined' ? 1600 : window.innerWidth);

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = paneRef.current?.getBoundingClientRect().width ?? width;
    const handleMove = (move: PointerEvent) => {
      // The dock grows to the left, away from the rail.
      const next = clampDockWidth(startWidth + (startX - move.clientX), window.innerWidth);
      store.setState((current) => ({ ...current, dockWidth: next }));
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
  }

  return (
    <aside className={`dock ${state.folded ? 'is-folded' : ''}`} aria-label="Operator dock">
      <div ref={paneRef} className="dock-pane" style={{ width }} hidden={state.folded}>
        <div
          className="dock-resize"
          title="Drag to resize · double-click to reset"
          aria-hidden="true"
          onPointerDown={handleResizeStart}
          onDoubleClick={() => store.setState((current) => ({ ...current, dockWidth: null }))}
        />
        {tabs.map((tab) => (
          <section
            key={tab}
            id={`dock-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`dock-tab-${tab}`}
            className="dock-tabpanel"
            hidden={tab !== state.tab}
          >
            <DockTabContent tab={tab} store={store} controls={controls} />
          </section>
        ))}
      </div>

      <nav className="dock-rail" role="tablist" aria-orientation="vertical" aria-label="Dock tabs">
        {tabs.map((tab) => {
          const selected = tab === state.tab && !state.folded;
          return (
            <button
              key={tab}
              id={`dock-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`dock-panel-${tab}`}
              className={`dock-rail-tab ${selected ? 'is-active' : ''}`}
              title={tab === 'fx' ? 'FX editor (E)' : DOCK_TAB_LABELS[tab]}
              onClick={() => store.setState((current) => clickDockTab(current, tab))}
            >
              <DockIcon tab={tab} />
              <span className="dock-rail-label">{DOCK_TAB_LABELS[tab]}</span>
              {tab === 'log' && state.errorCount > 0 ? <span className="dock-rail-badge" aria-label={`${state.errorCount} errors`}>{state.errorCount}</span> : null}
            </button>
          );
        })}
        <button
          type="button"
          className="dock-rail-fold"
          title={state.folded ? 'Unfold the dock (`)' : 'Fold the dock (`)'}
          aria-label={state.folded ? 'Unfold the dock' : 'Fold the dock'}
          onClick={() => store.setState((current) => ({ ...current, dockFolded: !current.dockFolded }))}
        >
          {state.folded ? '‹' : '›'}
        </button>
      </nav>
    </aside>
  );
}

function DockTabContent({ tab, store, controls }: { tab: DockTab; store: AppStore; controls?: AppShellControls | undefined }): JSX.Element {
  switch (tab) {
    case 'chat':
      return <ChatPanel store={store} />;
    case 'studio':
      return <StudioPanel store={store} />;
    case 'voice':
      return <VoicePanel store={store} controls={controls} />;
    case 'mind':
      return <MindPanel store={store} />;
    case 'people':
      return (
        <>
          <FacePanel store={store} {...(controls?.face ? { controls: controls.face } : {})} />
          <PeopleNotesPanel store={store} />
        </>
      );
    case 'memory':
      return <MemoryPanel store={store} />;
    case 'controls':
      return (
        <>
          <ControlsPanel store={store} {...(controls ? { controls } : {})} />
          <ManualPanel store={store} />
        </>
      );
    case 'stats':
      return <StatsPanel store={store} />;
    case 'log':
      return <EventLogPanel store={store} />;
    case 'settings':
      return (
        <>
          <StageSettings store={store} />
          <ConnectionPanel store={store} />
        </>
      );
    case 'fx':
      return <FxEditor store={store} />;
  }
}
