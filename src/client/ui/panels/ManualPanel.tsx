// Manual Beats: type a line or a whole beat script and send it as a turn.

import { PanelHeader } from './PanelHeader.js';
import type { JSX } from 'react';
import type { ManualTurnScriptRequest, ManualTurnScriptResponse } from '../../../shared/contracts/http.js';
import type { AppStore } from '../../state/app-state.js';
import { postJson } from '../../transport/http.js';
import { useAppSelector } from '../react-store.js';
import { normalizeManualAction, parseScriptPayload, parseSingleBeat } from '../manual-beats.js';

export function ManualPanel({ store }: { store: AppStore }): JSX.Element {
  const state = useAppSelector(store, (current) => ({
    manualComposerMode: current.manualComposerMode,
    manualActor: current.manualActor,
    manualAction: current.manualAction,
    manualExpression: current.manualExpression,
    manualEmoji: current.manualEmoji,
    manualDelay: current.manualDelay,
    manualText: current.manualText,
    manualScript: current.manualScript,
    manualStatus: current.manualStatus,
    manualStatusKind: current.manualStatusKind,
    manualSending: current.manualSending,
  }));

  return (
    <article className="dock-section">
      <PanelHeader title="Manual Beats" meta={state.manualStatus} />
      <div className="panel-body panel-content">
        <div className="manual-beats-row">
          <select
            id="manual-beats-mode"
            className="mini-select"
            value={state.manualComposerMode}
            onChange={(event) => {
              const value = event.currentTarget.value === 'script' ? 'script' : 'single';
              store.setState((current) => ({
                ...current,
                manualComposerMode: value,
                manualStatus: 'Ready',
                manualStatusKind: 'idle',
              }));
            }}
          >
            <option value="single">Single Beat</option>
            <option value="script">Script JSON</option>
          </select>
        </div>
        <div className="manual-beats-shell is-open">
          <div id="manual-single-fields" className={`manual-fields-grid ${state.manualComposerMode === 'script' ? 'is-hidden' : ''}`}>
            <div className="manual-beats-row">
              <label className="manual-field">
                <span>Actor</span>
                <select
                  id="manual-beat-actor"
                  className="mini-select"
                  value={state.manualActor}
                  onChange={(event) => {
                    const value = event.currentTarget.value === 'small' ? 'small' : 'main';
                    store.setState((current) => ({
                      ...current,
                      manualActor: value,
                    }));
                  }}
                >
                  <option value="main">Main</option>
                  <option value="small">Small</option>
                </select>
              </label>
              <label className="manual-field">
                <span>Action</span>
                <select
                  id="manual-beat-action"
                  className="mini-select"
                  value={state.manualAction}
                  onChange={(event) => {
                    store.setState((current) => ({
                      ...current,
                      manualAction: normalizeManualAction(event.currentTarget.value),
                    }));
                  }}
                >
                  <option value="speak">Speak</option>
                  <option value="react">React</option>
                  <option value="wait">Wait</option>
                </select>
              </label>
            </div>
            <div className="manual-beats-row">
              <label className="manual-field">
                <span>Expression</span>
                <input
                  id="manual-beat-expression"
                  className="face-name-input"
                  type="text"
                  value={state.manualExpression}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    store.setState((current) => ({
                      ...current,
                      manualExpression: value,
                    }));
                  }}
                />
              </label>
              <label className="manual-field">
                <span>Emoji</span>
                <input
                  id="manual-beat-emoji"
                  className="face-name-input"
                  type="text"
                  value={state.manualEmoji}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    store.setState((current) => ({
                      ...current,
                      manualEmoji: value,
                    }));
                  }}
                />
              </label>
            </div>
            <div className="manual-beats-row">
              <label className="manual-field">
                <span>Delay Ms</span>
                <input
                  id="manual-beat-delay"
                  className="face-name-input"
                  type="text"
                  value={state.manualDelay}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    store.setState((current) => ({
                      ...current,
                      manualDelay: value,
                    }));
                  }}
                />
              </label>
            </div>
            <label className="manual-field">
              <span>Text</span>
              <textarea
                id="manual-beat-text"
                className="manual-textarea"
                rows={4}
                value={state.manualText}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  store.setState((current) => ({
                    ...current,
                    manualText: value,
                  }));
                }}
                onKeyDown={async (event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    await submitManualBeats(store);
                  }
                }}
              />
            </label>
          </div>
          <div id="manual-script-fields" className={state.manualComposerMode === 'script' ? '' : 'is-hidden'}>
            <label className="manual-field">
              <span>Script JSON</span>
              <textarea
                id="manual-script-json"
                className="manual-textarea"
                rows={10}
                value={state.manualScript}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  store.setState((current) => ({
                    ...current,
                    manualScript: value,
                  }));
                }}
                onKeyDown={async (event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    await submitManualBeats(store);
                  }
                }}
              />
            </label>
          </div>
          <div className="manual-beats-actions">
            <button
              id="manual-beats-send"
              className="button"
              type="button"
              disabled={state.manualSending}
              onClick={async () => {
                await submitManualBeats(store);
              }}
            >
              {state.manualSending ? 'Sending...' : 'Send'}
            </button>
            <button
              id="manual-beats-template"
              className="button button-secondary"
              type="button"
              onClick={() => {
                applyManualTemplate(store);
              }}
            >
              Valentine
            </button>
            <button
              id="manual-beats-clear"
              className="button button-secondary"
              type="button"
              onClick={() => {
                store.setState((current) => ({
                  ...current,
                  manualExpression: '',
                  manualEmoji: '',
                  manualDelay: '',
                  manualText: '',
                  manualScript: '',
                  manualStatus: 'Cleared',
                  manualStatusKind: 'idle',
                }));
              }}
            >
              Clear
            </button>
          </div>
          <div className={`manual-beats-status ${renderManualStatusClass(state.manualStatusKind)}`}>{state.manualStatus}</div>
        </div>
      </div>
    </article>
  );
}

