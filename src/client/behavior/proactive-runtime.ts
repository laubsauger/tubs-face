import type { WsClientMessage } from '../../shared/contracts/ws.js';
import type { AppStore } from '../state/app-state.js';

const PROACTIVE_DELAY_MS = 45_000;
const PROACTIVE_COOLDOWN_MS = 60_000;
const PROACTIVE_JITTER_MS = 30_000;

const KNOWN_PERSON_PROMPTS = [
  (name: string) => `${name} is standing nearby, silent. Say something that makes it impossible not to reply.`,
  (name: string) => `${name} has been quiet for a while. Make a weird observation or ask something unexpected.`,
  (name: string) => `${name} is just standing there. Tease them about the silence or make up a theory about what they're thinking.`,
  (name: string) => `${name} is being quiet. Challenge them to something small and silly, or share a wild opinion.`,
];

const UNKNOWN_PERSON_PROMPTS = [
  'Someone is nearby but has not spoken. Break the ice with something unexpected.',
  'A stranger is standing there silently. Say something that demands a response.',
  'You can see someone but they will not talk. Make a wild guess about who they are or what they want.',
  'Person detected, zero words spoken. React to the awkward silence.',
];

export interface ProactiveRuntime {
  init(send: (message: WsClientMessage) => void): void;
  onActivity(): void;
  onPresenceChanged(): void;
  dispose(): void;
}

export function createProactiveRuntime(store: AppStore): ProactiveRuntime {
  let proactiveTimer: number | null = null;
  let lastProactiveAt = 0;
  let sendMessage: ((message: WsClientMessage) => void) | null = null;

  return {
    init(send): void {
      sendMessage = send;
      schedule();
    },
    onActivity(): void {
      cancel();
      schedule();
    },
    onPresenceChanged(): void {
      cancel();
      schedule();
    },
    dispose(): void {
      cancel();
    },
  };

  function schedule(): void {
    const state = store.getState();
    if (proactiveTimer != null || state.sleeping || state.audioPlaying || state.faceLastDetectedCount === 0) {
      return;
    }
    const jitter = Math.floor(Math.random() * PROACTIVE_JITTER_MS);
    proactiveTimer = window.setTimeout(() => {
      proactiveTimer = null;
      tryProactiveChat();
    }, PROACTIVE_DELAY_MS + jitter);
  }

  function cancel(): void {
    if (proactiveTimer != null) {
      clearTimeout(proactiveTimer);
      proactiveTimer = null;
    }
  }

  function tryProactiveChat(): void {
    const state = store.getState();
    if (state.sleeping || state.audioPlaying || state.faceLastDetectedCount === 0) {
      schedule();
      return;
    }
    if (Date.now() - lastProactiveAt < PROACTIVE_COOLDOWN_MS) {
      schedule();
      return;
    }

    lastProactiveAt = Date.now();
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
