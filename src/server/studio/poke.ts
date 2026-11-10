// A physical cue in the studio (the Bluetooth lever by the Book): it wakes both heads and has them
// react, even with nobody in view. The reaction is an ordinary proactive turn, so it waits for a line
// still playing and never cuts off a reply someone is waiting for; sleep comes back on its own timer.

import type { WsServerMessage } from '../../shared/contracts/ws.js';

export const DEFAULT_POKE = 'Someone just pulled the big lever by the Book.';
const MAX_REASON = 300;

export interface PokeDeps {
  broadcast(message: WsServerMessage): void;
  noteAwake(): void;
  startProactiveTurn(context: string, broadcast: (message: WsServerMessage) => void): void;
}

/** What the turn is told: the event, that it woke them, and to react briefly, in character. */
export function pokeContext(reason: string): string {
  return `[Something happened in the studio; no visitor said this] ${reason} It woke you both up. React to it in a few words, your way.`;
}

export function reasonOf(body: unknown): string {
  const r = body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined;
  return typeof r === 'string' && r.trim() ? r.trim().slice(0, MAX_REASON) : DEFAULT_POKE;
}

export function poke(reason: string, deps: PokeDeps): void {
  deps.noteAwake();
  deps.broadcast({ type: 'wake' });
  deps.startProactiveTurn(pokeContext(reason), deps.broadcast);
}
