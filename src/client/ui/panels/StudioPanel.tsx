// The one place to run Tubs in the studio: studio mode, mic and vision
// sources, the vision provider, each head's stream, character presets and the
// relationships. The sentient-studio panel embeds this dashboard in an iframe
// (another origin), so everything here is plain same-origin HTTP to this
// server, and nothing relies on browser dialogs.

import { useCallback, useEffect, useState, type JSX } from 'react';
import { VISION_PROVIDERS, type VisionProvider } from '../../../shared/contracts/config.js';
import type { PresetsResponse } from '../../../shared/contracts/presets.js';
import type { StudioResponse, StudioSource, StudioSourcesResponse } from '../../../shared/contracts/studio.js';
import { patchConfig } from '../../fx/runtime.js';
import type { AppStore } from '../../state/app-state.js';
import { fetchJson, postJson } from '../../transport/http.js';
import { useAppSelector } from '../react-store.js';
import { ControlGroup, SelectControl, ToggleControl } from './controls.js';
import { PanelHeader } from './PanelHeader.js';

export const STUDIO_REFRESH_MS = 2000;
/** The pick lists' sources (GET /studio/sources) ask the site node and the hub, so less often. */
export const SOURCES_REFRESH_MS = 5000;

interface Relationship {
  name: string;
  attitude: string;
}

