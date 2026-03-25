import type { AppStore } from '../state/app-state.js';
import type { AppState } from '../state/app-state.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import { appendChatEntry, clearChatDraft, commitChatDraft, pushStreamDebugEntry, reconcileIncomingChat, resetStreamDebugState, upsertChatDraft } from '../chat/state.js';
import { detectDonationSignal, inferDonationPrompt } from '../message-handler-utils.js';

const DONATION_JOY_DURATION_MS = 1_800;
const DONATION_PROMPT_HIDE_MS = 12_000;
const JOY_LOCKED_EXPRESSIONS = new Set(['idle', 'listening', 'thinking']);
const NON_ACTIVITY_TYPES = new Set<WsServerMessage['type']>(['ping', 'stats', 'config', 'stream_debug']);
let donationJoyUntil = 0;
let donationJoyResetTimer: number | null = null;
let donationPromptTimer: number | null = null;

/**
 * @param targetActor When set (spectator mode), filters actor-specific messages
 * (face_motion, face_blink, head_speech_state, audio_chunk) to only this actor.
 */
export function applyServerMessage(store: AppStore, message: WsServerMessage, mode: 'main' | 'mini', targetActor?: 'main' | 'small'): void {
  // Resolve which actor we care about: explicit targetActor > mode-derived default
  const myActor: 'main' | 'small' = targetActor ?? (mode === 'mini' ? 'small' : 'main');
  store.setState((current) => ({
    ...current,
    lastMessageType: message.type,
    ...(NON_ACTIVITY_TYPES.has(message.type) ? {} : {
      stats: current.stats ? {
        ...current.stats,
        lastActivity: Date.now(),
      } : current.stats,
    }),
  }));

  switch (message.type) {
    case 'config':
      store.setState((current) => ({
        ...current,
        config: message,
        ambientAudioEnabled: message.ambientAudioEnabled,
        fxBaseColorDraft: message.glitchFxBaseColor,
      }));
      return;
    case 'stats':
      store.setState((current) => ({
        ...current,
        stats: {
          messagesIn: current.stats?.messagesIn ?? 0,
          messagesOut: current.stats?.messagesOut ?? 0,
          tokensIn: message.totals?.in ?? current.stats?.tokensIn ?? 0,
          tokensOut: message.totals?.out ?? current.stats?.tokensOut ?? 0,
          costUsd: message.totals?.cost ?? current.stats?.costUsd ?? 0,
          uptime: current.stats?.uptime ?? Date.now(),
          lastActivity: Date.now(),
          model: message.model ?? current.stats?.model ?? current.config?.model ?? 'Tubs Bot v1',
        },
      }));
      return;
    case 'system':
      store.setState((current) => appendChatEntry(current, {
        type: 'sys',
        actor: 'system',
        text: message.text,
        ts: Date.now(),
      }));
      store.appendLog('info', message.text);
      return;
    case 'error':
      store.setState((current) => ({
        ...appendChatEntry(current, {
          type: 'sys',
          actor: 'system',
          text: `ERROR: ${message.text}`,
          ts: Date.now(),
        }),
        currentExpression: 'idle',
      }));
      store.appendLog('error', message.text);
      return;
    case 'ping':
      store.setState((current) => ({
        ...current,
        lastPingMs: Math.max(0, message.serverTs - message.ts),
      }));
      return;
    case 'conversation_mode':
      store.setState((current) => ({
        ...current,
        conversationActive: message.active,
      }));
      store.appendLog('info', message.active ? 'Conversation mode active' : 'Conversation mode cleared');
      return;
    case 'thinking':
      store.setState((current) => ({
        ...commitChatDraft(current, 'in'),
        currentExpression: nextExpression(current.currentExpression, 'thinking'),
        liveTranscriptText: '',
        liveTranscriptDraft: false,
      }));
      store.appendLog('info', 'Assistant is thinking');
      return;
    case 'expression':
      store.setState((current) => ({
        ...current,
        currentExpression: nextExpression(current.currentExpression, message.expression),
      }));
      return;
    case 'sleep':
      clearDonationPromptTimer();
      store.setState((current) => ({
        ...current,
        sleeping: true,
        currentExpression: 'sleep',
        currentReactionEmoji: '',
        currentDonationSignal: null,
        subtitleText: '',
        liveTranscriptText: '',
        liveTranscriptDraft: false,
      }));
      store.appendLog('info', 'Sleep mode enabled');
      return;
    case 'wake':
      store.setState((current) => ({
        ...current,
        sleeping: false,
        awakeSinceTs: Date.now(),
        awakeElapsedSec: 0,
        currentExpression: 'idle',
        currentReactionEmoji: '',
      }));
      store.appendLog('info', 'Sleep mode cleared');
      return;
    case 'turn_start':
      clearLiveTranscript(store);
      store.setState((current) => {
        if (current.currentTurnId && current.currentTurnId !== message.turnId && (current.audioPlaying || current.currentSpeechText)) {
          window.dispatchEvent(new CustomEvent('tubs:stop-speech', {
            detail: {
              turnId: current.currentTurnId,
              previousTurnId: current.currentTurnId,
              nextTurnId: message.turnId,
              source: 'turn_start',
            },
          }));
        }
        return {
          ...resetStreamDebugState(clearChatDraft(clearChatDraft(current, 'out'), 'in'), message.turnId),
        currentTurnId: message.turnId,
        currentSpeechText: '',
        subtitleText: '',
        currentReactionEmoji: '',
        };
      });
      store.appendLog('info', `Turn started: ${message.turnId}`);
      return;
    case 'interrupt':
      window.dispatchEvent(new CustomEvent('tubs:stop-speech', {
        detail: {
          turnId: message.turnId ?? store.getState().currentTurnId,
          source: message.source ?? 'system',
        },
      }));
      store.setState((current) => ({
        ...clearChatDraft(current, 'out'),
        currentSpeechText: '',
        subtitleText: '',
        currentReactionEmoji: '',
        audioPlaying: false,
        currentExpression: current.sleeping ? 'sleep' : nextExpression(current.currentExpression, 'listening'),
      }));
      store.appendLog('info', `Interrupt received${message.source ? ` (${message.source})` : ''}`);
      return;
    case 'turn_context':
      store.setState((current) => pushStreamDebugEntry(current, 'turn_context', {
        turnId: message.turnId,
        ...message.meta,
        ts: Date.now(),
      }));
      store.appendLog('info', describeTurnContext(message.meta));
      return;
    case 'incoming':
      store.setState((current) => {
        const donationSignal = detectDonationSignal(message.text);
        if (donationSignal) {
          triggerDonationJoy(store);
        }
        return {
          ...reconcileIncomingChat(current, message.text),
          currentIncomingText: message.text,
          currentExpression: donationSignal ? 'love' : nextExpression(current.currentExpression, 'listening'),
          liveTranscriptText: message.text,
          liveTranscriptDraft: true,
          ...(donationSignal ? {
            currentDonationSignal: {
              certainty: donationSignal === 'confirmed' ? 'confident' : 'implied',
              source: `text-${donationSignal}`,
              ts: Date.now(),
            },
          } : {}),
        };
      });
      store.appendLog('info', `Incoming: ${message.text}`);
      return;
    case 'speak':
      if (mode === 'mini') {
        return;
      }
      clearLiveTranscript(store);
      applyDonationPrompt(store, message.donation ?? null, message.text);
      store.setState((current) => ({
        ...appendChatEntry(current, {
          type: 'out',
          actor: 'main',
          text: `${message.emotion?.emoji ? `${message.emotion.emoji} ` : ''}${message.text}`,
          ts: Date.now(),
        }),
        currentSpeechText: message.text,
        subtitleText: message.text,
        currentExpression: nextExpression(current.currentExpression, message.emotion?.expression ?? 'speaking'),
      }));
      store.appendLog('info', `Speak: ${message.text}`);
      return;
    case 'speak_chunk':
      if (mode === 'mini') {
        return;
      }
      clearLiveTranscript(store);
      store.setState((current) => ({
        ...upsertChatDraft(
          pushStreamDebugEntry(current, 'llm_delta', {
          turnId: message.turnId ?? current.currentTurnId,
          deltaChars: message.text.length,
          ts: Date.now(),
          }),
          'out',
          `${current.currentSpeechText} ${message.text}`.trim(),
          'main',
        ),
        currentSpeechText: `${current.currentSpeechText} ${message.text}`.trim(),
        subtitleText: `${current.subtitleText} ${message.text}`.trim(),
        currentExpression: nextExpression(current.currentExpression, 'speaking'),
      }));
      return;
    case 'speak_end':
      if (mode === 'mini') {
        return;
      }
      clearLiveTranscript(store);
      applyDonationPrompt(store, message.donation ?? null, message.fullText ?? message.text ?? '');
      // Don't reset expression here — let speech runtime's finishSpeech handle it
      // when audio actually finishes playing (speak_end arrives before audio ends).
      store.setState((current) => ({
        ...commitChatDraft(current, 'out'),
        subtitleText: current.currentSpeechText,
      }));
      return;
    case 'backchannel':
      if (mode === 'mini') {
        return;
      }
      store.setState((current) => ({
        ...appendChatEntry(current, {
          type: 'out',
          actor: 'main',
          text: message.text,
          ts: Date.now(),
        }),
        currentSpeechText: message.text,
        subtitleText: message.text,
        currentExpression: nextExpression(current.currentExpression, 'smile'),
      }));
      store.appendLog('info', `Backchannel: ${message.text}`);
      return;
    case 'turn_script':
      {
        clearLiveTranscript(store);
        const targetActor = mode === 'mini' ? 'small' : 'main';
        const hasRelevantBeat = message.beats.some((beat) => beat.actor === targetActor);
        if (!hasRelevantBeat) {
          return;
        }
        applyDonationPrompt(
          store,
          message.donation ?? null,
          message.beats
            .filter((beat) => beat.action === 'speak')
            .map((beat) => beat.text?.trim() ?? '')
            .filter(Boolean)
            .join(' '),
        );
        store.setState((current) => {
          let next: AppState = {
            ...current,
            currentTurnId: message.turnId ?? current.currentTurnId,
          };
          for (const beat of message.beats) {
            if (beat.action !== 'speak' || !beat.text?.trim()) {
              continue;
            }
            next = appendChatEntry(next, {
              type: 'out',
              actor: beat.actor,
              text: `${beat.emotion?.emoji ? `${beat.emotion.emoji} ` : ''}${beat.text.trim()}`,
              ts: Date.now(),
            });
          }
          return next;
        });
        store.appendLog('info', `${targetActor} turn script received: ${message.beats.length} beat(s)`);
        return;
      }
    case 'audio_chunk':
      // When targeting a specific actor (spectator), skip chunks for other actors
      if (targetActor && message.actor && message.actor !== targetActor) {
        return;
      }
      if (mode === 'main') {
        clearLiveTranscript(store);
      }
      store.setState((current) => ({
        ...pushStreamDebugEntry(current, 'audio_chunk_ws_in', {
          turnId: message.turnId ?? current.currentTurnId,
          chunkIndex: message.chunkIndex,
          audioBytes: Math.round(((message.audio || '').length * 3) / 4),
          ts: Date.now(),
        }),
        currentExpression: nextExpression(current.currentExpression, 'speaking'),
        ...(message.text ? {
          currentSpeechText: message.text,
          subtitleText: message.text,
        } : {}),
      }));
      return;
    case 'donation_signal':
      triggerDonationJoy(store);
      applyDonationPrompt(store, compactDonationSignal(message), '');
      store.setState((current) => ({
        ...current,
        currentExpression: 'love',
      }));
      store.appendLog('info', `Donation signal: ${message.certainty}`);
      return;
    case 'stream_debug':
      store.setState((current) => pushStreamDebugEntry(current, message.stage ?? 'stream_debug', {
        ...message,
        ts: message.ts ?? Date.now(),
      }));
      store.appendLog('info', `${message.stage ?? 'stream'}: ${message.detail ?? 'update'}`);
      return;
    case 'face_motion':
      if (mode === 'mini' && !targetActor && message.actor === 'main') {
        window.dispatchEvent(new CustomEvent('tubs:partner-face-motion', {
          detail: {
            x: message.x,
            y: message.y,
            ts: message.ts,
          },
        }));
        return;
      }
      if (message.actor !== myActor) {
        return;
      }
      store.setState((current) => ({
        ...current,
        gazeX: message.x,
        gazeY: message.y,
      }));
      return;
    case 'face_blink':
      if (mode === 'mini' && !targetActor && message.actor === 'main') {
        window.dispatchEvent(new CustomEvent('tubs:partner-face-blink', {
          detail: {
            ts: message.ts,
          },
        }));
        return;
      }
      if (message.actor !== myActor) {
        return;
      }
      store.setState((current) => ({
        ...current,
        blinkActive: true,
        lastBlinkAt: message.ts,
      }));
      window.setTimeout(() => {
        store.setState((current) => ({
          ...current,
          blinkActive: false,
        }));
      }, 140);
      return;
    case 'head_speech_state':
      if (message.actor !== myActor) {
        return;
      }
      store.setState((current) => ({
        ...current,
        audioPlaying: message.state === 'start',
        // Drive face expression in sync with speech state
        ...(message.state === 'start'
          ? { currentExpression: 'speaking' as const }
          : (current.currentExpression === 'speaking' ? { currentExpression: 'idle' as const } : {})),
        ...(message.turnId !== undefined ? { currentTurnId: message.turnId ?? current.currentTurnId } : {}),
      }));
      return;
    default:
      return;
  }
}

