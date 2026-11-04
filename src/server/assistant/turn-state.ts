// Which assistant turn is current. A new turn or an interrupt supersedes the
// old one; work tied to it checks isAssistantTurnActive before touching the
// audience, and supersede handlers cancel its LLM stream and TTS socket.

import { randomBytes } from 'node:crypto';
import type { WsServerMessage } from '../../shared/contracts/ws.js';

export function createTurnId(): string {
  return randomBytes(6).toString('hex');
}

let activeTurnEpoch = 0;

let activeTurnId: string | null = null;

// Work a turn can cancel when it is superseded (LLM stream, TTS socket), keyed
// by the turn's epoch. Without this an interrupted turn kept generating audio
// nobody hears for up to 30 s.
const supersedeHandlers = new Map<number, () => void>();

export function onTurnSuperseded(epoch: number, handler: () => void): () => void {
  supersedeHandlers.set(epoch, handler);
  return () => {
    if (supersedeHandlers.get(epoch) === handler) {
      supersedeHandlers.delete(epoch);
    }
  };
}

function runSupersedeHandlers(): void {
  for (const [epoch, handler] of supersedeHandlers) {
    if (epoch !== activeTurnEpoch) {
      supersedeHandlers.delete(epoch);
      handler();
    }
  }
}

export function interruptAssistantTurns(): string | null {
  const previousTurnId = activeTurnId;
  activeTurnEpoch += 1;
  activeTurnId = null;
  runSupersedeHandlers();
  return previousTurnId;
}

/** True only while a turn is generating; cleared when it finishes or is interrupted. */
export function hasActiveAssistantTurn(): boolean {
  return Boolean(activeTurnId);
}

export function activateAssistantTurn(turnId: string): number {
  activeTurnEpoch += 1;
  activeTurnId = turnId;
  runSupersedeHandlers();
  return activeTurnEpoch;
}

export function finishAssistantTurn(turnId: string, epoch: number): void {
  if (isAssistantTurnActive(turnId, epoch)) {
    activeTurnId = null;
  }
}

export function isAssistantTurnActive(turnId: string, epoch: number): boolean {
  return activeTurnEpoch === epoch && activeTurnId === turnId;
}

export function emitIfActive(
  turnId: string,
  epoch: number,
  broadcast: (message: WsServerMessage) => void,
  message: WsServerMessage,
): boolean {
  if (!isAssistantTurnActive(turnId, epoch)) {
    return false;
  }
  broadcast(message);
  return true;
}
