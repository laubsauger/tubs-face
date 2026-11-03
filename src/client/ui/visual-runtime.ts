import type { AppStore } from '../state/app-state.js';
import { renderFaceVisualMarkup } from './face-visual.js';

/**
 * Owns the `#visual-face` element only: its CSS-mode markup, data attributes and
 * CSS variables. Overlays (subtitle visibility, live transcript, donation card)
 * are rendered by React in app-shell.tsx, and subtitle words by the subtitle
 * controller in speech-runtime.ts. Writing those nodes here too made the last
 * writer win, e.g. the mini subtitle came back after it was turned off.
 */
export interface VisualRuntime {
  bind(root: HTMLElement): void;
  /** Cheap per-frame path: only the gaze CSS variables. */
  syncGaze(): void;
}

export function createVisualRuntime(store: AppStore, mode: 'main' | 'mini'): VisualRuntime {
  let lastFaceMarkup = '';
  let face: HTMLElement | null = null;

  function syncGaze(): void {
    if (!face) {
      return;
    }
    const state = store.getState();
    face.style.setProperty('--gaze-x', state.gazeX.toFixed(4));
    face.style.setProperty('--gaze-y', state.gazeY.toFixed(4));
  }

  return {
    bind(root: HTMLElement): void {
      face = root.querySelector<HTMLElement>('#visual-face');
      const state = store.getState();

      document.body.classList.toggle('app-sleeping', state.sleeping);

      if (!face) {
        return;
      }

      const config = state.config;
      const usingGlitchCanvas = config?.faceRenderMode === 'glitch' && Boolean(config?.glitchFxEnabled);
      const chromaticOffset = Math.max(
        Math.abs(config?.glitchChromaticOffsetX ?? 0),
        Math.abs(config?.glitchChromaticOffsetY ?? 4.5),
      );
      if (usingGlitchCanvas) {
        syncGlitchFaceChildren(face);
        lastFaceMarkup = '';
      } else {
        const nextMarkup = renderFaceVisualMarkup(state);
        if (nextMarkup !== lastFaceMarkup) {
          face.innerHTML = nextMarkup;
          lastFaceMarkup = nextMarkup;
        }
      }
      face.dataset.expression = state.currentExpression;
      face.dataset.idleVariant = state.idleVariant;
      face.dataset.renderMode = config?.faceRenderMode ?? 'css';
      face.dataset.renderQuality = config?.renderQuality ?? 'high';
      face.classList.toggle('is-speaking', state.audioPlaying);
      face.classList.toggle('is-sleeping', state.sleeping);
      face.classList.toggle('is-blinking', state.blinkActive);
      face.classList.toggle('is-glitch-enabled', Boolean(config?.glitchFxEnabled));
      syncGaze();
      face.style.setProperty('--mood-pos', state.moodPos.toFixed(3));
      face.style.setProperty('--mood-neg', state.moodNeg.toFixed(3));
      face.style.setProperty('--mood-arousal', state.moodArousal.toFixed(3));
      const baseColor = mode === 'mini'
        ? (config?.secondaryGlitchFxBaseColor ?? config?.glitchFxBaseColor ?? state.fxBaseColorDraft)
        : (config?.glitchFxBaseColor ?? state.fxBaseColorDraft);
      face.style.setProperty('--fx-base-color', baseColor);
      face.style.setProperty('--fx-scanline-intensity', String(config?.glitchScanlineIntensity ?? 0.41));
      face.style.setProperty('--fx-pixel-jitter', `${(config?.glitchPixelJitter ?? 0).toFixed(2)}px`);
      face.style.setProperty('--fx-flicker-depth', String(config?.glitchFlickerDepth ?? 0.02));
      face.style.setProperty('--fx-glow-strength', `${(config?.glitchGlowStrength ?? 14).toFixed(0)}px`);
      face.style.setProperty('--fx-chromatic-offset', `${chromaticOffset.toFixed(2)}px`);
    },
    syncGaze,
  };
}

function syncGlitchFaceChildren(face: HTMLElement): void {
  for (const node of Array.from(face.childNodes)) {
    if (
      node instanceof HTMLCanvasElement
      && node.classList.contains('glitch-face-canvas')
    ) {
      continue;
    }
    face.removeChild(node);
  }
}
