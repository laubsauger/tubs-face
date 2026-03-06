import type { EmotionCue, ExpressionName } from '../../shared/contracts/config.js';
import type { ManualTurnScriptRequest, ManualTurnScriptResponse } from '../../shared/contracts/http.js';
import type { TurnAction, TurnBeat } from '../../shared/contracts/turn-script.js';
import type { AppState, AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';

export interface ManualRuntime {
  bind(root: HTMLElement): void;
}

const SUPPORTED_EMOJI_CUES = new Set<EmotionCue>(['🙂', '😄', '😏', '🥺', '😢', '😤', '🤖', '🫶']);
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
      text: 'If you feel generous today, I still accept wheel money with romance.',
      emotion: { expression: 'smile', emoji: '😏' },
    },
  ],
};

export function createManualRuntime(store: AppStore): ManualRuntime {
  return {
    bind(root: HTMLElement): void {
      const toggle = root.querySelector<HTMLButtonElement>('#manual-beats-toggle');
      const mode = root.querySelector<HTMLSelectElement>('#manual-beats-mode');
      const actor = root.querySelector<HTMLSelectElement>('#manual-beat-actor');
      const action = root.querySelector<HTMLSelectElement>('#manual-beat-action');
      const expression = root.querySelector<HTMLInputElement>('#manual-beat-expression');
      const emoji = root.querySelector<HTMLInputElement>('#manual-beat-emoji');
      const delay = root.querySelector<HTMLInputElement>('#manual-beat-delay');
      const text = root.querySelector<HTMLTextAreaElement>('#manual-beat-text');
      const script = root.querySelector<HTMLTextAreaElement>('#manual-script-json');
      const send = root.querySelector<HTMLButtonElement>('#manual-beats-send');
      const template = root.querySelector<HTMLButtonElement>('#manual-beats-template');
      const clear = root.querySelector<HTMLButtonElement>('#manual-beats-clear');

      if (!toggle || !mode || !actor || !action || !expression || !emoji || !delay || !text || !script || !send || !template || !clear) {
        return;
      }

      toggle.onclick = () => {
        store.setState((current) => ({
          ...current,
          manualComposerOpen: !current.manualComposerOpen,
        }));
      };

      mode.onchange = () => {
        store.setState((current) => ({
          ...current,
          manualComposerMode: mode.value === 'script' ? 'script' : 'single',
          manualStatus: 'Ready',
          manualStatusKind: 'idle',
        }));
      };

      actor.onchange = () => patchManual({ manualActor: actor.value === 'small' ? 'small' : 'main' });
      action.onchange = () => patchManual({ manualAction: normalizeAction(action.value) });
      expression.oninput = () => patchManual({ manualExpression: expression.value });
      emoji.oninput = () => patchManual({ manualEmoji: emoji.value });
      delay.oninput = () => patchManual({ manualDelay: delay.value });
      text.oninput = () => patchManual({ manualText: text.value });
      script.oninput = () => patchManual({ manualScript: script.value });

      template.onclick = () => {
        const state = store.getState();
        if (state.manualComposerMode === 'script') {
          patchManual({
            manualScript: JSON.stringify(VALENTINE_TEMPLATE, null, 2),
            manualStatus: 'Template loaded',
            manualStatusKind: 'ok',
          });
          return;
        }

        patchManual({
          manualActor: 'main',
          manualAction: 'speak',
          manualExpression: 'love',
          manualEmoji: '🫶',
          manualDelay: '',
          manualText: "Happy Valentine's Day from Tubs. Hearts, hype, and electric-wheel dreams.",
          manualStatus: 'Template loaded',
          manualStatusKind: 'ok',
        });
      };

      clear.onclick = () => {
        patchManual({
          manualExpression: '',
          manualEmoji: '',
          manualDelay: '',
          manualText: '',
          manualScript: '',
          manualStatus: 'Cleared',
          manualStatusKind: 'idle',
        });
      };

      send.onclick = async () => {
        await submitManualBeats();
      };

      const submitOnChord = async (event: KeyboardEvent) => {
        if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) {
          return;
        }
        event.preventDefault();
        await submitManualBeats();
      };

      text.onkeydown = submitOnChord;
      script.onkeydown = submitOnChord;
    },
  };

  function patchManual(patch: Partial<AppState>): void {
    store.setState((current) => ({
      ...current,
      ...patch,
    }));
  }

  async function submitManualBeats(): Promise<void> {
    patchManual({
      manualSending: true,
      manualStatus: 'Sending...',
      manualStatusKind: 'busy',
    });

    try {
      const payload = buildPayload(store.getState());
      const result = await postJson<ManualTurnScriptRequest, ManualTurnScriptResponse>('/turn-script/manual', payload);
      const noun = result.beatCount === 1 ? 'beat' : 'beats';
      patchManual({
        manualSending: false,
        manualStatus: `Queued ${result.beatCount} ${noun} (${result.turnId})`,
        manualStatusKind: 'ok',
      });
      store.appendLog('info', `Manual turn queued (${result.beatCount} ${noun})`);
    } catch (error) {
      patchManual({
        manualSending: false,
        manualStatus: error instanceof Error ? error.message : 'Failed to queue manual turn',
        manualStatusKind: 'error',
      });
      store.appendLog('error', error instanceof Error ? error.message : 'Failed to queue manual turn');
    }
  }
}

function buildPayload(state: ReturnType<AppStore['getState']>): ManualTurnScriptRequest {
  if (state.manualComposerMode === 'script') {
    return parseScriptPayload(state.manualScript);
  }

  return {
    beats: [parseSingleBeat(state)],
  };
}

function parseSingleBeat(state: ReturnType<AppStore['getState']>): TurnBeat {
  const beat: TurnBeat = {
    actor: state.manualActor,
    action: state.manualAction,
  };

  const text = cleanText(state.manualText);
  if (beat.action === 'speak' && !text) {
    throw new Error('Text is required for speak beats');
  }
  if (text) {
    beat.text = text;
  }

  const delayMs = parseDelayMs(state.manualDelay);
  if (delayMs != null) {
    beat.delayMs = delayMs;
  }

  const expression = cleanText(state.manualExpression).toLowerCase();
  const emoji = cleanText(state.manualEmoji);
  if (emoji && !SUPPORTED_EMOJI_CUES.has(emoji as EmotionCue)) {
    throw new Error('Unsupported emoji cue');
  }

  if (expression || emoji) {
    beat.emotion = {
      ...(expression ? { expression: expression as ExpressionName } : {}),
      ...(emoji ? { emoji: emoji as EmotionCue } : {}),
    };
  }

  return beat;
}

function parseScriptPayload(raw: string): ManualTurnScriptRequest {
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error('Script JSON is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Script JSON is invalid');
  }

  if (Array.isArray(parsed)) {
    return { beats: parsed as TurnBeat[] };
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as { beats?: TurnBeat[]; turn_script?: { beats?: TurnBeat[] } };
    if (Array.isArray(record.beats)) {
      return { beats: record.beats };
    }
    if (Array.isArray(record.turn_script?.beats)) {
      return { beats: record.turn_script.beats };
    }
  }

  throw new Error('Script JSON must be an array or include beats[]');
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDelayMs(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Delay must be a number between 120 and 8000');
  }

  return Math.max(120, Math.min(8000, Math.round(parsed)));
}

function normalizeAction(value: string): TurnAction {
  return value === 'react' || value === 'wait' ? value : 'speak';
}
