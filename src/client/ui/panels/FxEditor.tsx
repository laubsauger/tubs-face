import { useState, type JSX } from 'react';
import { EXPRESSIONS, type ExpressionName } from '../../../shared/contracts/config.js';
import type { ConfigResponse } from '../../../shared/contracts/http.js';
import {
  exportConfig,
  getRangePatch,
  getTogglePatch,
  importConfig,
  normalizeExpressionName,
  patchConfig,
  patchExpressionProfile,
  previewExpression,
  patchConfigLive,
  toggleFxEditor,
} from '../../fx/runtime.js';
import { GLITCH_PRESETS } from '../../fx/presets.js';
import type { AppStore } from '../../state/app-state.js';
import { useAppSelector } from '../react-store.js';
import { ColorControl, ControlGroup, RangeControl, SelectControl, ToggleControl } from './controls.js';

type Config = ConfigResponse;
type NumberKey = { [K in keyof Config]-?: Config[K] extends number ? K : never }[keyof Config];
type BooleanKey = { [K in keyof Config]-?: Config[K] extends boolean ? K : never }[keyof Config];
type ColorKey = { [K in keyof Config]-?: Config[K] extends `#${string}` ? K : never }[keyof Config];

type Control =
  | { kind: 'range'; key: NumberKey; label: string; min: number; max: number; step: number }
  | { kind: 'toggle'; key: BooleanKey; label: string }
  | { kind: 'color'; key: ColorKey; label: string };

const range = (key: NumberKey, label: string, min: number, max: number, step: number): Control => ({ kind: 'range', key, label, min, max, step });
const toggle = (key: BooleanKey, label: string): Control => ({ kind: 'toggle', key, label });
const color = (key: ColorKey, label: string): Control => ({ kind: 'color', key, label });

function shape(prefix: 'glitchShapeLeftEye' | 'glitchShapeRightEye' | 'glitchShapeMouth', minX: number, minY: number, maxH: number): Control[] {
  return [
    range(`${prefix}X`, 'X', minX, 60, 0.1),
    range(`${prefix}Y`, 'Y', minY, 40, 0.1),
    range(`${prefix}W`, 'Width', 1, 30, 0.1),
    range(`${prefix}H`, 'Height', 1, maxH, 0.1),
    range(`${prefix}Rx`, 'Radius X', 0, 15, 0.1),
    range(`${prefix}Ry`, 'Radius Y', 0, 15, 0.1),
  ];
}

// Same groups and ranges as main's FX editor; the ranges match the server's
// validation in config/runtime.ts, which ignores out-of-range values.
const GLITCH_GROUPS: Array<{ title: string; controls: Control[] }> = [
  { title: 'Pixel Grid', controls: [range('glitchPixelSize', 'Size', 2, 60, 1), range('glitchPixelGap', 'Gap', 0, 30, 1)] },
  { title: 'Left Eye', controls: shape('glitchShapeLeftEye', -10, -10, 40) },
  { title: 'Right Eye', controls: shape('glitchShapeRightEye', 0, -10, 40) },
  { title: 'Mouth', controls: shape('glitchShapeMouth', 0, 0, 20) },
  {
    title: 'Color',
    controls: [
      color('glitchFxBaseColor', 'Base Color'),
      range('glitchColorHueVariation', 'Hue Variation', 0, 60, 1),
      range('glitchColorBrightnessVariation', 'Brightness Var', 0, 40, 1),
      range('glitchColorOpacityMin', 'Opacity Min', 0, 1, 0.05),
    ],
  },
  { title: 'Glow', controls: [range('glitchGlowStrength', 'Pixel Glow', 0, 60, 1)] },
  {
    title: 'Brightness Pulse',
    controls: [
      toggle('glitchBrightnessPulseEnabled', 'Enabled'),
      range('glitchBrightnessPulseDim', 'Dim', 0.3, 1, 0.01),
      range('glitchBrightnessPulseBright', 'Bright', 0.5, 1.5, 0.01),
      range('glitchBrightnessPulseSpeed', 'Speed', 0.5, 15, 0.5),
    ],
  },
  {
    title: 'Scan Beam',
    controls: [
      toggle('glitchScanBeamEnabled', 'Enabled'),
      range('glitchScanBeamSpeed', 'Speed', 1, 40, 1),
      range('glitchScanBeamLineWidth', 'Line Width', 1, 30, 1),
      range('glitchScanBeamBrightness', 'Brightness', 0, 1, 0.05),
      range('glitchScanBeamGlowStrength', 'Glow Strength', 0, 60, 1),
      range('glitchScanBeamJitter', 'Jitter', 0, 10, 0.5),
      color('glitchScanBeamColor', 'Color'),
    ],
  },
  {
    title: 'Chromatic Aberration',
    controls: [
      toggle('glitchChromaticEnabled', 'Enabled'),
      range('glitchChromaticOffsetX', 'Offset X', -10, 10, 0.5),
      range('glitchChromaticOffsetY', 'Offset Y', -10, 10, 0.5),
      range('glitchChromaticIntensity', 'Intensity', 0, 1, 0.05),
      toggle('glitchChromaticAnimate', 'Animate'),
      range('glitchChromaticAnimateSpeed', 'Animate Speed', 1, 20, 1),
    ],
  },
  {
    title: 'Glitch Slice',
    controls: [
      toggle('glitchSliceEnabled', 'Enabled'),
      range('glitchSliceCount', 'Slice Count', 2, 60, 1),
      range('glitchSliceMaxOffset', 'Max Offset', 0, 30, 1),
      range('glitchSliceSpeed', 'Speed', 1, 60, 1),
      range('glitchSliceIntensity', 'Intensity', 0, 1, 0.01),
      range('glitchSliceColorShift', 'Color Shift', 0, 0.2, 0.01),
      range('glitchSliceGapChance', 'Gap Chance', 0, 0.5, 0.01),
      range('glitchSliceIntervalMs', 'Interval (ms)', 1000, 60000, 1000),
      range('glitchSliceBurstDurationMs', 'Burst (ms)', 200, 8000, 100),
    ],
  },
  {
    title: 'Scanlines & Flicker',
    controls: [
      toggle('glitchScanlines', 'Scanlines'),
      range('glitchScanlineIntensity', 'Intensity', 0, 1, 0.01),
      range('glitchScanlineSpacing', 'Spacing', 1, 20, 1),
      range('glitchScanlineThickness', 'Thickness', 1, 10, 1),
      range('glitchScanlineSpeed', 'Speed', 1, 60, 1),
      range('glitchPixelJitter', 'Pixel Jitter', 0, 10, 0.5),
      toggle('glitchFlicker', 'Flicker'),
      range('glitchFlickerSpeed', 'Flicker Speed', 1, 30, 1),
      range('glitchFlickerDepth', 'Flicker Depth', 0, 0.2, 0.005),
    ],
  },
];

