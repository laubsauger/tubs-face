import type { IncomingRequest, IncomingResponse } from '../../shared/contracts/http.js';
import type { AppStore } from '../state/app-state.js';
import { postJson } from '../transport/http.js';

/**
 * Sends the shared chat draft as a text turn. The dock's chat input and the
 * floating transcript's input edit the same draft, so either can send it.
 * On failure the draft comes back, unless the operator already typed a new one.
 */
export async function sendChatComposer(store: AppStore): Promise<boolean> {
  const text = store.getState().chatComposerText.trim();
  if (!text) {
    return false;
  }
  store.setState((current) => ({ ...current, chatComposerText: '' }));
  try {
    await postJson<IncomingRequest, IncomingResponse>('/incoming', { text });
    return true;
  } catch (error) {
    store.setState((current) => ({
      ...current,
      chatComposerText: current.chatComposerText ? current.chatComposerText : text,
    }));
    store.appendLog('error', error instanceof Error ? error.message : 'Failed to send text turn');
    return false;
  }
}
