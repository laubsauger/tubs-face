import type { ConfigResponse } from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';

const FX_STORAGE_KEY = 'tubs.fxEditorState';

interface StoredFxState {
  fxScanlineIntensity?: number;
  fxPixelJitter?: number;
  fxFlickerDepth?: number;
  fxGlowStrength?: number;
  fxChromaticOffset?: number;
}

export interface FxRuntime {
  init(): void;
  bind(root: HTMLElement): void;
}

export function createFxRuntime(store: AppStore): FxRuntime {
  return {
    init(): void {
      const stored = readStoredFxState();
      store.setState((current) => ({
        ...current,
        ...(current.config?.glitchFxBaseColor ? { fxBaseColorDraft: current.config.glitchFxBaseColor } : {}),
        ...(stored.fxScanlineIntensity != null ? { fxScanlineIntensity: stored.fxScanlineIntensity } : {}),
        ...(stored.fxPixelJitter != null ? { fxPixelJitter: stored.fxPixelJitter } : {}),
        ...(stored.fxFlickerDepth != null ? { fxFlickerDepth: stored.fxFlickerDepth } : {}),
        ...(stored.fxGlowStrength != null ? { fxGlowStrength: stored.fxGlowStrength } : {}),
        ...(stored.fxChromaticOffset != null ? { fxChromaticOffset: stored.fxChromaticOffset } : {}),
      }));
    },
    bind(root: HTMLElement): void {
      const toggle = root.querySelector<HTMLButtonElement>('#fx-toggle');
      const openEditor = root.querySelector<HTMLButtonElement>('#fx-editor-open');
      const closeEditor = root.querySelector<HTMLButtonElement>('#fx-editor-close');
      const colorInput = root.querySelector<HTMLInputElement>('#fx-base-color');
      const colorApply = root.querySelector<HTMLButtonElement>('#fx-color-apply');
      const rangeInputs = root.querySelectorAll<HTMLInputElement>('[data-fx-range]');

      if (!toggle || !openEditor || !closeEditor || !colorInput || !colorApply) {
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

      rangeInputs.forEach((input) => {
        input.oninput = () => {
          const key = input.dataset.fxRange;
          const value = Number(input.value);
          if (!key || !Number.isFinite(value)) {
            return;
          }

          store.setState((current) => {
            const next = {
              ...current,
              ...(key === 'scanlineIntensity' ? { fxScanlineIntensity: value } : {}),
              ...(key === 'pixelJitter' ? { fxPixelJitter: value } : {}),
              ...(key === 'flickerDepth' ? { fxFlickerDepth: value } : {}),
              ...(key === 'glowStrength' ? { fxGlowStrength: value } : {}),
              ...(key === 'chromaticOffset' ? { fxChromaticOffset: value } : {}),
            };
            writeStoredFxState(next);
            return next;
          });
        };
      });
    },
  };
}

async function patchConfig(store: AppStore, patch: Partial<ConfigResponse>): Promise<void> {
  try {
    const config = await postJson<Partial<ConfigResponse>, ConfigResponse>('/config', patch);
    store.setState((current) => ({
      ...current,
      config,
      fxBaseColorDraft: config.glitchFxBaseColor,
    }));
    store.appendLog('info', 'FX config updated');
  } catch (error) {
    store.appendLog('error', error instanceof Error ? error.message : 'FX config update failed');
  }
}

function readStoredFxState(): StoredFxState {
  try {
    const raw = window.localStorage.getItem(FX_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as StoredFxState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredFxState(state: ReturnType<AppStore['getState']>): void {
  try {
    window.localStorage.setItem(FX_STORAGE_KEY, JSON.stringify({
      fxScanlineIntensity: state.fxScanlineIntensity,
      fxPixelJitter: state.fxPixelJitter,
      fxFlickerDepth: state.fxFlickerDepth,
      fxGlowStrength: state.fxGlowStrength,
      fxChromaticOffset: state.fxChromaticOffset,
    } satisfies StoredFxState));
  } catch {
    // ignore storage failures
  }
}

function normalizeHex(value: string, fallback: `#${string}`): `#${string}` {
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized as `#${string}` : fallback;
}