export function StudioPanel({ store }: { store: AppStore }): JSX.Element {
  const active = useAppSelector(store, (current) => current.dockTab === 'studio' && !current.dockFolded && !current.uiHidden);
  const config = useAppSelector(store, (current) => ({
    loaded: Boolean(current.config),
    visionProvider: current.config?.visionProvider ?? 'gemini',
    visionModel: current.config?.visionModel ?? '',
    visionBaseUrl: current.config?.visionBaseUrl ?? '',
    relationshipsEnabled: current.config?.relationshipsEnabled ?? true,
  }));
  const [studio, setStudio] = useState<StudioResponse | null>(null);
  const [presets, setPresets] = useState<PresetsResponse | null>(null);
  const [sources, setSources] = useState<StudioSourcesResponse | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const [nextStudio, nextPresets] = await Promise.all([fetchJson<StudioResponse>('/studio'), fetchJson<PresetsResponse>('/presets')]);
      setStudio(nextStudio);
      setPresets(nextPresets);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  const loadSources = useCallback(async () => {
    // A server without the route still has the typed fields.
    setSources(await fetchJson<StudioSourcesResponse>('/studio/sources').catch(() => null));
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void load();
    const timer = window.setInterval(() => void load(), STUDIO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (!active) return undefined;
    void loadSources();
    const timer = window.setInterval(() => void loadSources(), SOURCES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, loadSources]);

  async function run(action: () => Promise<unknown>, done?: string): Promise<void> {
    try {
      await action();
      setError('');
      if (done) setNote(done);
      await load();
    } catch (failure) {
      setNote('');
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  const heads = studio?.actors ?? [];
  const meta = !studio ? '' : studio.enabled ? `on · ${heads.filter((head) => head.publishing).length}/${heads.length} publishing` : 'off';

  return (
    <article className="dock-section text-left studio-panel" aria-label="Studio">
      <PanelHeader title="Studio" meta={meta} metaId="studio-panel-meta" />
      <div className="panel-body panel-content flex flex-col gap-3 font-mono text-xs">
        {error && <p role="alert" className="text-rose-300">{error}</p>}
        {note && !error && <p role="status" className="text-emerald-300">{note}</p>}

        <ControlGroup title="Studio mode">
          <ToggleControl
            label="Studio mode"
            checked={studio?.enabled ?? false}
            onChange={(enabled) => void run(() => postJson('/studio', { enabled }), enabled ? 'Studio mode on' : 'Studio mode off')}
          />
          <ul className="flex flex-col gap-1" aria-label="Heads">
            {heads.map((head) => (
              <li key={head.id} className="flex flex-wrap gap-x-2">
                <span className="text-slate-300">{head.id === 'main' ? 'Tubs' : 'Small'}</span>
                <span className="text-slate-500">{head.stream}</span>
                {head.publishing
                  ? <span className="text-emerald-300">publishing</span>
                  : <span className="text-rose-300">{head.error ?? 'not publishing'}</span>}
              </li>
            ))}
            {studio?.enabled && studio.mic && (
              <li className="flex flex-wrap gap-x-2">
                <span className="text-slate-300">Mic</span>
                <span className="text-slate-500">{studio.mic.source}</span>
                {studio.mic.listening ? <span className="text-emerald-300">listening</span> : <span className="text-slate-400">{studio.mic.error ?? 'not listening'}</span>}
              </li>
            )}
          </ul>
          {studio?.ui && (
            <p className="flex flex-wrap gap-3">
              <a className="text-cyan-300 underline" href={studio.ui.memory} target="_blank" rel="noreferrer">Memory view</a>
            </p>
          )}
        </ControlGroup>

        {studio && (
          <ControlGroup title="Sources">
            <SourcePicker
              key={`mic|${studio.micSource}`}
              label="Mic source"
              current={studio.micSource}
              sources={sources?.mic ?? []}
              suggested={sources?.suggested.mic}
              hint="local:<device> · site:<path>"
              onPick={(micSource) => void run(async () => { await postJson('/studio', { micSource }); await loadSources(); }, `Mic: ${micSource}`)}
            />
            <SourcePicker
              key={`vision|${studio.visionSource}`}
              label="Vision source"
              current={studio.visionSource}
              sources={sources?.vision ?? []}
              suggested={sources?.suggested.vision}
              hint="local:<camera> · site:<path> · snapshot:<url>"
              onPick={(visionSource) => void run(async () => { await postJson('/studio', { visionSource }); await loadSources(); }, `Vision: ${visionSource}`)}
            />
            {sources?.problems.map((problem) => <p key={problem} className="text-amber-300">{problem}</p>)}
          </ControlGroup>
        )}

        <ControlGroup title="Vision">
          <SelectControl<VisionProvider>
            label="Provider"
            value={config.visionProvider}
            options={VISION_PROVIDERS}
            onChange={(visionProvider) => void patchConfig(store, { visionProvider })}
          />
          {config.loaded && (
            <VisionModelForm
              key={`${config.visionModel}|${config.visionBaseUrl}`}
              model={config.visionModel}
              baseUrl={config.visionBaseUrl}
              onApply={(patch) => void patchConfig(store, patch)}
            />
          )}
        </ControlGroup>

        <PresetsSection presets={presets} onApply={(name) => void run(() => postJson('/presets/apply', { name }), `${name} applied`)} onSave={(name) => void run(() => postJson('/presets', { name }), `Saved as ${name}`)} />

        <ControlGroup title="Relationships">
          <ToggleControl
            label="Relationships"
            checked={config.relationshipsEnabled}
            onChange={(relationshipsEnabled) => void patchConfig(store, { relationshipsEnabled })}
          />
          <RelationshipsEditor />
        </ControlGroup>
      </div>
    </article>
  );
}

const SOURCE_GROUPS: Array<{ label: string; kind: StudioSource['kind'] }> = [
  { label: "This Mac's devices", kind: 'local' },
  { label: 'Site streams', kind: 'site' },
  { label: 'Snapshots', kind: 'snapshot' },
];

/**
 * One source: a pick list of what the server found (choosing posts it at once),
 * the one obvious pick as a button, and a typed value as the override.
 */
function SourcePicker({ label, current, sources, suggested, hint, onPick }: {
  label: string;
  current: string;
  sources: StudioSource[];
  suggested?: StudioSource | undefined;
  hint: string;
  onPick(value: string): void;
}): JSX.Element {
  const [typed, setTyped] = useState(current);
  const known = sources.find((source) => source.value === current);
  const state = !known ? 'unknown' : known.ready ? 'ready' : 'down';
  const optionText = (source: StudioSource) => `${source.ready ? '●' : '○'} ${source.label}${source.tracks?.length ? ` · ${source.tracks.join(' ')}` : ''}`;
  return (
    <div className="flex flex-col gap-1" role="group" aria-label={label}>
      <span className="text-slate-400">{label}</span>
      <div className="studio-row">
        <span className={`studio-dot studio-dot-${state}`} data-state={state} title={state === 'unknown' ? 'not in the list' : state} aria-label={`${label} ${state}`} role="img" />
        <select className="mini-select" aria-label={label} value={current} onChange={(event) => onPick(event.currentTarget.value)}>
          {!sources.some((source) => source.kind === 'off') && <option value="off">Off</option>}
          {sources.filter((source) => source.kind === 'off').map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}
          {!known && current !== 'off' && <optgroup label="Typed"><option value={current}>{current}</option></optgroup>}
          {SOURCE_GROUPS.map((group) => {
            const members = sources.filter((source) => source.kind === group.kind);
            return members.length === 0 ? null : (
              <optgroup key={group.kind} label={group.label}>
                {members.map((source) => <option key={source.value} value={source.value}>{optionText(source)}</option>)}
              </optgroup>
            );
          })}
        </select>
      </div>
      {suggested && suggested.value !== current && (
        <div>
          <button type="button" className="button button-compact" onClick={() => onPick(suggested.value)}>Use {suggested.label}</button>
        </div>
      )}
      <div className="studio-row">
        <input className="face-name-input" aria-label={`${label}, typed`} placeholder={hint} value={typed} onChange={(event) => setTyped(event.currentTarget.value)} spellCheck={false} />
        <button type="button" className="button button-compact button-secondary" disabled={!typed.trim() || typed.trim() === current} onClick={() => onPick(typed.trim())}>Set</button>
      </div>
    </div>
  );
}

function VisionModelForm({ model, baseUrl, onApply }: { model: string; baseUrl: string; onApply(patch: { visionModel: string; visionBaseUrl: string }): void }): JSX.Element {
  const [visionModel, setModel] = useState(model);
  const [visionBaseUrl, setBaseUrl] = useState(baseUrl);
  const changed = visionModel !== model || visionBaseUrl !== baseUrl;
  return (
    <>
      <TextRow label="Model" value={visionModel} onChange={setModel} hint="empty: the chat model (gemini) · e.g. qwen3-vl:4b-instruct" />
      <TextRow label="Base URL" value={visionBaseUrl} onChange={setBaseUrl} options={['fleet:vision', 'http://127.0.0.1:11434/v1']} hint="openai only: …/v1 or fleet:vision" />
      <div>
        <button type="button" className="button button-compact button-secondary" disabled={!changed} onClick={() => onApply({ visionModel: visionModel.trim(), visionBaseUrl: visionBaseUrl.trim() })}>Apply model</button>
      </div>
    </>
  );
}

function PresetsSection({ presets, onApply, onSave }: { presets: PresetsResponse | null; onApply(name: string): void; onSave(name: string): void }): JSX.Element {
  const names = presets?.presets.map((preset) => preset.name) ?? [];
  const [chosen, setChosen] = useState('');
  const [saveAs, setSaveAs] = useState('');
  const selected = chosen || presets?.active || names[0] || '';
  return (
    <ControlGroup title="Character">
      <p className="text-slate-400">Active: <span id="studio-preset-active" className="text-slate-200">{presets?.active ?? 'none applied since start'}</span></p>
      {names.length > 0 && (
        <div className="studio-row">
          <select className="mini-select" aria-label="Preset" value={selected} onChange={(event) => setChosen(event.currentTarget.value)}>
            {names.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button type="button" className="button button-compact button-secondary" disabled={!selected} onClick={() => onApply(selected)}>Apply</button>
        </div>
      )}
      <div className="studio-row">
        <input className="face-name-input" aria-label="Save the current character as" placeholder="Save current as…" value={saveAs} onChange={(event) => setSaveAs(event.currentTarget.value)} />
        <button type="button" className="button button-compact button-secondary" disabled={!saveAs.trim()} onClick={() => { onSave(saveAs.trim()); setSaveAs(''); }}>Save</button>
      </div>
    </ControlGroup>
  );
}

function RelationshipsEditor(): JSX.Element {
  const [entries, setEntries] = useState<Relationship[] | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    void fetchJson<{ relationships: Relationship[] }>('/relationships')
      .then((body) => {
        setEntries(body.relationships);
        setSaved(JSON.stringify(body.relationships));
      })
      .catch((failure: unknown) => setProblem(failure instanceof Error ? failure.message : String(failure)));
  }, []);

  if (!entries) return <p className="text-slate-500">{problem || 'Loading…'}</p>;
  const dirty = JSON.stringify(entries) !== saved;
  const update = (index: number, patch: Partial<Relationship>) => setEntries(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  async function save(): Promise<void> {
    try {
      const body = await postJson<{ relationships: Relationship[] }, { relationships: Relationship[] }>('/relationships', { relationships: entries ?? [] });
      setEntries(body.relationships);
      setSaved(JSON.stringify(body.relationships));
      setProblem('');
      setStatus('Saved; applies from the next turn');
    } catch (failure) {
      setStatus('');
      setProblem(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <div className="flex flex-col gap-2" aria-label="Relationships list">
      {entries.length === 0 && <p className="text-slate-500">Nobody listed.</p>}
      {entries.map((entry, index) => (
        <div key={index} className="studio-relationship" role="group" aria-label={`Relationship ${entry.name || index + 1}`}>
          <div className="studio-row">
            <input className="face-name-input" aria-label="Name (as in the face library)" placeholder="Name, as in the face library" value={entry.name} onChange={(event) => update(index, { name: event.currentTarget.value })} />
            <button type="button" className="button button-compact button-danger" onClick={() => setEntries(entries.filter((_, i) => i !== index))}>Remove</button>
          </div>
          <textarea className="face-name-input" aria-label="Attitude" rows={2} placeholder="How the characters treat them" value={entry.attitude} onChange={(event) => update(index, { attitude: event.currentTarget.value })} />
        </div>
      ))}
      <div className="studio-row">
        <button type="button" className="button button-compact button-secondary" onClick={() => setEntries([...entries, { name: '', attitude: '' }])}>Add person</button>
        <button type="button" className="button button-compact" disabled={!dirty} onClick={() => void save()}>Save relationships</button>
      </div>
      {problem && <p role="alert" className="text-rose-300">{problem}</p>}
      {status && !problem && !dirty && <p role="status" className="text-emerald-300">{status}</p>}
    </div>
  );
}

function TextRow({ label, value, onChange, options, hint }: { label: string; value: string; onChange(value: string): void; options?: string[]; hint?: string }): JSX.Element {
  const listId = options ? `studio-options-${label.toLowerCase().replace(/\W+/g, '-')}` : undefined;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-slate-400">{label}</span>
      <input className="face-name-input" value={value} list={listId} onChange={(event) => onChange(event.currentTarget.value)} spellCheck={false} />
      {options && <datalist id={listId}>{options.map((option) => <option key={option} value={option} />)}</datalist>}
      {hint && <span className="text-slate-500 text-[10px]">{hint}</span>}
    </label>
  );
}
