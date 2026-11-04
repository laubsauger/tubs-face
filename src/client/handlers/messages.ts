import type { AppStore } from '../state/app-state.js';
import type { AppState } from '../state/app-state.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import type { TurnBeat } from '../../shared/contracts/turn-script.js';
import { appendChatDraft, appendChatEntry, clearChatDraft, commitChatDraft, reconcileIncomingChat, upsertChatDraft } from '../chat/state.js';
import { hasRecentOutgoingAssistantEntry } from '../chat/dedupe.js';

const NON_ACTIVITY_TYPES = new Set<WsServerMessage['type']>(['ping', 'stats', 'config']);

let activeTurnScriptId: string | null = null;

let activeTurnScriptBeats: TurnBeat[] = [];

let streamedBeatChatKeys = new Set<string>();

let streamedTurnActorChatEntryIds = new Map<string, string>();

/**
 * @param targetActor When set (spectator mode), filters actor-specific messages
 * (face_motion, face_blink, head_speech_state, audio_chunk) to only this actor.
 */
export function applyServerMessage(store: AppStore, message: WsServerMessage, mode: 'main' | 'mini', targetActor?: 'main' | 'small'): void {
  // Resolve which actor we care about: explicit targetActor > mode-derived default
  const myActor: 'main' | 'small' = targetActor ?? (mode === 'mini' ? 'small' : 'main');
  // The server broadcasts face_motion back to the client that sent it. Only
  // spectators (targetActor set) follow their actor's gaze; a face that drives
  // itself would overwrite its live gaze with a stale echo and show the echo as
  // the last message type, about 30 times a second.
  if (message.type === 'face_motion' && !targetActor && message.actor === myActor) {
    return;
  }
  // Same for main's own head_speech_state: the echo set 'speaking' a few ms
  // after the first audio chunk set the reply's emotion face, so one-sentence
  // replies never showed their feeling.
  if (message.type === 'head_speech_state' && mode === 'main' && !targetActor && message.actor === 'main') {
    return;
  }
  const dualHeadActive = Boolean(store.getState().config?.dualHeadEnabled && store.getState().config?.dualHeadMode !== 'off');
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
        ...(typeof message.latency === 'number' ? { lastResponseMs: message.latency } : {}),
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
        // A failed turn never plays audio, so nothing else clears "Thinking..."
        // (which also blocks hands-free listening).
        ...(current.listenState === 'Thinking...' ? { listenState: 'Idle' } : {}),
      }));
      store.appendLog('error', message.text);
      return;
    case 'ping':
      return;
    case 'field_notes':
      store.setState((current) => ({
        ...current,
        fieldNotes: { people: message.people, groupNotes: message.groupNotes, quotes: message.quotes },
      }));
      return;
    case 'conversation_mode':
      store.setState((current) => ({
        ...current,
        conversationActive: message.active,
        conversationUntil: message.active ? Date.now() + (message.expiresIn ?? 45_000) : 0,
      }));
      store.appendLog('info', message.active ? 'Conversation mode active' : 'Conversation mode cleared');
      return;
    case 'thinking':
      store.setState((current) => ({
        ...commitChatDraft(current, 'in'),
        currentExpression: 'thinking',
        liveTranscriptText: '',
        liveTranscriptDraft: false,
      }));
      store.appendLog('info', 'Assistant is thinking');
      return;
    case 'expression':
      store.setState((current) => ({
        ...current,
        currentExpression: message.expression,
      }));
      return;
    case 'sleep':
      store.setState((current) => ({
        ...current,
        sleeping: true,
        conversationActive: false,
        conversationUntil: 0,
        currentExpression: 'sleep',
        currentReactionEmoji: '',
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
      activeTurnScriptId = message.turnId;
      activeTurnScriptBeats = [];
      streamedBeatChatKeys = new Set();
      streamedTurnActorChatEntryIds = new Map();
      {
        // Stop the old turn after this state write, not inside it: the stop
        // writes audioPlaying:false, and an updater returning its stale
        // snapshot threw that away (mic stayed deaf, mouth kept flapping).
        const before = store.getState();
        const stopPrevious = Boolean(before.currentTurnId && before.currentTurnId !== message.turnId && (before.audioPlaying || before.currentSpeechText));
        store.setState((current) => ({
          ...clearChatDraft(clearChatDraft(current, 'out'), 'in'),
          currentTurnId: message.turnId,
          currentSpeechText: '',
          currentReactionEmoji: '',
        }));
        if (stopPrevious) {
          window.dispatchEvent(new CustomEvent('tubs:stop-speech', {
            detail: {
              turnId: before.currentTurnId,
              previousTurnId: before.currentTurnId,
              nextTurnId: message.turnId,
              source: 'turn_start',
            },
          }));
        }
      }
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
        currentReactionEmoji: '',
        audioPlaying: false,
        currentExpression: current.sleeping ? 'sleep' : 'listening',
      }));
      store.appendLog('info', `Interrupt received${message.source ? ` (${message.source})` : ''}`);
      return;
    case 'turn_context':
      store.appendLog('info', describeTurnContext(message.meta));
      return;
    case 'incoming':
      store.setState((current) => ({
        ...reconcileIncomingChat(current, message.text),
        currentExpression: 'listening',
        liveTranscriptText: message.text,
        liveTranscriptDraft: true,
      }));
      store.appendLog('info', `Incoming: ${message.text}`);
      return;
    case 'speak':
      if (mode === 'mini') {
        return;
      }
      clearLiveTranscript(store);
      store.setState((current) => ({
        ...appendChatEntry(current, {
          type: 'out',
          actor: 'main',
          text: `${message.emotion?.emoji ? `${message.emotion.emoji} ` : ''}${message.text}`,
          ts: Date.now(),
        }),
        currentSpeechText: message.text,
        currentExpression: message.emotion?.expression ?? 'speaking',
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
          current,
          'out',
          `${current.currentSpeechText} ${message.text}`.trim(),
          'main',
        ),
        currentSpeechText: `${current.currentSpeechText} ${message.text}`.trim(),
        currentExpression: 'speaking',
      }));
      return;
    case 'speak_end':
      if (message.actor && message.actor !== myActor) {
        return;
      }
      if (mode === 'mini') {
        return;
      }
      clearLiveTranscript(store);
      // Don't reset expression here — let speech runtime's finishSpeech handle it
      // when audio actually finishes playing (speak_end arrives before audio ends).
      store.setState((current) => {
        const finalizedText = (message.fullText ?? message.text ?? current.currentSpeechText ?? '').trim();
        const hasOutDraft = current.chatEntries.some((entry) => entry.type === 'out' && entry.draft);
        const alreadyAppended = hasRecentOutgoingAssistantEntry(current, finalizedText, 'main');
        // The server's fullText is the whole reply; commit that rather than
        // whatever sentences the draft happened to collect.
        const nextState = hasOutDraft
          ? (alreadyAppended
            ? clearChatDraft(current, 'out')
            : commitChatDraft(finalizedText ? upsertChatDraft(current, 'out', finalizedText, 'main') : current, 'out'))
          : ((!dualHeadActive && finalizedText && !alreadyAppended)
              ? appendChatEntry(current, {
                type: 'out',
                actor: 'main',
                text: finalizedText,
                ts: Date.now(),
              })
              : current);
        return {
          ...nextState,
        };
      });
      return;
    case 'turn_script':
      {
        clearLiveTranscript(store);
        activeTurnScriptId = message.turnId ?? store.getState().currentTurnId;
        activeTurnScriptBeats = Array.isArray(message.beats) ? message.beats : [];
        streamedBeatChatKeys = new Set();
        streamedTurnActorChatEntryIds = new Map();
        if (mode === 'mini') {
          return;
        }
        const targetActor = 'main';
        const hasRelevantBeat = message.beats.some((beat) => beat.actor === targetActor);
        const previewText = summarizeTurnScriptForPreview(message, targetActor);
        store.setState((current) => {
          let next: AppState = {
            ...current,
            currentTurnId: message.turnId ?? current.currentTurnId,
            ...(!dualHeadActive && hasRelevantBeat && previewText ? {
              currentSpeechText: previewText,
            } : {}),
          };
          if (dualHeadActive) {
            return next;
          }
          const mergedByActor = new Map<'main' | 'small', string>();
          for (const beat of message.beats) {
            if (beat.action !== 'speak' || !beat.text?.trim()) {
              continue;
            }
            const actor = beat.actor === 'small' ? 'small' : 'main';
            const text = `${beat.emotion?.emoji ? `${beat.emotion.emoji} ` : ''}${beat.text.trim()}`;
            const previous = mergedByActor.get(actor);
            mergedByActor.set(actor, previous ? `${previous}\n${text}` : text);
          }
          for (const [actor, text] of mergedByActor.entries()) {
            next = appendChatEntry(next, {
              type: 'out',
              actor,
              text,
              ts: Date.now(),
            });
          }
          return next;
        });
        store.appendLog('info', `${targetActor} turn script received: ${message.beats.length} beat(s)`);
        return;
      }
    case 'audio_chunk':
      if (dualHeadActive && mode === 'main' && message.actor && message.beatIndex != null) {
        maybeAppendTimedDualHeadChat(store, message.turnId ?? store.getState().currentTurnId ?? null, message.actor, message.beatIndex, message.text);
      }
      if (message.actor && message.actor !== myActor) {
        return;
      }
      if (mode === 'mini' && !message.actor) {
        return;
      }
      if (mode === 'main') {
        clearLiveTranscript(store);
      }
      store.setState((current) => {
        let next = current;
        const chunkText = message.text?.trim() ?? '';
        const alreadyAppended = chunkText
          ? hasRecentOutgoingAssistantEntry(current, chunkText, 'main')
            || hasRecentOutgoingAssistantEntry(current, current.currentSpeechText, 'main')
          : false;
        if (!dualHeadActive && mode === 'main' && chunkText && !alreadyAppended) {
          next = appendChatDraft(next, 'out', chunkText, 'main');
        }
        return {
          ...next,
          ...(message.text ? {
            currentSpeechText: message.text,
          } : {}),
          // The reply's emotion shows while it is spoken; plain chunks (a filler) just talk.
          ...((!message.actor || message.actor === myActor)
            ? { currentExpression: message.emotion?.expression ?? 'speaking' }
            : {}),
        };
      });
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

