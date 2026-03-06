import type { DonationConfirmRequest, DonationConfirmResponse, OkResponse, SpeakRequest, SpeakResponse } from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';

export interface AppActionsRuntime {
  bind(root: HTMLElement): void;
}

export function createAppActionsRuntime(store: AppStore): AppActionsRuntime {
  return {
    bind(root: HTMLElement): void {
      const wakeButton = root.querySelector<HTMLButtonElement>('#action-wake');
      const sleepButton = root.querySelector<HTMLButtonElement>('#action-sleep');
      const speakButton = root.querySelector<HTMLButtonElement>('#action-speak');
      const donateButton = root.querySelector<HTMLButtonElement>('#action-donate');
      const verbosityButton = root.querySelector<HTMLButtonElement>('#chat-verbosity-toggle');
      const streamDebugToggle = root.querySelector<HTMLButtonElement>('#stream-debug-toggle');
      const streamDebugClear = root.querySelector<HTMLButtonElement>('#stream-debug-clear');
      const speakInput = root.querySelector<HTMLInputElement>('#action-speak-text');
      const donationInput = root.querySelector<HTMLInputElement>('#action-donation-amount');

      if (!wakeButton || !sleepButton || !speakButton || !donateButton || !verbosityButton || !speakInput || !donationInput || !streamDebugToggle || !streamDebugClear) {
        return;
      }

      speakInput.oninput = () => {
        store.setState((current) => ({
          ...current,
          controlSpeakText: speakInput.value,
        }));
      };

      donationInput.oninput = () => {
        store.setState((current) => ({
          ...current,
          controlDonationAmount: donationInput.value,
        }));
      };

      wakeButton.onclick = async () => {
        await runAction(store, 'Wake', () => postJson<undefined, OkResponse>('/wake'));
      };

      sleepButton.onclick = async () => {
        await runAction(store, 'Sleep', () => postJson<undefined, OkResponse>('/sleep'));
      };

      speakButton.onclick = async () => {
        const text = store.getState().controlSpeakText.trim();
        if (!text) {
          store.appendLog('error', 'Enter text before using Speak');
          return;
        }
        await runAction(store, 'Speak', async () => {
          await postJson<SpeakRequest, SpeakResponse>('/speak', { text });
          store.setState((current) => ({
            ...current,
            controlSpeakText: '',
          }));
        });
      };

      donateButton.onclick = async () => {
        const amount = store.getState().controlDonationAmount.trim();
        await runAction(store, 'Donation', () => postJson<DonationConfirmRequest, DonationConfirmResponse>('/donations/confirm', {
          certainty: 'confident',
          source: 'ts-client-shell',
          ...(amount ? { amount, currency: 'USD' } : {}),
        }));
      };

      verbosityButton.onclick = () => {
        store.setState((current) => ({
          ...current,
          chatVerbosity: current.chatVerbosity === 'all'
            ? 'chat'
            : current.chatVerbosity === 'chat'
              ? 'minimal'
              : 'all',
        }));
      };

      streamDebugToggle.onclick = () => {
        store.setState((current) => {
          const enabled = !current.streamDebug.enabled;
          try {
            window.localStorage.setItem('tubs.streamDebugEnabled', enabled ? '1' : '0');
          } catch {
            // ignore storage errors
          }
          return {
            ...current,
            streamDebug: {
              ...current.streamDebug,
              enabled,
            },
          };
        });
      };

      streamDebugClear.onclick = () => {
        store.setState((current) => ({
          ...current,
          streamDebug: {
            ...current.streamDebug,
            entries: [],
            llmDeltas: 0,
            llmChars: 0,
            sentences: 0,
            ttsSentences: 0,
            ttsChars: 0,
            audioChunksIn: 0,
            audioBytesIn: 0,
            audioChunksPlayed: 0,
            audioSecondsPlayed: 0,
          },
        }));
      };
    },
  };
}

async function runAction(store: AppStore, label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    store.appendLog('info', `${label} request sent`);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${label} request failed`;
    store.appendLog('error', message);
  }
}
