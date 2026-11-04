// What the mic is doing, for the status bar and the listening dot.

import type { AppState } from '../../state/app-state.js';

export type ListenMode = 'idle' | 'always-on' | 'wake' | 'conversation' | 'transcribing' | 'recording';

type ListenSlice = Pick<AppState, 'recording' | 'listenState' | 'conversationActive' | 'voiceWakeWordEnabled' | 'voiceHandsFreeEnabled'>;

export function resolveListenMode(state: ListenSlice): ListenMode {
  if (state.recording) return 'recording';
  if (state.listenState === 'Uploading...' || state.listenState === 'Thinking...') return 'transcribing';
  if (state.conversationActive) return 'conversation';
  if (state.voiceHandsFreeEnabled && state.voiceWakeWordEnabled) return 'wake';
  if (state.voiceHandsFreeEnabled) return 'always-on';
  return 'idle';
}

export function listenLabel(state: ListenSlice, mode: ListenMode): string {
  if (mode === 'recording' || mode === 'transcribing') return state.listenState;
  if (mode === 'conversation') return 'Conversation';
  if (mode === 'wake') return 'Wake word armed';
  if (mode === 'always-on') return 'Always on';
  return 'Push to talk';
}