function describeTurnContext(meta: NonNullable<Extract<WsServerMessage, { type: 'turn_context' }>['meta']>): string {
  const mode = meta.mode ?? 'text';
  const historyMessages = meta.historyMessages ?? 0;
  const historyChars = meta.historyChars ?? 0;
  const imageAttached = meta.imageAttached ? 'with image' : 'text only';
  return `Turn context: ${mode}, ${historyMessages} messages, ${historyChars} chars, ${imageAttached}`;
}

function summarizeTurnScriptForPreview(
  message: Extract<WsServerMessage, { type: 'turn_script' }>,
  actor: 'main' | 'small',
): string {
  const speakBeats = message.beats
    .filter((beat) => beat.actor === actor && beat.action === 'speak' && beat.text)
    .map((beat) => beat.text?.trim() ?? '')
    .filter(Boolean);

  if (speakBeats.length !== 1) {
    return '';
  }

  return speakBeats[0] ?? '';
}

function maybeAppendTimedDualHeadChat(
  store: AppStore,
  turnId: string | null,
  actor: 'main' | 'small',
  beatIndex: number,
  fallbackText?: string,
): void {
  const key = `${turnId ?? activeTurnScriptId ?? 'turn'}:${actor}:${beatIndex}`;
  if (streamedBeatChatKeys.has(key)) {
    return;
  }

  const beat = turnId && activeTurnScriptId === turnId
    ? activeTurnScriptBeats[beatIndex]
    : activeTurnScriptBeats[beatIndex];
  const text = (beat?.text ?? fallbackText ?? '').trim();
  if (!text) {
    return;
  }

  streamedBeatChatKeys.add(key);
  const emoji = beat?.emotion?.emoji ? `${beat.emotion.emoji} ` : '';
  const nextText = `${emoji}${text}`;
  const turnActorKey = `${turnId ?? activeTurnScriptId ?? 'turn'}:${actor}`;

  store.setState((current) => {
    const existingEntryId = streamedTurnActorChatEntryIds.get(turnActorKey);
    if (existingEntryId) {
      const existingIndex = current.chatEntries.findIndex((entry) => entry.id === existingEntryId);
      if (existingIndex >= 0) {
        const existingEntry = current.chatEntries[existingIndex];
        if (existingEntry?.type === 'out' && existingEntry.actor === actor) {
          const existingLines = existingEntry.text.split('\n').map((line) => line.trim()).filter(Boolean);
          if (existingLines[existingLines.length - 1] === nextText) {
            return current;
          }
          const nextEntries = [...current.chatEntries];
          nextEntries[existingIndex] = {
            ...existingEntry,
            text: `${existingEntry.text}\n${nextText}`,
            ts: Date.now(),
          };
          return {
            ...current,
            chatEntries: nextEntries,
          };
        }
      }
    }

    const nextState = appendChatEntry(current, {
      type: 'out',
      actor,
      text: nextText,
      ts: Date.now(),
    });
    const appendedEntry = nextState.chatEntries[nextState.chatEntries.length - 1];
    if (appendedEntry) {
      streamedTurnActorChatEntryIds.set(turnActorKey, appendedEntry.id);
    }
    return nextState;
  });
}
