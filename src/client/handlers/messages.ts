import type { AppStore } from '../state/app-state.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import { appendChatEntry, clearChatDraft, commitChatDraft, pushStreamDebugEntry, resetStreamDebugState, upsertChatDraft } from '../chat/state.js';

export function applyServerMessage(store: AppStore, message: WsServerMessage): void {
  store.setState((current) => ({
    ...current,
    lastMessageType: message.type,
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
        text: message.text,
        ts: Date.now(),
      }));
      store.appendLog('info', message.text);
      return;
    case 'error':
      store.setState((current) => ({
        ...appendChatEntry(current, {
          type: 'sys',
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
        currentExpression: 'thinking',
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
        currentExpression: 'sleep',
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
      }));
      store.appendLog('info', 'Sleep mode cleared');
      return;
    case 'turn_start':
      store.setState((current) => ({
        ...resetStreamDebugState(clearChatDraft(current, 'in'), message.turnId),
        currentTurnId: message.turnId,
        currentSpeechText: '',
      }));
      store.appendLog('info', `Turn started: ${message.turnId}`);
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
      store.setState((current) => ({
        ...upsertChatDraft(current, 'in', message.text),
        currentIncomingText: message.text,
        currentExpression: 'listening',
        liveTranscriptText: message.text,
        liveTranscriptDraft: true,
      }));
      store.appendLog('info', `Incoming: ${message.text}`);
      return;
    case 'speak':
      store.setState((current) => ({
        ...appendChatEntry(current, {
          type: 'out',
          actor: 'main',
          text: message.text,
          ts: Date.now(),
        }),
        currentSpeechText: message.text,
        subtitleText: message.text,
        currentExpression: 'speaking',
      }));
      store.appendLog('info', `Speak: ${message.text}`);
      return;
    case 'speak_chunk':
      store.setState((current) => ({
        ...pushStreamDebugEntry(current, 'llm_delta', {
          turnId: message.turnId ?? current.currentTurnId,
          deltaChars: message.text.length,
          ts: Date.now(),
        }),
        currentSpeechText: `${current.currentSpeechText} ${message.text}`.trim(),
        subtitleText: `${current.subtitleText} ${message.text}`.trim(),
        currentExpression: 'speaking',
      }));
      return;
    case 'speak_end':
      store.setState((current) => ({
        ...current,
        currentExpression: current.sleeping ? 'sleep' : 'idle',
        subtitleText: current.currentSpeechText,
      }));
      return;
    case 'backchannel':
      store.setState((current) => ({
        ...appendChatEntry(current, {
          type: 'out',
          actor: 'main',
          text: message.text,
          ts: Date.now(),
        }),
        currentSpeechText: message.text,
        subtitleText: message.text,
        currentExpression: 'smile',
      }));
      store.appendLog('info', `Backchannel: ${message.text}`);
      return;
    case 'turn_script':
      store.setState((current) => ({
        ...appendChatEntry(current, {
          type: 'sys',
          text: `TURN ${message.turnId || 'n/a'} ${summarizeTurnScript(message)}`,
          ts: Date.now(),
        }),
        currentTurnId: message.turnId,
        currentSpeechText: summarizeTurnScript(message),
        subtitleText: summarizeTurnScript(message),
      }));
      store.appendLog('info', `Turn script received: ${message.beats.length} beat(s)`);
      return;
    case 'audio_chunk':
      store.setState((current) => ({
        ...pushStreamDebugEntry(current, 'audio_chunk_ws_in', {
          turnId: message.turnId ?? current.currentTurnId,
          chunkIndex: message.chunkIndex,
          audioBytes: Math.round(((message.audio || '').length * 3) / 4),
          ts: Date.now(),
        }),
        currentExpression: 'speaking',
      }));
      return;
    case 'donation_signal':
      store.setState((current) => ({
        ...current,
        currentDonationSignal: compactDonationSignal(message),
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
    default:
      return;
  }
}

function describeTurnContext(meta: NonNullable<Extract<WsServerMessage, { type: 'turn_context' }>['meta']>): string {
  const mode = meta.mode ?? 'text';
  const historyMessages = meta.historyMessages ?? 0;
  const historyChars = meta.historyChars ?? 0;
  const imageAttached = meta.imageAttached ? 'with image' : 'text only';
  return `Turn context: ${mode}, ${historyMessages} messages, ${historyChars} chars, ${imageAttached}`;
}

function summarizeTurnScript(message: Extract<WsServerMessage, { type: 'turn_script' }>): string {
  return message.beats
    .filter((beat) => beat.actor === 'main' && beat.action === 'speak' && beat.text)
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
