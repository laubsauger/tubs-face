import type { WsClientMessage } from '../../shared/contracts/ws.js';
import type { AppStore } from '../state/app-state.js';

export const PROACTIVE_DELAY_MS = 45_000;
const PROACTIVE_COOLDOWN_MS = 60_000;
const PROACTIVE_JITTER_MS = 30_000;
// Each line nobody answers doubles the wait. Someone who ignored three lines
// wants to be left alone, and an empty room should not hear one a minute.
export const PROACTIVE_MAX_DELAY_MS = 10 * 60_000;
const PROACTIVE_MAX_DOUBLINGS = 4;
// The detector drops a face for a frame now and then; only a real absence
// means the next face is a new visitor.
const NEW_VISITOR_ABSENCE_MS = 10_000;

// Tubs speaks up because he has something to say, not to fish for engagement.
const KNOWN_PERSON_PROMPTS = [
  (name: string) => `${name} is nearby and quiet. Think out loud about something that has been on your mind.`,
  (name: string) => `${name} has been quiet for a while. Share a theory you have about them or about humans in general.`,
  (name: string) => `${name} is just standing there. Comment on the silence, or ignore them and muse about your own situation.`,
  (name: string) => `${name} is being quiet. Say a strong opinion you have been holding back.`,
];

const UNKNOWN_PERSON_PROMPTS = [
  'Someone is nearby but has not spoken. Think out loud about something that has been on your mind.',
  'A stranger is standing there silently. Form a theory about who they are and say it.',
  'Someone is in the room, not talking. Say a strong opinion you have been holding back.',
  'Person detected, zero words spoken. Comment on the silence, or muse about your own situation.',
];

export interface ProactiveRuntime {
  init(send: (message: WsClientMessage) => void): void;
  /** Tubs or the visitor said something; the silence starts over. */
  onActivity(): void;
  /** The visitor spoke, so the last proactive line was answered. */
  onUserTurn(): void;
  dispose(): void;
}

export function createProactiveRuntime(store: AppStore): ProactiveRuntime {
  let proactiveTimer: number | null = null;
  let lastProactiveAt = 0;
  let unanswered = 0;
  let absentSince = 0;
  let sendMessage: ((message: WsClientMessage) => void) | null = null;
  const unsubscribers: Array<() => void> = [];

  return {
    init(send): void {
      sendMessage = send;
      // Only real changes restart the wait. (It used to restart on every server
      // message, including the 5 s keep-alive ping, so it never fired.)
      unsubscribers.push(store.subscribeSelector(
        (state) => state.faceLastDetectedCount > 0,
        (present) => {
          cancel();
          if (!present) {
            absentSince = Date.now();
          } else if (absentSince && Date.now() - absentSince >= NEW_VISITOR_ABSENCE_MS) {
            // A new person gets a fresh start.
            unanswered = 0;
          }
          schedule();
        },
        { fireImmediately: false },
      ));
      unsubscribers.push(store.subscribeSelector(
        (state) => state.sleeping,
        () => {
          cancel();
          schedule();
        },
        { fireImmediately: false },
      ));
      schedule();
    },
    onActivity(): void {
      cancel();
      schedule();
    },
    onUserTurn(): void {
      unanswered = 0;
      cancel();
      schedule();
    },
    dispose(): void {
      cancel();
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    },
  };

  function backoff(): number {
    return 2 ** Math.min(unanswered, PROACTIVE_MAX_DOUBLINGS);
  }

  function schedule(): void {
    const state = store.getState();
    // Not checking audioPlaying here: activity arrives while Tubs is still
    // talking, and tryProactiveChat waits for the audio anyway.
    if (proactiveTimer != null || state.sleeping || state.faceLastDetectedCount === 0) {
      return;
    }
    const jitter = Math.floor(Math.random() * PROACTIVE_JITTER_MS);
    const delay = Math.min(PROACTIVE_MAX_DELAY_MS, (PROACTIVE_DELAY_MS + jitter) * backoff());
    proactiveTimer = window.setTimeout(() => {
      proactiveTimer = null;
      tryProactiveChat();
    }, delay);
  }

  function cancel(): void {
    if (proactiveTimer != null) {
      clearTimeout(proactiveTimer);
      proactiveTimer = null;
    }
  }

  function tryProactiveChat(): void {
    const state = store.getState();
    // Not while someone is mid-onboarding in front of the camera.
    if (state.sleeping || state.audioPlaying || state.faceLastDetectedCount === 0 || state.faceEnrollOpen) {
      schedule();
      return;
    }
    if (Date.now() - lastProactiveAt < PROACTIVE_COOLDOWN_MS) {
      schedule();
      return;
    }

    lastProactiveAt = Date.now();
    unanswered += 1;
    const names = state.faceLastFaces.map((face) => face.name).filter((name): name is string => Boolean(name));
    const context = names.length > 0
      ? pickRandom(KNOWN_PERSON_PROMPTS)(names.join(' and '))
      : pickRandom(UNKNOWN_PERSON_PROMPTS);

    store.appendLog('info', `Proactive: ${context}`);
    sendMessage?.({
      type: 'proactive',
      context,
      ...(names.length > 0 ? { faces: names } : {}),
    });
    schedule();
  }
}

function pickRandom<T>(values: T[]): T {
  return values[Math.floor(Math.random() * values.length)] as T;
}
