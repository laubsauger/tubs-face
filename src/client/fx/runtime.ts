import type { ConfigResponse } from '../../shared/contracts/http.js';
import type { ExpressionName, ExpressionProfile } from '../../shared/contracts/config.js';
import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';
import { GLITCH_PRESETS, pickGlitchConfig, sanitizeImportedGlitchConfig } from './presets.js';
import { DEFAULT_EXPRESSION_PROFILES } from '../../shared/contracts/config.js';

export interface FxRuntime {
  init(): void;
}

type RangeConfigKey =
  | 'glitchPixelSize'
  | 'glitchPixelGap'
  | 'glitchScanlineIntensity'
  | 'glitchScanlineSpacing'
  | 'glitchScanlineThickness'
  | 'glitchScanlineSpeed'
  | 'glitchPixelJitter'
  | 'glitchFlickerSpeed'
  | 'glitchFlickerDepth'
  | 'glitchGlowStrength'
  | 'glitchColorHueVariation'
  | 'glitchColorBrightnessVariation'
  | 'glitchColorOpacityMin'
  | 'glitchShapeLeftEyeX'
  | 'glitchShapeLeftEyeY'
  | 'glitchShapeLeftEyeW'
  | 'glitchShapeLeftEyeH'
  | 'glitchShapeLeftEyeRx'
  | 'glitchShapeLeftEyeRy'
  | 'glitchShapeRightEyeX'
  | 'glitchShapeRightEyeY'
  | 'glitchShapeRightEyeW'
  | 'glitchShapeRightEyeH'
  | 'glitchShapeRightEyeRx'
  | 'glitchShapeRightEyeRy'
  | 'glitchShapeMouthX'
  | 'glitchShapeMouthY'
  | 'glitchShapeMouthW'
  | 'glitchShapeMouthH'
  | 'glitchShapeMouthRx'
  | 'glitchShapeMouthRy'
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

type ExpressionRangeKey =
  | 'eyeH'
  | 'eyeW'
  | 'eyeDy'
  | 'eyeSkew'
  | 'mouthW'
  | 'mouthH';

type ExpressionToggleKey =
  | 'mouthRound'
  | 'tears';

type ExpressionSelectKey =
  | 'eyeShape'
  | 'mouthShape';

type ExpressionColorKey =
  | 'colorHex'
  | 'tearColorHex';

export function createFxRuntime(store: AppStore): FxRuntime {
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
  };
}

