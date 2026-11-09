import type { WsServerMessage } from '../../shared/contracts/ws.js';
import type { AppState, AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';

const TICK_MS = 1000;
/** Messages that mean someone is interacting with Tubs right now. */
const ACTIVITY_MESSAGES = new Set<WsServerMessage['type']>(['incoming', 'turn_start', 'speak', 'audio_chunk', 'turn_script']);

export interface SleepRuntime {
  init(): void;
  dispose(): void;
  onServerMessage(message: WsServerMessage): void;
  /**
   * Another page decides (studio mode: the studio listener has the mic and
   * the camera; the operator face window, idle by then, would put Tubs to
   * sleep in the middle of a conversation it doesn't hear).
   */
  setDeferred(deferred: boolean): void;
}

export interface SleepRuntimeOptions {
  /** More that keeps Tubs awake, e.g. either studio head talking. */
  busy?: () => boolean;
}

/**
 * Auto-sleep from main: after config.sleepTimeout without activity Tubs goes
 * to sleep, unless someone is in view, it is talking or listening, or a
 * conversation is still open. A face, speech (with always-listen on), a key
 * or a new turn wakes it. Sleep and wake go through the server so the mini
 * display and spectators follow.
 */
export function createSleepRuntime(store: AppStore, options: SleepRuntimeOptions = {}): SleepRuntime {
  let deferred = false;
  let lastActivityAt = Date.now();
  let tickTimer: number | undefined;
  let pendingRequest: 'sleep' | 'wake' | null = null;
  const unsubscribers: Array<() => void> = [];

  const noteActivity = () => {
    lastActivityAt = Date.now();
  };

  const wake = (reason: string) => {
    noteActivity();
    if (!store.getState().sleeping || pendingRequest === 'wake') return;
    pendingRequest = 'wake';
    store.appendLog('info', `Waking up (${reason})`);
    void postJson('/wake').catch(() => {}).finally(() => { pendingRequest = null; });
  };

  const onKey = (event: KeyboardEvent) => {
    noteActivity();
    // Escape toggles sleep itself in window-runtime.
    if (event.code !== 'Escape') wake('key');
  };
  const onPresence = () => wake('voice');

  function isBusy(state: AppState, now: number): boolean {
    return state.faceLastDetectedCount > 0
      || state.audioPlaying
      || state.recording
      || state.listenState === 'Uploading...'
      || state.listenState === 'Thinking...'
      || state.fxEditorOpen
      || state.faceEnrollOpen
      || now < state.conversationUntil
      || (options.busy?.() ?? false);
  }

  function tick(): void {
    const state = store.getState();
    const now = Date.now();
    if (state.conversationActive && now >= state.conversationUntil) {
      store.setState((current) => ({ ...current, conversationActive: false }));
    }
    if (deferred) return;
    if (state.sleeping) {
      // Someone in view wakes Tubs, also one who was there all along (the
      // edge below fires only when the count goes from 0 to more).
      if (state.faceLastDetectedCount > 0) wake('face');
      return;
    }
    if (isBusy(state, now)) {
      noteActivity();
      return;
    }
    const timeoutMs = state.config?.sleepTimeout ?? 0;
    if (timeoutMs > 0 && now - lastActivityAt >= timeoutMs && pendingRequest !== 'sleep') {
      pendingRequest = 'sleep';
      store.appendLog('info', `Going to sleep after ${Math.round(timeoutMs / 1000)} s idle`);
      void postJson('/sleep').catch(() => {}).finally(() => { pendingRequest = null; });
    }
  }

  return {
    init(): void {
      tickTimer = window.setInterval(tick, TICK_MS);
      window.addEventListener('keydown', onKey);
      window.addEventListener('pointerdown', noteActivity);
      window.addEventListener('tubs:voice-presence', onPresence);
      unsubscribers.push(store.subscribeSelector(
        (state) => state.faceLastDetectedCount > 0,
        (present) => { if (present) wake('face'); },
      ));
      unsubscribers.push(store.subscribeSelector(
        (state) => state.sleeping,
        (sleeping) => { if (!sleeping) noteActivity(); },
      ));
    },
    dispose(): void {
      window.clearInterval(tickTimer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', noteActivity);
      window.removeEventListener('tubs:voice-presence', onPresence);
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    },
    setDeferred(next: boolean): void {
      deferred = next;
      noteActivity();
    },
    onServerMessage(message: WsServerMessage): void {
      if (!ACTIVITY_MESSAGES.has(message.type)) return;
      if (message.type === 'incoming' || message.type === 'turn_start') {
        wake('turn');
      } else {
        noteActivity();
      }
    },
  };
}
