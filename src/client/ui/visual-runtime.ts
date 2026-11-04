import type { AppStore } from '../state/app-state.js';

/**
 * Owns the `#visual-face` element only: its data attributes and
 * CSS variables. Overlays (subtitle visibility, live transcript)
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
      syncGlitchFaceChildren(face);
      face.dataset.expression = state.currentExpression;
      face.dataset.renderQuality = config?.renderQuality ?? 'high';
      face.classList.toggle('is-speaking', state.audioPlaying);
      face.classList.toggle('is-sleeping', state.sleeping);
      face.classList.toggle('is-blinking', state.blinkActive);
      syncGaze();
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
