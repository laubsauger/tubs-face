import type { DonationSignalPayload } from '../../shared/contracts/ws.js';
import type { AppStore } from '../state/app-state.js';
import { renderFaceVisualMarkup } from './face-visual.js';

export interface VisualRuntime {
  bind(root: HTMLElement): void;
}

export function createVisualRuntime(store: AppStore, mode: 'main' | 'mini'): VisualRuntime {
  let lastDonationQrSrc = '';
  let lastFaceMarkup = '';
  return {
    bind(root: HTMLElement): void {
      const face = root.querySelector<HTMLElement>('#visual-face');
      const donationCard = root.querySelector<HTMLElement>('#visual-donation-card');
      const donationHandle = root.querySelector<HTMLElement>('#visual-donation-handle');
      const donationAmount = root.querySelector<HTMLElement>('#visual-donation-amount');
      const donationQr = root.querySelector<HTMLImageElement>('#visual-donation-qr');
      const subtitle = root.querySelector<HTMLElement>('#visual-subtitle');
      const liveTranscript = root.querySelector<HTMLElement>('#visual-live-transcript');
      const state = store.getState();

      document.body.classList.toggle('app-sleeping', state.sleeping);

      if (face) {
        const config = state.config;
        const nextMarkup = renderFaceVisualMarkup(state);
        const chromaticOffset = Math.max(
          Math.abs(config?.glitchChromaticOffsetX ?? 0),
          Math.abs(config?.glitchChromaticOffsetY ?? 4.5),
        );
        if (nextMarkup !== lastFaceMarkup) {
          face.innerHTML = nextMarkup;
          lastFaceMarkup = nextMarkup;
        }
        face.dataset.expression = state.currentExpression;
        face.dataset.idleVariant = state.idleVariant;
        face.dataset.renderMode = config?.faceRenderMode ?? 'css';
        face.dataset.renderQuality = config?.renderQuality ?? 'high';
        face.classList.toggle('is-speaking', state.audioPlaying);
        face.classList.toggle('is-sleeping', state.sleeping);
        face.classList.toggle('is-blinking', state.blinkActive);
        face.classList.toggle('is-glitch-enabled', Boolean(config?.glitchFxEnabled));
        face.style.setProperty('--gaze-x', state.gazeX.toFixed(4));
        face.style.setProperty('--gaze-y', state.gazeY.toFixed(4));
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
      }

      if (subtitle) {
        subtitle.classList.toggle('is-hidden', state.sleeping);
      }

      if (liveTranscript) {
        liveTranscript.textContent = state.liveTranscriptText;
        liveTranscript.classList.toggle('is-visible', state.liveTranscriptText.trim().length > 0);
        liveTranscript.classList.toggle('is-draft', state.liveTranscriptDraft);
      }

      lastDonationQrSrc = syncDonationCard(
        donationCard,
        donationHandle,
        donationAmount,
        donationQr,
        state.currentDonationSignal,
        state.sleeping,
        lastDonationQrSrc,
      );
    },
  };
}

function syncDonationCard(
  card: HTMLElement | null,
  handleNode: HTMLElement | null,
  amountNode: HTMLElement | null,
  qrNode: HTMLImageElement | null,
  signal: DonationSignalPayload | null,
  sleeping: boolean,
  prevQrSrc: string,
): string {
  if (!card || !handleNode || !amountNode || !qrNode) {
    return prevQrSrc;
  }

  if (!signal || sleeping) {
    card.classList.remove('is-visible');
    return '';
  }

  const venmoHandle = sanitizeHandle(signal.source === 'ts-client-shell' ? 'TubsBot' : 'TubsBot');
  const amount = signal.amount ? `${signal.amount}${signal.currency ? ` ${signal.currency}` : ''}` : 'Wheel fund';

  handleNode.textContent = `Venmo ${venmoHandle}`;
  amountNode.textContent = `${signal.certainty.toUpperCase()}${signal.donor ? ` · ${signal.donor}` : ''}${amount ? ` · ${amount}` : ''}`;
  const nextQrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(`https://venmo.com/${venmoHandle.replace(/^@/, '')}`)}`;
  if (nextQrSrc !== prevQrSrc) {
    qrNode.src = nextQrSrc;
  }
  card.classList.add('is-visible');
  return nextQrSrc;
}

function sanitizeHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) {
    return '@TubsBot';
  }
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}
