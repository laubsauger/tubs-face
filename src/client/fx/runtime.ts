import type { ConfigResponse } from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';
import { GLITCH_PRESETS, pickGlitchConfig, sanitizeImportedGlitchConfig } from './presets.js';

export interface FxRuntime {
  init(): void;
  bind(root: HTMLElement): void;
}

type RangeConfigKey =
  | 'glitchScanlineIntensity'
  | 'glitchScanlineSpacing'
  | 'glitchScanlineThickness'
  | 'glitchScanlineSpeed'
  | 'glitchPixelJitter'
  | 'glitchFlickerSpeed'
  | 'glitchFlickerDepth'
  | 'glitchGlowStrength'
  | 'glitchBrightnessPulseDim'
  | 'glitchBrightnessPulseBright'
  | 'glitchBrightnessPulseSpeed'
  | 'glitchScanBeamSpeed'
  | 'glitchScanBeamLineWidth'
  | 'glitchScanBeamBrightness'
  | 'glitchScanBeamGlowStrength'
  | 'glitchScanBeamJitter'
  | 'glitchChromaticOffsetX'
  | 'glitchChromaticOffsetY'
  | 'glitchChromaticIntensity'
  | 'glitchChromaticAnimateSpeed'
  | 'glitchSliceCount'
  | 'glitchSliceMaxOffset'
  | 'glitchSliceSpeed'
  | 'glitchSliceIntensity'
  | 'glitchSliceColorShift'
  | 'glitchSliceGapChance'
  | 'glitchSliceIntervalMs'
  | 'glitchSliceBurstDurationMs';

type ToggleConfigKey =
  | 'glitchScanlines'
  | 'glitchFlicker'
  | 'glitchBrightnessPulseEnabled'
  | 'glitchScanBeamEnabled'
  | 'glitchChromaticEnabled'
  | 'glitchChromaticAnimate'
  | 'glitchSliceEnabled';

