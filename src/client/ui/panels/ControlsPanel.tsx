// Operator actions: speak a line, sleep/wake, mute, ambient sound.

import { PanelHeader } from './PanelHeader.js';
import type { JSX } from 'react';
import type { OkResponse, SpeakRequest, SpeakResponse } from '../../../shared/contracts/http.js';
import type { AppStore } from '../../state/app-state.js';
import { postJson } from '../../transport/http.js';
import { useAppSelector } from '../react-store.js';
import type { AppShellControls } from '../app-shell.js';
import { renderPanelCardClass } from './panel-card.js';

export function ControlsPanel({
  store,
  controls,
}: {
  store: AppStore;
  controls?: AppShellControls;
}): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    collapsed: Boolean(current.collapsedPanels.controls),
    chatVerbosity: current.chatVerbosity,
    ambientAudioEnabled: current.ambientAudioEnabled,
    sleeping: current.sleeping,
    controlSpeakText: current.controlSpeakText,
  }));

  return (
    <article className={renderPanelCardClass(state.collapsed)}>
      <PanelHeader store={store} panelKey="controls" title="Controls" meta="Actions" />
      <div className={`panel-body panel-content ${state.collapsed ? 'is-hidden' : ''}`}>
        <div className="face-actions">
          <div className="face-action-row">
            <button
              id="chat-verbosity-toggle"
              className={`button button-secondary button-compact ${state.chatVerbosity === 'all' ? 'is-active' : ''}`}
              type="button"
              onClick={() => {
                store.setState((current) => ({
                  ...current,
                  chatVerbosity: current.chatVerbosity === 'all'
                    ? 'chat'
                    : current.chatVerbosity === 'chat'
                      ? 'minimal'
                      : 'all',
                }));
              }}
            >
              Verbosity {state.chatVerbosity.toUpperCase()}
            </button>
            <button
              id="ambient-toggle"
              className={`button button-secondary button-compact ${state.ambientAudioEnabled ? 'is-active' : ''}`}
              type="button"
              onClick={async () => {
                await controls?.ambient?.toggleEnabled();
              }}
            >
              Ambient {state.ambientAudioEnabled ? 'On' : 'Off'}
            </button>
            <button
              id="action-wake"
              className="button button-secondary button-compact"
              type="button"
              onClick={async () => {
                await runControlAction(store, 'Wake', () => postJson<undefined, OkResponse>('/wake'));
              }}
            >
              {state.sleeping ? 'Wake' : 'Awake'}
            </button>
            <button
              id="action-sleep"
              className="button button-secondary button-compact"
              type="button"
              onClick={async () => {
                await runControlAction(store, 'Sleep', () => postJson<undefined, OkResponse>('/sleep'));
              }}
            >
              {state.sleeping ? 'Sleeping' : 'Sleep'}
            </button>
          </div>
          <div className="face-action-row">
            <input
              id="action-speak-text"
              className="face-name-input"
              type="text"
              placeholder="Line for Tubs to say"
              value={state.controlSpeakText}
              onChange={(event) => {
                const value = event.currentTarget.value;
                store.setState((current) => ({
                  ...current,
                  controlSpeakText: value,
                }));
              }}
            />
            <button
              id="action-speak"
              className="button button-compact"
              type="button"
              onClick={async () => {
                const text = store.getState().controlSpeakText.trim();
                if (!text) {
                  store.appendLog('error', 'Enter text before using Speak');
                  return;
                }
                await runControlAction(store, 'Speak', async () => {
                  await postJson<SpeakRequest, SpeakResponse>('/speak', { text });
                  store.setState((current) => ({
                    ...current,
                    controlSpeakText: '',
                  }));
                });
              }}
            >
              Speak
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

async function runControlAction(store: AppStore, label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    store.appendLog('info', `${label} request sent`);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${label} request failed`;
    store.appendLog('error', message);
  }
}
