// A donation makes Tubs light up for a moment (the love face, which other
// expressions do not override) and shows the donation prompt.

import type { AppStore } from '../state/app-state.js';
import type { AppState } from '../state/app-state.js';
import type { WsServerMessage } from '../../shared/contracts/ws.js';
import { inferDonationPrompt } from '../message-handler-utils.js';

const DONATION_JOY_DURATION_MS = 1_800;

const DONATION_PROMPT_HIDE_MS = 12_000;

const JOY_LOCKED_EXPRESSIONS = new Set(['idle', 'listening', 'thinking']);

let donationJoyUntil = 0;

let donationJoyResetTimer: number | null = null;

let donationPromptTimer: number | null = null;

export function applyDonationPrompt(
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

export function clearDonationPromptTimer(): void {
  if (donationPromptTimer == null) {
    return;
  }
  window.clearTimeout(donationPromptTimer);
  donationPromptTimer = null;
}

function isDonationJoyActive(now = Date.now()): boolean {
  return now < donationJoyUntil;
}

export function nextExpression(currentExpression: AppState['currentExpression'], proposedExpression: AppState['currentExpression']): AppState['currentExpression'] {
  if (isDonationJoyActive() && JOY_LOCKED_EXPRESSIONS.has(proposedExpression)) {
    return currentExpression;
  }
  return proposedExpression;
}

export function triggerDonationJoy(store: AppStore): void {
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

export function compactDonationSignal(message: Extract<WsServerMessage, { type: 'donation_signal' }>) {
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
