// The one place to run Tubs in the studio: studio mode, mic and vision
// sources, the vision provider, each head's stream, character presets and the
// relationships. The sentient-studio panel embeds this dashboard in an iframe
// (another origin), so everything here is plain same-origin HTTP to this
// server, and nothing relies on browser dialogs.

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { VisionProvider } from '../../../shared/contracts/config.js';
import type { VisionModelsResponse, VisionServersResponse, VisionTestResult } from '../../../shared/contracts/vision.js';
import type { PresetsResponse } from '../../../shared/contracts/presets.js';
import type { StudioListenState, StudioPart, StudioPulse, StudioSwitches, StudioResponse, StudioSource, StudioSourcesResponse, StudioVisionResponse } from '../../../shared/contracts/studio.js';
import { patchConfig } from '../../fx/runtime.js';
import type { AppStore } from '../../state/app-state.js';
import { fetchJson, postJson } from '../../transport/http.js';
import { useAppSelector } from '../react-store.js';
import { ControlGroup, SelectControl, ToggleControl } from './controls.js';
import { PanelHeader } from './PanelHeader.js';
import { MicMeter } from '../hud/StatusBar.js';
import { StudioCameraView } from './StudioCamera.js';
import { FaceDebug, FaceDebugToggle, faceDebugOn } from './FaceDebug.js';

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
  const [vision, setVision] = useState<StudioVisionResponse | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const [nextStudio, nextPresets] = await Promise.all([fetchJson<StudioResponse>('/studio'), fetchJson<PresetsResponse>('/presets')]);
      setStudio(nextStudio);
      setPresets(nextPresets);
      setError('');
      // What Tubs last made of a picture; local network only, so it may be refused.
      setVision(await fetchJson<StudioVisionResponse>('/studio/vision').catch(() => null));
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

        {studio?.parts && <PartsCard parts={studio.parts} />}

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

        {studio?.switches && (
          <ControlGroup title="Switches">
            {SWITCHES.filter((entry) => entry.key in studio.switches!).map((entry) => (
              <ToggleControl
                key={entry.key}
                label={entry.label}
                checked={studio.switches![entry.key]}
                onChange={(on) => void run(() => postJson('/studio', { switches: { [entry.key]: on } }), `${entry.label} ${on ? 'on' : 'off'}`)}
              />
            ))}
            <p className="text-slate-500 text-[10px]">Vision descriptions run when a face is detected; face recognition names the faces (and onboards new ones).</p>
            <p className="text-slate-500 text-[10px]">Wake word: they answer only when called (“hey Tubs”, or tonight's names from the scene), then follow-ups for 20 s and the tour's open floor. The scene sets it; a change here holds until the next scene change.</p>
            {studio.launch === 'chrome' && (
              <ToggleControl
                label="Show face windows"
                checked={studio.windows === 'visible'}
                onChange={(on) => void run(() => postJson('/studio', { windows: on ? 'visible' : 'offscreen' }), on ? 'Face windows on screen' : 'Face windows off screen')}
              />
            )}
          </ControlGroup>
        )}

        {studio?.enabled && <LiveSection store={store} vision={vision} listenerConnected={studio.actors.find((actor) => actor.id === 'main')?.error !== 'face page not connected'} />}

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
            options={VISION_PROVIDER_OPTIONS}
            onChange={(visionProvider) => void patchConfig(store, { visionProvider })}
          />
          {config.loaded && config.visionProvider !== 'off' && (
            <VisionModelForm
              key={`${config.visionModel}|${config.visionBaseUrl}`}
              store={store}
              provider={config.visionProvider}
              model={config.visionModel}
              baseUrl={config.visionBaseUrl}
              onApply={(patch) => void patchConfig(store, patch)}
            />
          )}
        </ControlGroup>

        <PresetsSection presets={presets} onApply={(name) => void run(() => postJson('/presets/apply', { name }), `${name} applied`)} onSave={(name) => void run(() => postJson('/presets', { name }), `Saved as ${name}`)} />

        {/* Switched on and off with the others under Switches. */}
        <ControlGroup title="Relationships">
          <RelationshipsEditor />
        </ControlGroup>
      </div>
    </article>
  );
}