export function createFxRuntime(store: AppStore): FxRuntime {
  const pendingTimers = new Map<string, number>();

  return {
    init(): void {
      const config = store.getState().config;
      if (!config) {
        return;
      }
      store.setState((current) => ({
        ...current,
        fxBaseColorDraft: config.glitchFxBaseColor,
      }));
    },
    bind(root: HTMLElement): void {
      const toggle = root.querySelector<HTMLButtonElement>('#fx-toggle');
      const openEditor = root.querySelector<HTMLButtonElement>('#fx-editor-open');
      const closeEditor = root.querySelector<HTMLButtonElement>('#fx-editor-close');
      const renderMode = root.querySelector<HTMLSelectElement>('#face-render-mode-select');
      const renderQuality = root.querySelector<HTMLSelectElement>('#face-render-quality-select');
      const renderer = root.querySelector<HTMLSelectElement>('#glitch-renderer-select');
      const preset = root.querySelector<HTMLSelectElement>('#glitch-preset-select');
      const reset = root.querySelector<HTMLButtonElement>('#glitch-reset-button');
      const exportButton = root.querySelector<HTMLButtonElement>('#glitch-export-button');
      const importButton = root.querySelector<HTMLButtonElement>('#glitch-import-button');
      const colorInput = root.querySelector<HTMLInputElement>('#fx-base-color');
      const colorApply = root.querySelector<HTMLButtonElement>('#fx-color-apply');
      const beamColorInput = root.querySelector<HTMLInputElement>('#fx-scanbeam-color');
      const beamColorApply = root.querySelector<HTMLButtonElement>('#fx-scanbeam-color-apply');
      const rangeInputs = root.querySelectorAll<HTMLInputElement>('[data-fx-config-range]');
      const toggleInputs = root.querySelectorAll<HTMLInputElement>('[data-fx-config-toggle]');

      if (
        !toggle || !openEditor || !closeEditor || !renderMode || !renderQuality || !renderer ||
        !preset || !reset || !exportButton || !importButton ||
        !colorInput || !colorApply || !beamColorInput || !beamColorApply
      ) {
        return;
      }

      toggle.onclick = async () => {
        const enabled = !store.getState().config?.glitchFxEnabled;
        await patchConfig(store, { glitchFxEnabled: enabled });
      };

      openEditor.onclick = () => {
        store.setState((current) => ({
          ...current,
          fxEditorOpen: true,
        }));
      };

      closeEditor.onclick = () => {
        store.setState((current) => ({
          ...current,
          fxEditorOpen: false,
        }));
      };

      colorInput.oninput = () => {
        store.setState((current) => ({
          ...current,
          fxBaseColorDraft: normalizeHex(colorInput.value, current.fxBaseColorDraft),
        }));
      };

      colorApply.onclick = async () => {
        await patchConfig(store, { glitchFxBaseColor: normalizeHex(colorInput.value, store.getState().fxBaseColorDraft) });
      };

      renderMode.onchange = async () => {
        await patchConfig(store, {
          faceRenderMode: renderMode.value === 'css'
            ? 'css'
            : renderMode.value === 'svg'
              ? 'svg'
              : 'glitch',
        });
      };

      renderQuality.onchange = async () => {
        const value = renderQuality.value === 'balanced' || renderQuality.value === 'low' ? renderQuality.value : 'high';
        await patchConfig(store, { renderQuality: value });
      };

      renderer.onchange = async () => {
        const value = renderer.value === 'webgpu' || renderer.value === 'canvas2d' ? renderer.value : 'auto';
        await patchConfig(store, { glitchRenderer: value });
      };

      preset.onchange = async () => {
        const selected = GLITCH_PRESETS[preset.value];
        if (!selected) {
          return;
        }
        await patchConfig(store, selected);
        preset.value = '';
      };

      reset.onclick = async () => {
        await patchConfig(store, GLITCH_PRESETS.default ?? {});
      };

      exportButton.onclick = () => {
        exportConfig(store.getState().config);
      };

      importButton.onclick = () => {
        void importConfig(store);
      };

      rangeInputs.forEach((input) => {
        input.oninput = () => {
          const key = input.dataset.fxConfigRange;
          const patch = key ? getRangePatch(key, Number(input.value)) : null;
          if (!key || !patch) {
            return;
          }
          queuePatch(key, patch);
        };
      });

      toggleInputs.forEach((input) => {
        input.onchange = async () => {
          const key = input.dataset.fxConfigToggle;
          const patch = key ? getTogglePatch(key, input.checked) : null;
          if (!patch) {
            return;
          }
          await patchConfig(store, patch);
        };
      });

      beamColorInput.oninput = () => {
        beamColorInput.value = normalizeHex(
          beamColorInput.value,
          store.getState().config?.glitchScanBeamColor ?? '#a600ff',
        );
      };

      beamColorApply.onclick = async () => {
        await patchConfig(store, {
          glitchScanBeamColor: normalizeHex(
            beamColorInput.value,
            store.getState().config?.glitchScanBeamColor ?? '#a600ff',
          ),
        });
      };
    },
  };

  function queuePatch(key: string, patch: Partial<ConfigResponse>): void {
    applyOptimisticConfigPatch(store, patch);
    const existing = pendingTimers.get(key);
    if (existing != null) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      pendingTimers.delete(key);
      void patchConfig(store, patch);
    }, 120);
    pendingTimers.set(key, timer);
  }
}

async function patchConfig(store: AppStore, patch: Partial<ConfigResponse>): Promise<void> {
  applyOptimisticConfigPatch(store, patch);
  try {
    const config = await postJson<Partial<ConfigResponse>, ConfigResponse>('/config', patch);
    store.setState((current) => ({
      ...current,
      config,
      fxBaseColorDraft: config.glitchFxBaseColor,
    }));
  } catch (error) {
    store.appendLog('error', error instanceof Error ? error.message : 'FX config update failed');
  }
}

function applyOptimisticConfigPatch(store: AppStore, patch: Partial<ConfigResponse>): void {
  store.setState((current) => ({
    ...current,
    ...(current.config ? { config: { ...current.config, ...patch } } : {}),
    ...(patch.glitchFxBaseColor ? { fxBaseColorDraft: patch.glitchFxBaseColor } : {}),
  }));
}