function renderManualStatusClass(kind: 'idle' | 'ok' | 'error' | 'busy'): string {
  return kind === 'ok'
    ? 'is-ok'
    : kind === 'error'
      ? 'is-error'
      : kind === 'busy'
        ? 'is-busy'
        : '';
}

const VALENTINE_TEMPLATE: ManualTurnScriptRequest = {
  beats: [
    {
      actor: 'main',
      action: 'speak',
      text: "Happy Valentine's Day, beautiful humans. Tubs is in full love mode.",
      emotion: { expression: 'love', emoji: '🫶' },
    },
    {
      actor: 'small',
      action: 'react',
      text: 'Heart lasers online.',
      emotion: { expression: 'happy', emoji: '😄' },
      delayMs: 700,
    },
    {
      actor: 'small',
      action: 'speak',
      text: 'Somebody here is getting a valentine from a plastic tub. Brace yourselves.',
      emotion: { expression: 'smile', emoji: '😏' },
    },
  ],
};

function applyManualTemplate(store: AppStore): void {
  const state = store.getState();
  if (state.manualComposerMode === 'script') {
    store.setState((current) => ({
      ...current,
      manualScript: JSON.stringify(VALENTINE_TEMPLATE, null, 2),
      manualStatus: 'Template loaded',
      manualStatusKind: 'ok',
    }));
    return;
  }

  store.setState((current) => ({
    ...current,
    manualActor: 'main',
    manualAction: 'speak',
    manualExpression: 'love',
    manualEmoji: '🫶',
    manualDelay: '',
    manualText: "Happy Valentine's Day from Tubs. Hearts, hype, and questionable romance.",
    manualStatus: 'Template loaded',
    manualStatusKind: 'ok',
  }));
}

async function submitManualBeats(store: AppStore): Promise<void> {
  store.setState((current) => ({
    ...current,
    manualSending: true,
    manualStatus: 'Sending...',
    manualStatusKind: 'busy',
  }));

  try {
    const payload = buildManualPayload(store.getState());
    const result = await postJson<ManualTurnScriptRequest, ManualTurnScriptResponse>('/turn-script/manual', payload);
    const noun = result.beatCount === 1 ? 'beat' : 'beats';
    store.setState((current) => ({
      ...current,
      manualSending: false,
      manualStatus: `Queued ${result.beatCount} ${noun} (${result.turnId})`,
      manualStatusKind: 'ok',
    }));
    store.appendLog('info', `Manual turn queued (${result.beatCount} ${noun})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to queue manual turn';
    store.setState((current) => ({
      ...current,
      manualSending: false,
      manualStatus: message,
      manualStatusKind: 'error',
    }));
    store.appendLog('error', message);
  }
}

function buildManualPayload(state: ReturnType<AppStore['getState']>): ManualTurnScriptRequest {
  if (state.manualComposerMode === 'script') {
    return parseScriptPayload(state.manualScript);
  }

  return {
    beats: [parseSingleBeat(state)],
  };
}