function clearLiveTranscript(store: AppStore): void {
  store.setState((current) => ({
    ...current,
    liveTranscriptText: '',
    liveTranscriptDraft: false,
  }));
}

function applyDonationPrompt(
  store: AppStore,
  explicitSignal: AppState['currentDonationSignal'] | { show?: boolean } | null,
  text: string,
): void {
  const nextSignal: AppState['currentDonationSignal'] = explicitSignal && 'show' in explicitSignal
    ? (explicitSignal.show ? {
      certainty: 'implied',
      source: 'assistant-explicit',
      ts: Date.now(),
    } : null)
    : (explicitSignal && 'certainty' in explicitSignal ? explicitSignal : null);
  const inferredSignal = !nextSignal && inferDonationPrompt(text)
    ? {
      certainty: 'implied' as const,
      source: 'assistant-text',
      ts: Date.now(),
    }
    : null;
  const signal = nextSignal ?? inferredSignal;
  if (!signal) {
    return;
  }
  clearDonationPromptTimer();
  store.setState((current) => ({
    ...current,
    currentDonationSignal: signal,
  }));
  donationPromptTimer = window.setTimeout(() => {
    donationPromptTimer = null;
    store.setState((current) => ({
      ...current,
      currentDonationSignal: null,
    }));
  }, DONATION_PROMPT_HIDE_MS);
}

