import type { EmotionCue, ExpressionName } from './config.js';

export const TURN_ACTORS = ['main', 'small'] as const;
export const TURN_ACTIONS = ['speak', 'react', 'wait'] as const;

export type TurnActor = (typeof TURN_ACTORS)[number];
export type TurnAction = (typeof TURN_ACTIONS)[number];

export interface EmotionImpulse {
  pos: number;
  neg: number;
  arousal: number;
}

export interface TurnEmotion {
  emoji?: EmotionCue | null;
  expression?: ExpressionName | null;
  impulse?: EmotionImpulse | null;
}

export interface TurnBeat {
  actor: TurnActor;
  action: TurnAction;
  text?: string;
  expression?: ExpressionName | null;
  emotion?: TurnEmotion | null;
  delayMs?: number;
  waitForRemote?: boolean;
}

export interface TurnScript {
  turnId: string;
  beats: TurnBeat[];
  ts?: number;
}

export interface TurnContextMeta {
  imageAttached?: boolean;
  historyMessages?: number;
  historyChars?: number;
  mode?: 'text' | 'multimodal' | string;
}
