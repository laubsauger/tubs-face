import type { JSX } from 'react';
import type { AppStore, PanelKey } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';

export function PanelHeader(props: {
  store: AppStore;
  panelKey: PanelKey;
  title: string;
  meta: string;
  metaId?: string;
}): JSX.Element {
  const collapsed = useAppSelector(props.store, (state) => Boolean(state.collapsedPanels[props.panelKey]));
  return (
    <button
      className="panel-header"
      data-panel-toggle={props.panelKey}
      type="button"
      onClick={() => {
        props.store.setState((current) => ({
          ...current,
          collapsedPanels: {
            ...current.collapsedPanels,
            [props.panelKey]: !current.collapsedPanels[props.panelKey],
          },
        }));
      }}
    >
      <span className="panel-title-wrap">
        <h2>{props.title}</h2>
      </span>
      {props.meta && (
        <span id={props.metaId} className="panel-meta">
          {props.meta}
        </span>
      )}
    </button>
  );
}
