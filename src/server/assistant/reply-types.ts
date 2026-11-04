// Shapes shared by the single-head, streamed and two-head reply paths.

import type { TurnBeat, TurnContextMeta, TurnDonation } from '../../shared/contracts/turn-script.js';
import type { SpeechEmotionPayload } from '../../shared/contracts/ws.js';

export interface AssistantReply {
  text: string;
  model: string;
  latencyMs: number;
  source: 'greeting' | 'llm';
  donation: TurnDonation | null;
  emotion: SpeechEmotionPayload | null;
  contextMeta: TurnContextMeta;
  tokens: {
    in: number;
    out: number;
  };
  costUsd: number;
}

export interface AssistantTurnResult {
  turnId: string;
  reply: AssistantReply;
  /** Dual-head turns: the beats that were played, for per-head logging. */
  beats?: TurnBeat[];
  superseded?: boolean;
}

export interface DualHeadReply {
  beats: TurnBeat[];
  donation: TurnDonation | null;
  model: string;
  latencyMs: number;
  tokens: {
    in: number;
    out: number;
  };
  costUsd: number;
  source: 'greeting' | 'llm';
  fullText: string;
  emotion: SpeechEmotionPayload | null;
  contextMeta: TurnContextMeta;
}

export function isDualHeadReply(reply: AssistantReply | DualHeadReply): reply is DualHeadReply {
  return 'beats' in reply && Array.isArray(reply.beats);
}

export function assistantUnavailable(message: string): Error {
  const error = new Error(message);
  error.name = 'AssistantUnavailableError';
  return error;
}