export async function patchConfig(store: AppStore, patch: Partial<ConfigResponse>): Promise<void> {
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

export function applyOptimisticConfigPatch(store: AppStore, patch: Partial<ConfigResponse>): void {
  store.setState((current) => ({
    ...current,
    ...(current.config ? { config: { ...current.config, ...patch } } : {}),
    ...(patch.glitchFxBaseColor ? { fxBaseColorDraft: patch.glitchFxBaseColor } : {}),
  }));
}

export function getRangePatch(key: string, value: number): Partial<ConfigResponse> | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  switch (key as RangeConfigKey) {
    case 'glitchPixelSize':
      return { glitchPixelSize: value };
    case 'glitchPixelGap':
      return { glitchPixelGap: value };
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
    case 'glitchColorHueVariation':
      return { glitchColorHueVariation: value };
    case 'glitchColorBrightnessVariation':
      return { glitchColorBrightnessVariation: value };
    case 'glitchColorOpacityMin':
      return { glitchColorOpacityMin: value };
    case 'glitchShapeLeftEyeX':
      return { glitchShapeLeftEyeX: value };
    case 'glitchShapeLeftEyeY':
      return { glitchShapeLeftEyeY: value };
    case 'glitchShapeLeftEyeW':
      return { glitchShapeLeftEyeW: value };
    case 'glitchShapeLeftEyeH':
      return { glitchShapeLeftEyeH: value };
    case 'glitchShapeLeftEyeRx':
      return { glitchShapeLeftEyeRx: value };
    case 'glitchShapeLeftEyeRy':
      return { glitchShapeLeftEyeRy: value };
    case 'glitchShapeRightEyeX':
      return { glitchShapeRightEyeX: value };
    case 'glitchShapeRightEyeY':
      return { glitchShapeRightEyeY: value };
    case 'glitchShapeRightEyeW':
      return { glitchShapeRightEyeW: value };
    case 'glitchShapeRightEyeH':
      return { glitchShapeRightEyeH: value };
    case 'glitchShapeRightEyeRx':
      return { glitchShapeRightEyeRx: value };
    case 'glitchShapeRightEyeRy':
      return { glitchShapeRightEyeRy: value };
    case 'glitchShapeMouthX':
      return { glitchShapeMouthX: value };
    case 'glitchShapeMouthY':
      return { glitchShapeMouthY: value };
    case 'glitchShapeMouthW':
      return { glitchShapeMouthW: value };
    case 'glitchShapeMouthH':
      return { glitchShapeMouthH: value };
    case 'glitchShapeMouthRx':
      return { glitchShapeMouthRx: value };
    case 'glitchShapeMouthRy':
      return { glitchShapeMouthRy: value };
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

export function getTogglePatch(key: string, value: boolean): Partial<ConfigResponse> | null {
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

export function exportConfig(config: ConfigResponse | null): void {
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

export async function importConfig(store: AppStore): Promise<void> {
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

export function normalizeHex(value: string, fallback: `#${string}`): `#${string}` {
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized as `#${string}` : fallback;
}

export function normalizeExpressionName(value: string): ExpressionName {
  const normalized = value.trim() as ExpressionName;
  return normalized in DEFAULT_EXPRESSION_PROFILES ? normalized : 'idle';
}

export function previewExpression(store: AppStore, expression: ExpressionName): void {
  store.setState((current) => ({
    ...current,
    ...(current.fxEditorOpen ? { currentExpression: expression } : {}),
  }));
}

export function patchExpressionProfile(
  config: ConfigResponse | null,
  expression: ExpressionName,
  change: ProfileChange | null,
): Partial<ConfigResponse> {
  const profiles = structuredClone(config?.glitchExpressionProfiles ?? DEFAULT_EXPRESSION_PROFILES);
  const current = profiles[expression];
  const next = current && typeof current === 'object' ? { ...current } : {};

  if (change === null) {
    profiles[expression] = expression === 'idle' ? null : {};
    return { glitchExpressionProfiles: profiles };
  }

  applyProfileChange(next, change);
  profiles[expression] = collapseProfile(expression, next);
  return { glitchExpressionProfiles: profiles };
}

type ProfileChange =
  | { type: 'range'; key: string; value: number }
  | { type: 'toggle'; key: string; value: boolean }
  | { type: 'select'; key: string; value: string }
  | { type: 'color'; key: string; value: `#${string}` };

function applyProfileChange(profile: Partial<ExpressionProfile>, change: ProfileChange): void {
  switch (change.type) {
    case 'range':
      switch (change.key as ExpressionRangeKey) {
        case 'eyeH': profile.eyeH = change.value; return;
        case 'eyeW': profile.eyeW = change.value; return;
        case 'eyeDy': profile.eyeDy = change.value; return;
        case 'eyeSkew': profile.eyeSkew = change.value; return;
        case 'mouthW': profile.mouthW = change.value; return;
        case 'mouthH': profile.mouthH = change.value; return;
        default: return;
      }
    case 'toggle':
      if (change.key === 'mouthRound') {
        if (change.value) profile.mouthRound = true;
        else delete profile.mouthRound;
      }
      if (change.key === 'tears') {
        if (change.value) profile.tears = true;
        else delete profile.tears;
      }
      return;
    case 'select':
      if (change.key === 'eyeShape') {
        if (change.value === 'heart') profile.eyeShape = 'heart';
        else delete profile.eyeShape;
      }
      if (change.key === 'mouthShape') {
        if (
          change.value === 'frown' ||
          change.value === 'smile-arc' ||
          change.value === 'round'
        ) {
          profile.mouthShape = change.value;
        } else {
          delete profile.mouthShape;
        }
      }
      return;
    case 'color':
      if (change.key === 'colorHex') profile.colorHex = change.value;
      if (change.key === 'tearColorHex') profile.tearColorHex = change.value;
      return;
  }
}

function collapseProfile(
  expression: ExpressionName,
  profile: Partial<ExpressionProfile>,
): ExpressionProfile | null {
  const normalized = Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== undefined && value !== false && value !== 'rect'),
  ) as ExpressionProfile;

  if (!Object.keys(normalized).length) {
    return expression === 'idle' ? null : {};
  }
  return normalized;
}