const PROFILE_RANGES = [
  { key: 'eyeH', label: 'Eye Height', min: 0.05, max: 2, step: 0.01, fallback: 1 },
  { key: 'eyeW', label: 'Eye Width', min: 0.3, max: 2, step: 0.01, fallback: 1 },
  { key: 'eyeDy', label: 'Eye Offset Y', min: -10, max: 15, step: 0.5, fallback: 0 },
  { key: 'eyeSkew', label: 'Eye Skew', min: -0.5, max: 0.5, step: 0.01, fallback: 0 },
  { key: 'mouthW', label: 'Mouth Width', min: 0.1, max: 2, step: 0.01, fallback: 1 },
  { key: 'mouthH', label: 'Mouth Height', min: 0.1, max: 4, step: 0.01, fallback: 1 },
] as const;

/**
 * Side drawer over the live face, so every change is previewed on the real
 * renderer. Sliders apply locally while dragging and save to the server once
 * they settle.
 */
export function FxEditor({ store }: { store: AppStore }): JSX.Element | null {
  const state = useAppSelector(store, (current) => ({
    open: current.fxEditorOpen,
    config: current.config,
    expression: current.fxExpressionSelected,
  }));
  const [tab, setTab] = useState<'glitch' | 'expressions'>('glitch');

  if (!state.open || !state.config) {
    return null;
  }
  const config = state.config;

  return (
    <aside className="fx-editor-drawer" aria-label="FX editor">
      <header className="fx-editor-drawer-header">
        <h2>FX Editor</h2>
        <div className="fx-editor-drawer-actions">
          <select
            className="mini-select"
            value=""
            aria-label="Apply preset"
            onChange={(event) => {
              const preset = GLITCH_PRESETS[event.currentTarget.value];
              if (preset) void patchConfig(store, preset);
            }}
          >
            <option value="">Preset…</option>
            {Object.keys(GLITCH_PRESETS).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button type="button" className="button button-secondary button-compact" onClick={() => exportConfig(store.getState().config)}>Export</button>
          <button type="button" className="button button-secondary button-compact" onClick={() => void importConfig(store)}>Import</button>
          <button type="button" className="button button-secondary button-compact" onClick={() => toggleFxEditor(store)}>Close (E)</button>
        </div>
      </header>

      <nav className="fx-editor-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'glitch'} className={tab === 'glitch' ? 'is-active' : ''} onClick={() => setTab('glitch')}>Glitch FX</button>
        <button type="button" role="tab" aria-selected={tab === 'expressions'} className={tab === 'expressions' ? 'is-active' : ''} onClick={() => setTab('expressions')}>Expressions</button>
      </nav>

      <PreviewActions store={store} />

      <div className="fx-editor-drawer-body">
        {tab === 'glitch'
          ? GLITCH_GROUPS.map((group) => (
            <ControlGroup key={group.title} title={group.title}>
              {group.controls.map((control) => <GlitchControl key={control.key} store={store} config={config} control={control} />)}
            </ControlGroup>
          ))
          : <ExpressionControls store={store} config={config} expression={state.expression} />}
      </div>
    </aside>
  );
}

function GlitchControl({ store, config, control }: { store: AppStore; config: Config; control: Control }): JSX.Element {
  if (control.kind === 'toggle') {
    return (
      <ToggleControl
        label={control.label}
        checked={config[control.key]}
        onChange={(checked) => {
          const patch = getTogglePatch(control.key, checked);
          if (patch) void patchConfig(store, patch);
        }}
      />
    );
  }
  if (control.kind === 'color') {
    return <ColorControl label={control.label} value={config[control.key]} onChange={(value) => patchConfigLive(store, { [control.key]: value })} />;
  }
  return (
    <RangeControl
      label={control.label}
      value={config[control.key]}
      min={control.min}
      max={control.max}
      step={control.step}
      onChange={(value) => {
        const patch = getRangePatch(control.key, value);
        if (patch) patchConfigLive(store, patch);
      }}
    />
  );
}

function ExpressionControls({ store, config, expression }: { store: AppStore; config: Config; expression: ExpressionName }): JSX.Element {
  const profile = config.glitchExpressionProfiles?.[expression] ?? null;
  const change = (patch: Parameters<typeof patchExpressionProfile>[2]) => {
    patchConfigLive(store, patchExpressionProfile(store.getState().config, expression, patch));
    previewExpression(store, expression);
  };

  return (
    <>
      <ControlGroup title="Expression">
        <SelectControl
          label="Preview"
          value={expression}
          options={EXPRESSIONS}
          onChange={(value) => {
            const next = normalizeExpressionName(value);
            store.setState((current) => ({ ...current, fxExpressionSelected: next, currentExpression: next }));
          }}
        />
        <div className="flex justify-end">
          <button type="button" className="button button-secondary button-compact" onClick={() => change(null)}>Reset Profile</button>
        </div>
      </ControlGroup>

      <ControlGroup title={`${expression} profile`}>
        {PROFILE_RANGES.map((item) => (
          <RangeControl
            key={item.key}
            label={item.label}
            value={profile?.[item.key] ?? item.fallback}
            min={item.min}
            max={item.max}
            step={item.step}
            onChange={(value) => change({ type: 'range', key: item.key, value })}
          />
        ))}
        <ToggleControl label="Mouth Round" checked={profile?.mouthRound ?? false} onChange={(value) => change({ type: 'toggle', key: 'mouthRound', value })} />
        <ToggleControl label="Tears" checked={profile?.tears ?? false} onChange={(value) => change({ type: 'toggle', key: 'tears', value })} />
        <SelectControl label="Eye Shape" value={profile?.eyeShape ?? 'rect'} options={['rect', 'heart']} onChange={(value) => change({ type: 'select', key: 'eyeShape', value })} />
        <SelectControl label="Mouth Shape" value={profile?.mouthShape ?? 'rect'} options={['rect', 'frown', 'smile-arc', 'round']} onChange={(value) => change({ type: 'select', key: 'mouthShape', value })} />
        <ColorControl label="Color Override" value={profile?.colorHex ?? config.glitchFxBaseColor} onChange={(value) => change({ type: 'color', key: 'colorHex', value })} />
        <ColorControl label="Tear Color" value={profile?.tearColorHex ?? '#57bfff'} onChange={(value) => change({ type: 'color', key: 'tearColorHex', value })} />
      </ControlGroup>
    </>
  );
}

function PreviewActions({ store }: { store: AppStore }): JSX.Element {
  const speaking = useAppSelector(store, (current) => current.audioPlaying);
  return (
    <div className="fx-editor-preview-actions">
      <button
        type="button"
        className="button button-secondary button-compact"
        onClick={() => {
          store.setState((current) => ({ ...current, blinkActive: true, lastBlinkAt: Date.now() }));
          window.setTimeout(() => store.setState((current) => ({ ...current, blinkActive: false })), 220);
        }}
      >
        Blink
      </button>
      <button
        type="button"
        className={`button button-compact ${speaking ? '' : 'button-secondary'}`}
        onClick={() => {
          const next = !store.getState().audioPlaying;
          store.setState((current) => ({ ...current, audioPlaying: next }));
          // Same 5 s auto-stop as main, so a forgotten preview doesn't stick.
          if (next) {
            window.setTimeout(() => store.setState((current) => ({ ...current, audioPlaying: false })), 5000);
          }
        }}
      >
        {speaking ? 'Stop' : 'Speak'}
      </button>
    </div>
  );
}