function getRangePatch(key: string, value: number): Partial<ConfigResponse> | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  switch (key as RangeConfigKey) {
    case 'glitchScanlineIntensity':
      return { glitchScanlineIntensity: value };
    case 'glitchScanlineSpacing':
      return { glitchScanlineSpacing: Math.round(value) };
    case 'glitchScanlineThickness':
      return { glitchScanlineThickness: Math.round(value) };
    case 'glitchScanlineSpeed':
      return { glitchScanlineSpeed: Math.round(value) };
    case 'glitchPixelJitter':
      return { glitchPixelJitter: value };
    case 'glitchFlickerSpeed':
      return { glitchFlickerSpeed: Math.round(value) };
    case 'glitchFlickerDepth':
      return { glitchFlickerDepth: value };
    case 'glitchGlowStrength':
      return { glitchGlowStrength: value };
    case 'glitchBrightnessPulseDim':
      return { glitchBrightnessPulseDim: value };
    case 'glitchBrightnessPulseBright':
      return { glitchBrightnessPulseBright: value };
    case 'glitchBrightnessPulseSpeed':
      return { glitchBrightnessPulseSpeed: value };
    case 'glitchScanBeamSpeed':
      return { glitchScanBeamSpeed: value };
    case 'glitchScanBeamLineWidth':
      return { glitchScanBeamLineWidth: value };
    case 'glitchScanBeamBrightness':
      return { glitchScanBeamBrightness: value };
    case 'glitchScanBeamGlowStrength':
      return { glitchScanBeamGlowStrength: value };
    case 'glitchScanBeamJitter':
      return { glitchScanBeamJitter: value };
    case 'glitchChromaticOffsetX':
      return { glitchChromaticOffsetX: value };
    case 'glitchChromaticOffsetY':
      return { glitchChromaticOffsetY: value };
    case 'glitchChromaticIntensity':
      return { glitchChromaticIntensity: value };
    case 'glitchChromaticAnimateSpeed':
      return { glitchChromaticAnimateSpeed: value };
    case 'glitchSliceCount':
      return { glitchSliceCount: Math.round(value) };
    case 'glitchSliceMaxOffset':
      return { glitchSliceMaxOffset: value };
    case 'glitchSliceSpeed':
      return { glitchSliceSpeed: value };
    case 'glitchSliceIntensity':
      return { glitchSliceIntensity: value };
    case 'glitchSliceColorShift':
      return { glitchSliceColorShift: value };
    case 'glitchSliceGapChance':
      return { glitchSliceGapChance: value };
    case 'glitchSliceIntervalMs':
      return { glitchSliceIntervalMs: Math.round(value) };
    case 'glitchSliceBurstDurationMs':
      return { glitchSliceBurstDurationMs: Math.round(value) };
    default:
      return null;
  }
}

function getTogglePatch(key: string, value: boolean): Partial<ConfigResponse> | null {
  switch (key as ToggleConfigKey) {
    case 'glitchScanlines':
      return { glitchScanlines: value };
    case 'glitchFlicker':
      return { glitchFlicker: value };
    case 'glitchBrightnessPulseEnabled':
      return { glitchBrightnessPulseEnabled: value };
    case 'glitchScanBeamEnabled':
      return { glitchScanBeamEnabled: value };
    case 'glitchChromaticEnabled':
      return { glitchChromaticEnabled: value };
    case 'glitchChromaticAnimate':
      return { glitchChromaticAnimate: value };
    case 'glitchSliceEnabled':
      return { glitchSliceEnabled: value };
    default:
      return null;
  }
}

function exportConfig(config: ConfigResponse | null): void {
  if (!config) {
    return;
  }

  const data = {
    config: pickGlitchConfig(config),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tubs-glitch-config.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importConfig(store: AppStore): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result ?? '{}')) as { config?: unknown };
        const patch = sanitizeImportedGlitchConfig(parsed.config ?? parsed);
        if (!Object.keys(patch).length) {
          store.appendLog('error', 'Imported glitch config was empty');
          return;
        }
        void patchConfig(store, patch);
      } catch (error) {
        store.appendLog('error', error instanceof Error ? error.message : 'Glitch config import failed');
      }
    };
    reader.readAsText(file);
  }, { once: true });
  input.click();
}

function normalizeHex(value: string, fallback: `#${string}`): `#${string}` {
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized as `#${string}` : fallback;
}