function clearDonationPromptTimer(): void {
  if (donationPromptTimer == null) {
    return;
  }
  window.clearTimeout(donationPromptTimer);
  donationPromptTimer = null;
}

function isDonationJoyActive(now = Date.now()): boolean {
  return now < donationJoyUntil;
}

function nextExpression(currentExpression: AppState['currentExpression'], proposedExpression: AppState['currentExpression']): AppState['currentExpression'] {
  if (isDonationJoyActive() && JOY_LOCKED_EXPRESSIONS.has(proposedExpression)) {
    return currentExpression;
  }
  return proposedExpression;
}

function triggerDonationJoy(store: AppStore): void {
  donationJoyUntil = Date.now() + DONATION_JOY_DURATION_MS;
  store.setState((current) => ({
    ...current,
    currentExpression: 'love',
  }));
  if (donationJoyResetTimer != null) {
    window.clearTimeout(donationJoyResetTimer);
  }
  donationJoyResetTimer = window.setTimeout(() => {
    donationJoyResetTimer = null;
    if (Date.now() < donationJoyUntil) {
      return;
    }
    const state = store.getState();
    if (!state.sleeping && !state.audioPlaying && state.currentExpression === 'love') {
      store.setState((current) => ({
        ...current,
        currentExpression: 'idle',
      }));
    }
  }, DONATION_JOY_DURATION_MS + 120);
}

