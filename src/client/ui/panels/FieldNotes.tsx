// Tubs's field notes on whoever is in view (the server's field_notes): the
// Mind tab and the People tab show the same list.

import type { JSX } from 'react';
import type { AppState, AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';

const POSITION_LABELS = { left: 'Left', center: 'Middle', right: 'Right' } as const;

/** Notes per person in view, the group's, and what was overheard tonight. `idPrefix` names the sections (`mind-notes`, `mind-quotes`). */
export function FieldNotesList({ notes, idPrefix }: { notes: AppState['fieldNotes']; idPrefix: string }): JSX.Element {
  return (
    <section id={`${idPrefix}-notes`} className="flex flex-col gap-1 font-mono text-xs" aria-label="Field notes">
      <div className="text-slate-500 uppercase tracking-wider text-[10px]">Field notes</div>
      {notes.people.length === 0 && <p className="text-slate-500">Nobody in view.</p>}
      {notes.people.map((person) => (
        <div key={person.id} className="flex flex-col gap-0.5">
          <div className="text-slate-400">
            {notes.people.length > 1 ? `${POSITION_LABELS[person.position]} · ` : ''}
            {person.names.length > 0 ? person.names.join(', ') : 'stranger'}
            {person.returning ? ' · back again' : ''}
          </div>
          {person.notes.length === 0
            ? <p className="text-slate-500 pl-2">nothing yet</p>
            : <ul className="flex flex-col gap-0.5 text-slate-300 pl-2">{person.notes.map((note) => <li key={note}>· {note}</li>)}</ul>}
        </div>
      ))}
      {notes.groupNotes.length > 0 && (
        <div className="text-slate-400">The group: <span className="text-slate-300">{notes.groupNotes.join('; ')}</span></div>
      )}
      {notes.quotes.length > 0 && (
        <>
          <div className="text-slate-500 uppercase tracking-wider text-[10px] mt-1">Overheard tonight</div>
          <ul id={`${idPrefix}-quotes`} className="flex flex-col gap-0.5 text-slate-400 italic">{notes.quotes.slice(0, 4).map((quote) => <li key={quote}>"{quote}"</li>)}</ul>
        </>
      )}
    </section>
  );
}

/** The People tab: what Tubs has noted about the person in front of him. */
export function PeopleNotesPanel({ store }: { store: AppStore }): JSX.Element {
  const notes = useAppSelector(store, (current) => current.fieldNotes);
  return (
    <article className="dock-section text-left">
      <PanelHeader title="Notes" meta={notes.people.length > 0 ? `${notes.people.length} in view` : ''} />
      <div className="panel-body panel-content">
        <FieldNotesList notes={notes} idPrefix="people" />
      </div>
    </article>
  );
}
