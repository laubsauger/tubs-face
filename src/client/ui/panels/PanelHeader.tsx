import type { JSX } from 'react';

/** Title row of a docked panel; the dock's tabs do the showing and hiding. */
export function PanelHeader(props: {
  title: string;
  meta: string;
  metaId?: string;
}): JSX.Element {
  return (
    <header className="panel-header">
      <h2>{props.title}</h2>
      {props.meta && (
        <span id={props.metaId} className="panel-meta">
          {props.meta}
        </span>
      )}
    </header>
  );
}