function describeTurnContext(meta: NonNullable<Extract<WsServerMessage, { type: 'turn_context' }>['meta']>): string {
  const mode = meta.mode ?? 'text';
  const historyMessages = meta.historyMessages ?? 0;
  const historyChars = meta.historyChars ?? 0;
  const imageAttached = meta.imageAttached ? 'with image' : 'text only';
  return `Turn context: ${mode}, ${historyMessages} messages, ${historyChars} chars, ${imageAttached}`;
}

function summarizeTurnScript(
  message: Extract<WsServerMessage, { type: 'turn_script' }>,
  actor: 'main' | 'small',
): string {
  return message.beats
    .filter((beat) => beat.actor === actor && beat.action === 'speak' && beat.text)
    .map((beat) => beat.text?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

function compactDonationSignal(message: Extract<WsServerMessage, { type: 'donation_signal' }>) {
  return {
    certainty: message.certainty,
    ...(message.source ? { source: message.source } : {}),
    ...(message.amount ? { amount: message.amount } : {}),
    ...(message.currency ? { currency: message.currency } : {}),
    ...(message.donor ? { donor: message.donor } : {}),
    ...(message.note ? { note: message.note } : {}),
    ...(message.reference ? { reference: message.reference } : {}),
    ...(message.ts ? { ts: message.ts } : {}),
  };
}
