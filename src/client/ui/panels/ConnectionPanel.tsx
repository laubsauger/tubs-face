import type { JSX } from 'react';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { PanelHeader } from './PanelHeader.js';
import { formatUptime, formatAwakeElapsed } from '../utils/formatters.js';
import { DUAL_HEAD_TURN_POLICIES, KOKORO_VOICES, RENDER_QUALITIES } from '../../../shared/contracts/config.js';
import { patchConfig, patchConfigLive, toggleFxEditor } from '../../fx/runtime.js';
import { ButtonControl, ColorControl, ControlGroup, RangeControl, SelectControl, ToggleControl } from './controls.js';

export function ConnectionPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.connection),
    connectionLabel: current.connectionLabel,
    connected: current.connected,
    health: current.health,
    awakeElapsedSec: current.awakeElapsedSec,
    stats: current.stats,
    config: current.config,
  }));

  return (
    <article className={`panel-surface panel-surface-compact transition-all ${state.collapsed ? 'is-collapsed h-11' : ''}`}>
      <PanelHeader store={store} panelKey="connection" title="System Vitals" meta={state.connected ? 'Online' : 'Offline'} />
      <div className={`panel-body panel-content flex flex-col gap-4 ${state.collapsed ? 'hidden' : ''}`}>
        <div className="flex items-center gap-3 bg-slate-950/50 p-3 rounded-xl border border-slate-800">
          <div className={`w-3 h-3 rounded-full shadow-[0_0_12px_rgba(0,0,0,0.5)] ${state.connected ? 'bg-emerald-500 shadow-emerald-500/50' : 'bg-red-500 shadow-red-500/50'} animate-pulse`} />
          <div className="flex-1 font-mono text-xs text-slate-300">
            {state.connectionLabel}
          </div>
        </div>

        <dl className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-3 text-xs font-mono">
          <dt className="text-slate-500">Uptime</dt>
          <dd className="text-slate-300 font-bold">{formatUptime(state.health)}</dd>
          
          <dt className="text-slate-500">Awake</dt>
          <dd className="text-slate-300 font-bold">{formatAwakeElapsed(state.awakeElapsedSec)}</dd>
          
          <dt className="text-slate-500">Model</dt>
          <dd className="text-cyan-400 font-bold truncate" title={state.stats?.model ?? state.config?.model ?? 'n/a'}>
            {state.stats?.model ?? state.config?.model ?? 'n/a'}
          </dd>
        </dl>

        {state.config ? <RuntimeControls store={store} config={state.config} /> : null}
      </div>
    </article>
  );
}

type Config = NonNullable<ReturnType<AppStore['getState']>['config']>;

// Runtime settings that main kept in System Vitals. All of them are live server
// config, so every client (main, mini, spectator) picks the change up.
function RuntimeControls({ store, config }: { store: AppStore; config: Config }): JSX.Element {
  const dualOn = config.dualHeadEnabled && config.dualHeadMode !== 'off';
  return (
    <>
      <ControlGroup title="Face">
        <SelectControl
          label="Render"
          value={config.faceRenderMode}
          options={[{ value: 'glitch', label: 'Glitch' }, { value: 'css', label: 'CSS' }]}
          onChange={(faceRenderMode) => void patchConfig(store, { faceRenderMode })}
        />
        <SelectControl label="Quality" value={config.renderQuality} options={RENDER_QUALITIES} onChange={(renderQuality) => void patchConfig(store, { renderQuality })} />
        <ToggleControl label="Glitch FX" checked={config.glitchFxEnabled} onChange={(glitchFxEnabled) => void patchConfig(store, { glitchFxEnabled })} />
        <ColorControl label="Glitch Color" value={config.glitchFxBaseColor} onChange={(glitchFxBaseColor) => patchConfigLive(store, { glitchFxBaseColor })} />
        <ButtonControl label="FX Editor (E)" text="Edit" onClick={() => toggleFxEditor(store)} />
      </ControlGroup>

      <ControlGroup title="Brain">
        <SelectControl
          label="Model"
          value={config.llmModel}
          options={withCurrent(LLM_MODEL_CHOICES, config.llmModel)}
          onChange={(llmModel) => void patchConfig(store, { llmModel })}
        />
      </ControlGroup>

      <ControlGroup title="Voice">
        <SelectControl label="Voice" value={config.kokoroVoice} options={KOKORO_VOICES} onChange={(kokoroVoice) => void patchConfig(store, { kokoroVoice })} />
        <RangeControl
          label="Sleep"
          value={Math.round(config.sleepTimeout / 1000)}
          min={5}
          max={600}
          step={5}
          format={(seconds) => `${seconds}s`}
          onChange={(seconds) => patchConfigLive(store, { sleepTimeout: seconds * 1000 })}
        />
      </ControlGroup>

      <ControlGroup title="Two Heads">
        <ToggleControl
          label="Enabled"
          checked={dualOn}
          onChange={(enabled) => void patchConfig(store, enabled
            ? { dualHeadEnabled: true, dualHeadMode: 'llm_directed' }
            : { dualHeadEnabled: false })}
        />
        {dualOn ? (
          <>
            <SelectControl label="Turn Policy" value={config.dualHeadTurnPolicy} options={DUAL_HEAD_TURN_POLICIES} onChange={(dualHeadTurnPolicy) => void patchConfig(store, { dualHeadTurnPolicy })} />
            <SelectControl label="Small Voice" value={config.secondaryVoice} options={KOKORO_VOICES} onChange={(secondaryVoice) => void patchConfig(store, { secondaryVoice })} />
            <SelectControl label="Small FX" value={config.secondaryRenderQuality} options={RENDER_QUALITIES} onChange={(secondaryRenderQuality) => void patchConfig(store, { secondaryRenderQuality })} />
            <ColorControl label="Small Glitch" value={config.secondaryGlitchFxBaseColor} onChange={(secondaryGlitchFxBaseColor) => patchConfigLive(store, { secondaryGlitchFxBaseColor })} />
            <ToggleControl label="Small Subs" checked={config.secondarySubtitleEnabled} onChange={(secondarySubtitleEnabled) => void patchConfig(store, { secondarySubtitleEnabled })} />
            <RangeControl
              label="Small Gain"
              value={config.secondaryAudioGain}
              min={0}
              max={1.2}
              step={0.05}
              format={(gain) => gain.toFixed(2)}
              onChange={(secondaryAudioGain) => patchConfigLive(store, { secondaryAudioGain })}
            />
          </>
        ) : null}
      </ControlGroup>
    </>
  );
}

// Gemini models benchmarked for live conversation (Nov 2026, avg time to first audio).
const LLM_MODEL_CHOICES = [
  { value: 'gemini-3.5-flash', label: '3.5 Flash · default, ~1.3 s' },
  { value: 'gemini-3.8-flash', label: '3.8 Flash · sharper, ~1.9 s' },
  { value: 'gemini-3.5-flash-lite', label: '3.5 Flash-Lite · fastest, no emotions' },
];

function withCurrent(choices: Array<{ value: string; label: string }>, current: string): Array<{ value: string; label: string }> {
  return choices.some((choice) => choice.value === current) ? choices : [...choices, { value: current, label: current }];
}
