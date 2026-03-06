import type { AppStore, PanelKey } from '../state/app-state.js';
import type { AppState, ChatEntry } from '../state/app-state.js';

export interface PanelRuntime {
  init(): void;
  bind(root: HTMLElement): void;
  dispose(): void;
}

const CHAT_PANEL_MIN_WIDTH = 320;
const CHAT_PANEL_MAX_WIDTH = 920;

export function createPanelRuntime(store: AppStore): PanelRuntime {
  let uptimeTimer: number | null = null;
  let dragCleanup: (() => void) | null = null;
  let lastEventLogsRef: AppState['logs'] | null = null;
  let lastChatEntriesRef: AppState['chatEntries'] | null = null;
  let lastChatVerbosity: AppState['chatVerbosity'] | null = null;
  let lastStreamDebugRef: AppState['streamDebug'] | null = null;

  return {
    init(): void {
      uptimeTimer = window.setInterval(() => {
        store.setState((current) => {
          if (current.sleeping) {
            return current;
          }

          return {
            ...current,
            awakeElapsedSec: Math.max(0, Math.floor((Date.now() - current.awakeSinceTs) / 1000)),
          };
        });
      }, 1000);
    },
    bind(root: HTMLElement): void {
      bindPanelToggles(root);
      bindChatResize(root);
      syncControlButtons(root);
      syncAssistantPanel(root);
      syncVoicePanel(root);
      syncChatPanel(root);
      syncStreamDebugPanel(root);
      syncEventLog(root);
    },
    dispose(): void {
      if (uptimeTimer != null) {
        window.clearInterval(uptimeTimer);
        uptimeTimer = null;
      }
      dragCleanup?.();
      dragCleanup = null;
    },
  };

  function bindPanelToggles(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('[data-panel-toggle]').forEach((button) => {
      button.onclick = () => {
        const key = button.dataset.panelToggle as PanelKey | undefined;
        if (!key) {
          return;
        }

        store.setState((current) => ({
          ...current,
          collapsedPanels: {
            ...current.collapsedPanels,
            [key]: !current.collapsedPanels[key],
          },
        }));
      };
    });
  }

  function bindChatResize(root: HTMLElement): void {
    const handle = root.querySelector<HTMLDivElement>('#chat-panel-resize');
    const panel = root.querySelector<HTMLElement>('#chat-panel-card');
    if (!handle || !panel) {
      dragCleanup?.();
      dragCleanup = null;
      return;
    }

    handle.onmousedown = (event: MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panel.getBoundingClientRect().width;

      const onMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = Math.max(CHAT_PANEL_MIN_WIDTH, Math.min(CHAT_PANEL_MAX_WIDTH, Math.round(startWidth + delta)));
        store.setState((current) => ({
          ...current,
          chatPanelWidth: nextWidth,
        }));
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      dragCleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  }

  function syncEventLog(root: HTMLElement): void {
    const list = root.querySelector<HTMLElement>('#event-log-list');
    if (!list) {
      return;
    }

    const logs = store.getState().logs;
    if (logs === lastEventLogsRef) {
      return;
    }
    lastEventLogsRef = logs;
    if (logs.length === 0) {
      list.innerHTML = '<li class="log"><span>No events yet.</span></li>';
      return;
    }

    list.innerHTML = logs.map((entry) => `
      <li class="log log-${entry.level}">
        <span class="log-time">${new Date(entry.ts).toLocaleTimeString()}</span>
        <span>${escapeHtml(entry.text)}</span>
      </li>
    `).join('');
  }

  function syncAssistantPanel(root: HTMLElement): void {
    const state = store.getState();
    setText(root, '#assistant-panel-meta', state.currentExpression);
    setText(root, '#assistant-expression-value', state.currentExpression);
    setText(root, '#assistant-sleep-value', state.sleeping ? 'asleep' : 'awake');
    setText(root, '#assistant-conversation-value', state.conversationActive ? 'active' : 'idle');
    setText(root, '#assistant-awake-value', formatAwakeElapsed(state.awakeElapsedSec));
    setText(root, '#assistant-turn-value', state.currentTurnId ?? 'n/a');
    setText(root, '#assistant-mood-value', `${state.moodPos.toFixed(2)} / ${state.moodNeg.toFixed(2)} / ${state.moodArousal.toFixed(2)}`);
    setText(root, '#assistant-user-copy', state.currentIncomingText || 'No incoming text yet.');
    setText(root, '#assistant-speech-copy', state.currentSpeechText || 'No spoken output yet.');
    setText(root, '#assistant-donation-copy', formatDonation(state));
  }

  function syncVoicePanel(root: HTMLElement): void {
    const state = store.getState();
    setText(root, '#voice-panel-meta', state.listenState);
    setText(root, '#voice-mic-value', state.micReady ? 'ready' : state.micDenied ? 'denied' : 'pending');
    setText(root, '#voice-state-value', state.listenState);
    setText(root, '#voice-wakeword-value', state.voiceWakeWordEnabled ? 'on' : 'off');
    setText(root, '#voice-mode-value', state.voiceHandsFreeEnabled ? 'hands-free' : 'push-to-talk');
    setText(root, '#voice-playback-value', state.audioPlaying ? 'speaking' : 'idle');
    setText(root, '#voice-last-transcript', state.voiceLastTranscript || 'Speak naturally or use push-to-talk to send a voice turn.');

    const meterBar = root.querySelector<HTMLElement>('#voice-meter-bar');
    if (meterBar) {
      meterBar.style.transform = `scaleX(${Math.max(0.05, state.micLevel).toFixed(3)})`;
    }

    const recordButton = root.querySelector<HTMLButtonElement>('#voice-record-button');
    if (recordButton) {
      const pending = !state.recording && (state.listenState === 'Uploading...' || state.listenState === 'Thinking...');
      recordButton.classList.toggle('button-live', state.recording);
      recordButton.classList.toggle('is-pending', pending);
      recordButton.textContent = state.recording
        ? 'Recording… release to send'
        : pending
          ? state.listenState
          : 'Push to Talk';
    }

    const wakeWordToggle = root.querySelector<HTMLInputElement>('#voice-wakeword-toggle');
    if (wakeWordToggle) {
      wakeWordToggle.checked = state.voiceWakeWordEnabled;
    }

    const handsFreeToggle = root.querySelector<HTMLInputElement>('#voice-handsfree-toggle');
    if (handsFreeToggle) {
      handsFreeToggle.checked = state.voiceHandsFreeEnabled;
    }
  }

  function syncChatPanel(root: HTMLElement): void {
    const state = store.getState();
    setText(root, '#chat-panel-meta', `${state.chatEntries.length} entries`);
    const list = root.querySelector<HTMLElement>('#chat-log-list');
    if (!list) {
      return;
    }

    if (state.chatEntries === lastChatEntriesRef && state.chatVerbosity === lastChatVerbosity) {
      return;
    }
    lastChatEntriesRef = state.chatEntries;
    lastChatVerbosity = state.chatVerbosity;

    const entries = state.chatEntries.filter((entry) => isChatEntryVisible(state, entry.type));
    if (entries.length === 0) {
      list.innerHTML = '<li class="log"><span>No chat yet.</span></li>';
      return;
    }

    list.innerHTML = entries.map((entry) => `
      <li class="chat-entry chat-${entry.type} chat-actor-${escapeHtml(resolveChatActor(entry))} ${entry.draft ? 'is-draft' : ''}">
        <span class="chat-time">${new Date(entry.ts).toLocaleTimeString()}</span>
        <span class="chat-text"><strong class="chat-speaker">${escapeHtml(renderChatPrefix(entry.type, entry.actor))}</strong> ${escapeHtml(entry.text)}</span>
      </li>
    `).join('');
  }

  function syncStreamDebugPanel(root: HTMLElement): void {
    const state = store.getState();
    const debug = state.streamDebug;
    setText(root, '#stream-debug-panel-meta', debug.enabled ? (debug.currentTurnId?.slice(0, 8) ?? 'none') : 'disabled');
    setText(root, '#stream-debug-llm-value', `${debug.llmDeltas}/${debug.llmChars}`);
    setText(root, '#stream-debug-sentences-value', String(debug.sentences));
    setText(root, '#stream-debug-tts-value', `${debug.ttsSentences}/${debug.ttsChars}`);
    setText(root, '#stream-debug-audio-in-value', `${debug.audioChunksIn}/${Math.round(debug.audioBytesIn / 1024)}KB`);
    setText(root, '#stream-debug-played-value', `${debug.audioChunksPlayed}/${debug.audioSecondsPlayed.toFixed(2)}s`);

    const list = root.querySelector<HTMLElement>('#stream-debug-list');
    if (!list) {
      return;
    }

    if (debug === lastStreamDebugRef) {
      return;
    }
    lastStreamDebugRef = debug;

    if (!debug.enabled) {
      list.innerHTML = '<li class="log"><span>Stream debug disabled.</span></li>';
      return;
    }

    if (debug.entries.length === 0) {
      list.innerHTML = '<li class="log"><span>No stream events yet.</span></li>';
      return;
    }

    list.innerHTML = debug.entries.map((entry) => `
      <li class="debug-entry">
        <span class="log-time">${new Date(entry.ts).toLocaleTimeString()}</span>
        <span>${escapeHtml(entry.stage)} ${escapeHtml(formatDebugPayload(entry.payload))}</span>
      </li>
    `).join('');
  }

  function syncControlButtons(root: HTMLElement): void {
    const state = store.getState();
    const micButton = root.querySelector<HTMLButtonElement>('#voice-enable-mic');
    const ambientButton = root.querySelector<HTMLButtonElement>('#ambient-toggle');
    const wakeButton = root.querySelector<HTMLButtonElement>('#action-wake');
    const sleepButton = root.querySelector<HTMLButtonElement>('#action-sleep');
    const fxButton = root.querySelector<HTMLButtonElement>('#fx-toggle');
    const streamDebugButton = root.querySelector<HTMLButtonElement>('#stream-debug-toggle');

    setButtonState(micButton, state.micReady, false);
    setButtonState(ambientButton, state.ambientAudioEnabled, false);
    setButtonState(wakeButton, !state.sleeping, false);
    setButtonState(sleepButton, state.sleeping, false);
    setButtonState(fxButton, Boolean(state.config?.glitchFxEnabled), false);
    setButtonState(streamDebugButton, state.streamDebug.enabled, false);

    if (micButton) {
      micButton.textContent = state.micReady ? 'Mic Ready' : 'Enable Mic';
    }
    if (ambientButton) {
      ambientButton.textContent = `Ambient ${state.ambientAudioEnabled ? 'On' : 'Off'}`;
    }
    if (wakeButton) {
      wakeButton.textContent = state.sleeping ? 'Wake' : 'Awake';
    }
    if (sleepButton) {
      sleepButton.textContent = state.sleeping ? 'Sleeping' : 'Sleep';
    }
    if (fxButton) {
      fxButton.textContent = state.config?.glitchFxEnabled ? 'Glitch On' : 'Glitch Off';
    }
    if (streamDebugButton) {
      streamDebugButton.textContent = state.streamDebug.enabled ? 'Debug On' : 'Debug Off';
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setText(root: HTMLElement, selector: string, value: string): void {
  const element = root.querySelector<HTMLElement>(selector);
  if (element) {
    element.textContent = value;
  }
}

function setButtonState(button: HTMLButtonElement | null, active: boolean, pending: boolean): void {
  if (!button) {
    return;
  }

  button.classList.toggle('is-active', active);
  button.classList.toggle('is-pending', pending);
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function isChatEntryVisible(state: AppState, type: ChatEntry['type']): boolean {
  if (state.chatVerbosity === 'chat') return type !== 'sys';
  if (state.chatVerbosity === 'minimal') return type === 'in';
  return true;
}

function renderChatPrefix(type: ChatEntry['type'], actor?: ChatEntry['actor']): string {
  if (type === 'in') return 'User';
  if (actor === 'small') return 'Mini';
  if (actor === 'main') return 'Tubs';
  if (type === 'sys' || actor === 'system') return 'System';
  return 'Tubs';
}

function formatDonation(state: AppState): string {
  const signal = state.currentDonationSignal;
  if (!signal) {
    return 'No signal';
  }
  const amount = signal.amount ? `${signal.amount}${signal.currency ? ` ${signal.currency}` : ''}` : null;
  return [signal.certainty, signal.source, amount, signal.donor].filter(Boolean).join(' · ');
}

function resolveChatActor(entry: ChatEntry): 'user' | 'main' | 'small' | 'system' {
  if (entry.actor === 'user' || entry.actor === 'main' || entry.actor === 'small' || entry.actor === 'system') {
    return entry.actor;
  }
  if (entry.type === 'in') return 'user';
  if (entry.type === 'sys') return 'system';
  return 'main';
}

function formatAwakeElapsed(totalSeconds: number): string {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatDebugPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([key]) => key !== 'ts')
    .slice(0, 5)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}
