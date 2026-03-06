import type { IncomingMessage } from 'node:http';
import type { DonationSignalPayload, WsDonationSignalServerMessage } from '../shared/contracts/ws.js';
import { broadcast } from './ws/server.js';

export function isDonationWebhookAuthorized(request: IncomingMessage): boolean {
  const expectedToken = String(process.env.DONATION_WEBHOOK_TOKEN || '').trim();
  if (!expectedToken) {
    return true;
  }

  const headerToken = String(request.headers['x-donation-token'] || '').trim();
  const bearerToken = extractBearerToken(request);
  return headerToken === expectedToken || bearerToken === expectedToken;
}

export function emitDonationSignal(signal: DonationSignalPayload): void {
  broadcast({
    type: 'donation_signal',
    ...signal,
    ...(signal.ts ? {} : { ts: Date.now() }),
  } satisfies WsDonationSignalServerMessage);
}

export function toDonationSignalFromPayPalCapture(orderCapture: Record<string, unknown>): DonationSignalPayload | null {
  const purchaseUnit = Array.isArray(orderCapture.purchase_units)
    ? orderCapture.purchase_units[0] as Record<string, unknown> | undefined
    : undefined;
  const payments = purchaseUnit?.payments as Record<string, unknown> | undefined;
  const captures = Array.isArray(payments?.captures) ? payments.captures as Record<string, unknown>[] : [];
  const capture = captures.find((item) => item.status === 'COMPLETED') ?? captures[0];
  if (!capture) {
    return null;
  }

  const donor = extractPaypalDonor(orderCapture);
  const reference = String(capture.id || orderCapture.id || '').trim() || undefined;
  return {
    certainty: 'confident',
    source: 'paypal-capture-api',
    ...extractPaypalAmount(capture),
    ...(donor ? { donor } : {}),
    ...(reference ? { reference } : {}),
  };
}

export function toDonationSignalFromPaypalEvent(eventType: string, event: Record<string, unknown>): DonationSignalPayload | null {
  const resource = event.resource as Record<string, unknown> | undefined;
  const donor = extractPaypalDonor(resource);
  const reference = String(resource?.id || event.id || '').trim() || undefined;
  const base = {
    ...extractPaypalAmount(resource),
    ...(donor ? { donor } : {}),
    ...(reference ? { reference } : {}),
  };

  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    return {
      certainty: 'confident',
      source: 'paypal-webhook-capture',
      ...base,
    };
  }

  if (eventType === 'CHECKOUT.ORDER.APPROVED') {
    return {
      certainty: 'implied',
      source: 'paypal-webhook-approved',
      ...base,
    };
  }

  return null;
}

export function normalizeDonationSignalCertainty(value: unknown): 'implied' | 'confident' {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'implied' ? 'implied' : 'confident';
}

export function normalizeCurrencyCode(value: unknown): string | undefined {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (!/^[A-Z]{3}$/.test(normalized)) {
    const error = new Error('currency must be a 3-letter code');
    error.name = 'BadRequestError';
    throw error;
  }
  return normalized;
}

export function toSafeAmount(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return undefined;
  }
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('amount must be a positive number');
    error.name = 'BadRequestError';
    throw error;
  }
  return amount.toFixed(2);
}

function extractBearerToken(request: IncomingMessage): string | null {
  const auth = String(request.headers.authorization || '').trim();
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  return auth.slice(7).trim() || null;
}

function extractPaypalAmount(resource: Record<string, unknown> | undefined): { amount?: string; currency?: string } {
  if (!resource) {
    return {};
  }

  const directAmount = (resource.amount || resource.gross_amount) as Record<string, unknown> | undefined;
  if (directAmount) {
    const amount = toSafeAmount(directAmount.value);
    const currency = normalizeCurrencyCode(directAmount.currency_code);
    return {
      ...(amount ? { amount } : {}),
      ...(currency ? { currency } : {}),
    };
  }

  const breakdown = resource.seller_receivable_breakdown as Record<string, unknown> | undefined;
  const gross = breakdown?.gross_amount as Record<string, unknown> | undefined;
  if (gross) {
    const amount = toSafeAmount(gross.value);
    const currency = normalizeCurrencyCode(gross.currency_code);
    return {
      ...(amount ? { amount } : {}),
      ...(currency ? { currency } : {}),
    };
  }

  return {};
}

function extractPaypalDonor(resource: Record<string, unknown> | undefined): string | undefined {
  const payer = resource?.payer as Record<string, unknown> | undefined;
  if (!payer) {
    return undefined;
  }

  const payerName = payer.name as Record<string, unknown> | undefined;
  const given = String(payerName?.given_name || '').trim();
  const surname = String(payerName?.surname || '').trim();
  const fullName = [given, surname].filter(Boolean).join(' ').trim();
  if (fullName) {
    return fullName.slice(0, 64);
  }

  const email = String(payer.email_address || '').trim();
  return email ? email.slice(0, 64) : undefined;
}