/** What runs where, at a glance: one line per part, its machine, a dot and the detail. */
function PartsCard({ parts }: { parts: StudioPart[] }): JSX.Element {
  return (
    <ul className="studio-parts" aria-label="What runs where">
      {parts.map((part) => {
        const state = part.ok === null ? 'unknown' : part.ok ? 'ready' : 'down';
        return (
          <li key={part.id} className="studio-part" data-part={part.id} data-ok={String(part.ok)}>
            <span className={`studio-dot studio-dot-${state}`} role="img" aria-label={`${part.label} ${part.ok === null ? 'not in use or not known' : part.ok ? 'ok' : 'not ok'}`} />
            <span className="text-slate-300">{part.label}</span>
            <span className="text-slate-200 studio-part-where">{part.where}</span>
            {part.detail && <span className="text-slate-500 studio-part-detail">{part.detail}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Each part on its own (POST /studio {switches}); the source choices below stay as they are. */
const SWITCHES: Array<{ key: keyof StudioSwitches; label: string }> = [
  { key: 'camera', label: 'Camera' },
  { key: 'faceRecognition', label: 'Face recognition' },
  { key: 'visionDescriptions', label: 'Vision descriptions' },
  { key: 'relationships', label: 'Relationships' },
  { key: 'mic', label: 'Mic' },
  // Asked for: switch between answering everything and answering only when called, by scene or here.
  { key: 'wakeWord', label: 'Wake word ("hey Tubs")' },
];

/** The status bar meter's colours, by what the studio mic is doing. */
const METER_MODE: Record<StudioListenState, string> = {
  off: 'idle',
  listening: 'always-on',
  hearing: 'recording',
  thinking: 'transcribing',
  speaking: 'conversation',
};

const HEAD_NAME = { main: 'Tubs', small: 'Small' } as const;

function ago(t: number | null | undefined, now: number): string {
  if (!t) return '';
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  return seconds < 60 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

/**
 * What the studio listener hears and sees, as the face window shows it in
 * normal mode: the mic, the last line heard, its camera with the face boxes,
 * who is in view (with the relationship in effect) and the last vision check.
 */
function LiveSection({ store, vision, listenerConnected }: { store: AppStore; vision: StudioVisionResponse | null; listenerConnected: boolean }): JSX.Element {
  const live = useAppSelector(store, (current) => ({
    pulse: current.studioPulse,
    reporting: current.studioLive !== null,
    frame: current.studioFrame !== null,
    debug: faceDebugOn(current, Date.now()),
  }));
  const pulse: StudioPulse | null = live.reporting ? live.pulse : null;
  const now = Date.now();
  const attitude = (name: string | null) => (name ? vision?.relationships.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.attitude : undefined);
  const check = vision?.last ?? null;
  return (
    <ControlGroup title="Live">
      {!pulse ? (
        <p className="text-slate-400" id="studio-live-off">
          {listenerConnected ? 'Waiting for the studio listener to report…' : 'The studio listener page is not connected.'}
        </p>
      ) : (
        <div className="flex flex-col gap-2" aria-label="Pulse">
          <p className="studio-row" id="studio-live-mic">
            <MicMeter level={pulse.mic.level} mode={METER_MODE[pulse.mic.state]} />
            <span className="text-slate-200" data-state={pulse.mic.state}>
              {pulse.mic.state === 'speaking' && pulse.speaking ? `${HEAD_NAME[pulse.speaking]} speaking` : pulse.mic.state}
            </span>
            <span className="text-slate-500">{pulse.mic.source}</span>
          </p>
          <p className="text-slate-300" id="studio-live-heard">
            {pulse.heard ? <>Heard “{pulse.heard.text}” <span className="text-slate-500">{ago(pulse.heard.t, now)}</span></> : <span className="text-slate-500">Nothing heard yet.</span>}
          </p>
        </div>
      )}

      {live.reporting && <FaceDebugToggle store={store} />}
      {vision?.camera.on === false ? (
        <p className="text-amber-300" id="studio-live-camera-off">Camera off (vision source: {vision.camera.source}). Nobody is seen or recognised.</p>
      ) : (
        <div className="camera-shell">
          <div className="camera-stage">
            <StudioCameraView store={store} detail={live.debug} />
            {!live.frame && <div className="camera-placeholder">Waiting for the studio camera</div>}
          </div>
        </div>
      )}
      {pulse && pulse.seen.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="In view">
          {pulse.seen.map((person, index) => (
            <li key={`${person.name ?? 'unknown'}-${index}`} className="flex flex-wrap gap-x-2">
              <span className={person.name ? 'text-emerald-300' : 'text-amber-300'}>{person.name ?? 'unknown'}</span>
              <span className="text-slate-400">{Math.round(person.prob * 100)}%</span>
              {attitude(person.name) && <span className="text-slate-500">→ {attitude(person.name)}</span>}
            </li>
          ))}
        </ul>
      )}
      {live.debug && <FaceDebug store={store} faces />}
      <div>
        <button type="button" className="button button-compact button-secondary" disabled={!live.reporting} onClick={() => store.setState((current) => ({ ...current, faceEnrollOpen: true }))}>Onboard someone</button>
      </div>

      {vision && !vision.vision.on ? (
        <p className="text-amber-300" id="studio-live-vision-off">Vision off: no picture leaves this Mac, Tubs only knows faces.</p>
      ) : check ? (
        <p className="text-slate-400" id="studio-live-vision">
          {check.provider} {check.model} at {check.where ?? '?'} · {check.ok === null ? 'looking…' : check.ok ? `${check.ms} ms` : `failed: ${check.error ?? 'no answer'}`} · {ago(check.at, now)}
          {check.text && <span className="block text-slate-300">{check.text}</span>}
        </p>
      ) : vision ? (
        <p className="text-slate-500">No picture sent to vision yet.</p>
      ) : null}
    </ControlGroup>
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

const VISION_PROVIDER_OPTIONS: Array<{ value: VisionProvider; label: string }> = [
  { value: 'off', label: 'Off (no picture leaves this machine)' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai', label: 'OpenAI-compatible (Ollama, LM Studio)' },
];

const CUSTOM_SERVER = '__custom__';
const OLLAMA_PORT = 11434;

/** A host typed as "192.168.1.20" or "box.local:1234": the OpenAI-compatible base on it (Ollama's port by default). */
export function baseForHost(host: string): string {
  const clean = host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean) return '';
  return `http://${/:\d+$/.test(clean) ? clean : `${clean}:${OLLAMA_PORT}`}/v1`;
}

/** A picture for the Test when no studio camera picture is here: a plain card with a figure on it. */
function testCard(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const g = canvas.getContext('2d');
  if (!g) return '';
  g.fillStyle = '#9cc3e6';
  g.fillRect(0, 0, 320, 240);
  g.fillStyle = '#c0392b';
  g.fillRect(130, 120, 60, 90);
  g.fillStyle = '#f1c27d';
  g.beginPath();
  g.arc(160, 95, 26, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1f2937';
  g.font = 'bold 18px system-ui, sans-serif';
  g.fillText('TEST', 12, 28);
  return canvas.toDataURL('image/jpeg', 0.8);
}

/**
 * Which server and model look at the pictures, without knowing the jargon:
 * pick Ollama here, the fleet or a fleet box by name, or type a host; pick a
 * model from what that server has (thinking variants flagged); test it with
 * one picture. The typed fields stay as the override.
 */
function VisionModelForm({ store, provider, model, baseUrl, onApply }: {
  store: AppStore;
  provider: VisionProvider;
  model: string;
  baseUrl: string;
  onApply(patch: { visionModel: string; visionBaseUrl: string }): void;
}): JSX.Element {
  const [visionModel, setModel] = useState(model);
  const [visionBaseUrl, setBaseUrl] = useState(baseUrl);
  const [servers, setServers] = useState<VisionServersResponse | null>(null);
  const [models, setModels] = useState<VisionModelsResponse | null>(null);
  const [customHost, setCustomHost] = useState('');
  const [custom, setCustom] = useState(false);
  const [test, setTest] = useState<VisionTestResult | { running: true } | null>(null);
  const openai = provider === 'openai';
  const changed = visionModel !== model || visionBaseUrl !== baseUrl;

  useEffect(() => {
    if (!openai) return;
    void fetchJson<VisionServersResponse>('/vision/servers').then(setServers).catch(() => setServers(null));
  }, [openai]);

  useEffect(() => {
    if (!openai || !visionBaseUrl.trim()) {
      setModels(null);
      return undefined;
    }
    // Typed by hand: ask once the typing stops.
    const timer = window.setTimeout(() => {
      void fetchJson<VisionModelsResponse>(`/vision/models?base=${encodeURIComponent(visionBaseUrl.trim())}`).then(setModels).catch(() => setModels(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [openai, visionBaseUrl]);

  const listed = servers?.servers.find((server) => server.baseUrl === visionBaseUrl.trim());
  const serverChoice = custom || !listed ? CUSTOM_SERVER : listed.baseUrl;
  const chosen = models?.models.find((entry) => entry.id === visionModel.trim());

  async function runTest(): Promise<void> {
    setTest({ running: true });
    try {
      const frame = store.getState().studioFrame?.src ?? testCard();
      setTest(await postJson<Record<string, unknown>, VisionTestResult>('/vision/test', { provider, model: visionModel.trim(), baseUrl: visionBaseUrl.trim(), frame }));
    } catch (failure) {
      setTest({ ok: false, ms: 0, where: null, text: null, error: failure instanceof Error ? failure.message : String(failure) });
    }
  }

  return (
    <>
      {openai && (
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">Server</span>
          <select
            className="mini-select"
            aria-label="Server"
            value={serverChoice}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (next === CUSTOM_SERVER) {
                setCustom(true);
                return;
              }
              setCustom(false);
              setBaseUrl(next);
            }}
          >
            {servers?.servers.map((server) => (
              <option key={server.baseUrl} value={server.baseUrl}>{`${server.healthy === false ? '○ ' : ''}${server.label}`}</option>
            ))}
            <option value={CUSTOM_SERVER}>Another machine on the network…</option>
          </select>
          {servers?.problem && <span className="text-slate-500 text-[10px]">{servers.problem}</span>}
        </label>
      )}
      {openai && serverChoice === CUSTOM_SERVER && (
        <div className="studio-row">
          <input className="face-name-input" aria-label="Host" placeholder="Host or IP, e.g. 192.168.1.20 (Ollama's port 11434)" value={customHost} onChange={(event) => setCustomHost(event.currentTarget.value)} spellCheck={false} />
          <button type="button" className="button button-compact button-secondary" disabled={!baseForHost(customHost)} onClick={() => setBaseUrl(baseForHost(customHost))}>Use host</button>
        </div>
      )}
      {openai && models && models.models.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">Models on that server</span>
          <select className="mini-select" aria-label="Models on that server" value={chosen ? chosen.id : ''} onChange={(event) => setModel(event.currentTarget.value)}>
            {!chosen && <option value="">{visionModel.trim() ? `${visionModel.trim()} (not on this server)` : 'Choose a model'}</option>}
            {models.models.map((entry) => <option key={entry.id} value={entry.id}>{`${entry.warning ? '⚠ ' : ''}${entry.id}`}</option>)}
          </select>
        </label>
      )}
      {openai && models?.error && <p className="text-amber-300">{models.error}</p>}
      {chosen?.warning && (
        <p className="text-amber-300" role="note">
          {chosen.id} {chosen.warning}.
          {models?.suggested && models.suggested !== chosen.id && (
            <> <button type="button" className="button button-compact" onClick={() => setModel(models.suggested!)}>Use {models.suggested}</button></>
          )}
        </p>
      )}
      <TextRow label="Model" value={visionModel} onChange={setModel} hint={openai ? 'typed: any model the server has · e.g. qwen3-vl:4b-instruct' : 'empty: the chat model'} />
      {openai && <TextRow label="Base URL" value={visionBaseUrl} onChange={(value) => { setCustom(false); setBaseUrl(value); }} options={['fleet:vision', 'http://127.0.0.1:11434/v1']} hint="typed: …/v1 or fleet:vision" />}
      <div className="studio-row">
        <button type="button" className="button button-compact button-secondary" disabled={!changed} onClick={() => onApply({ visionModel: visionModel.trim(), visionBaseUrl: visionBaseUrl.trim() })}>Apply model</button>
        <button type="button" className="button button-compact button-secondary" disabled={test !== null && 'running' in test} onClick={() => void runTest()}>Test</button>
      </div>
      {test && 'running' in test && <p className="text-slate-400" role="status">Testing with one picture…</p>}
      {test && !('running' in test) && (
        <p className={test.ok ? 'text-emerald-300' : 'text-rose-300'} role="status" id="vision-test-result">
          {test.ok ? `${test.ms} ms${test.where ? ` at ${test.where}` : ''}: ${test.text}` : `Failed${test.ms ? ` after ${test.ms} ms` : ''}: ${test.error ?? 'no answer'}`}
        </p>
      )}
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
      <input className="face-name-input" aria-label={label} value={value} list={listId} onChange={(event) => onChange(event.currentTarget.value)} spellCheck={false} />
      {options && <datalist id={listId}>{options.map((option) => <option key={option} value={option} />)}</datalist>}
      {hint && <span className="text-slate-500 text-[10px]">{hint}</span>}
    </label>
  );
}
