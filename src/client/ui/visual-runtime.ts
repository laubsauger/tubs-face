import type { DonationSignalPayload } from '../../shared/contracts/ws.js';
import type { AppStore } from '../state/app-state.js';

export interface VisualRuntime {
  bind(root: HTMLElement): void;
}

export function createVisualRuntime(store: AppStore): VisualRuntime {
  return {
    bind(root: HTMLElement): void {
      const face = root.querySelector<HTMLElement>('#visual-face');
      const bubble = root.querySelector<HTMLElement>('#visual-speech-bubble');
      const donationCard = root.querySelector<HTMLElement>('#visual-donation-card');
      const donationHandle = root.querySelector<HTMLElement>('#visual-donation-handle');
      const donationAmount = root.querySelector<HTMLElement>('#visual-donation-amount');
      const donationQr = root.querySelector<HTMLImageElement>('#visual-donation-qr');
      const subtitle = root.querySelector<HTMLElement>('#visual-subtitle');
      const state = store.getState();

      document.body.classList.toggle('app-sleeping', state.sleeping);

      if (face) {
        face.dataset.expression = state.currentExpression;
        face.dataset.idleVariant = state.idleVariant;
        face.classList.toggle('is-speaking', state.audioPlaying);
        face.classList.toggle('is-sleeping', state.sleeping);
        face.classList.toggle('is-blinking', state.blinkActive);
        face.classList.toggle('is-glitch-enabled', Boolean(state.config?.glitchFxEnabled));
        face.style.setProperty('--gaze-x', state.gazeX.toFixed(4));
        face.style.setProperty('--gaze-y', state.gazeY.toFixed(4));
        face.style.setProperty('--mood-pos', state.moodPos.toFixed(3));
        face.style.setProperty('--mood-neg', state.moodNeg.toFixed(3));
        face.style.setProperty('--mood-arousal', state.moodArousal.toFixed(3));
        face.style.setProperty('--fx-base-color', state.config?.glitchFxBaseColor ?? state.fxBaseColorDraft);
        face.style.setProperty('--fx-scanline-intensity', state.fxScanlineIntensity.toFixed(3));
        face.style.setProperty('--fx-pixel-jitter', `${state.fxPixelJitter.toFixed(2)}px`);
        face.style.setProperty('--fx-flicker-depth', state.fxFlickerDepth.toFixed(3));
        face.style.setProperty('--fx-glow-strength', `${state.fxGlowStrength.toFixed(0)}px`);
        face.style.setProperty('--fx-chromatic-offset', `${state.fxChromaticOffset.toFixed(2)}px`);
      }

      if (bubble) {
        const speech = state.currentSpeechText.trim();
        bubble.textContent = speech;
        bubble.classList.toggle('is-visible', speech.length > 0 && !state.audioPlaying);
      }

      if (subtitle) {
        subtitle.classList.toggle('is-hidden', state.sleeping);
      }

      syncDonationCard(
        donationCard,
        donationHandle,
        donationAmount,
        donationQr,
        state.currentDonationSignal,
        state.sleeping,
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
): void {
  if (!card || !handleNode || !amountNode || !qrNode) {
    return;
  }

  if (!signal || sleeping) {
    card.classList.remove('is-visible');
    return;
  }

  const venmoHandle = sanitizeHandle(signal.source === 'ts-client-shell' ? 'TubsBot' : 'TubsBot');
  const amount = signal.amount ? `${signal.amount}${signal.currency ? ` ${signal.currency}` : ''}` : 'Wheel fund';

  handleNode.textContent = `Venmo ${venmoHandle}`;
  amountNode.textContent = `${signal.certainty.toUpperCase()}${signal.donor ? ` · ${signal.donor}` : ''}${amount ? ` · ${amount}` : ''}`;
  qrNode.src = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(`https://venmo.com/${venmoHandle.replace(/^@/, '')}`)}`;
  card.classList.add('is-visible');
}

function sanitizeHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) {
    return '@TubsBot';
  }
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}
