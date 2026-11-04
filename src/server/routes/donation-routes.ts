// Donation confirmation from the operator and the PayPal checkout/webhook endpoints.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DonationConfirmRequest, DonationConfirmResponse, ErrorResponse, PayPalCaptureRequest, PayPalCaptureResponse, PayPalOrderRequest, PayPalOrderResponse } from '../../shared/contracts/http.js';
import { readJsonBody } from '../http/body.js';
import { sendJson } from '../http/response.js';
import { captureOrder, createOrder } from '../paypal/client.js';
import { emitDonationSignal, isDonationWebhookAuthorized, normalizeCurrencyCode, normalizeDonationSignalCertainty, toDonationSignalFromPayPalCapture, toDonationSignalFromPaypalEvent, toSafeAmount } from '../donations.js';

export async function handleDonationRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (request.method === 'POST' && url.pathname === '/checkout/paypal/order') {
    try {
      const payload = await readJsonBody<PayPalOrderRequest>(request);
      const createOrderArgs = {
        amount: payload.amount ?? process.env.PAYPAL_DEFAULT_DONATION_AMOUNT ?? '5.00',
        currency: payload.currency ?? 'USD',
        description: payload.description ?? 'Wheels for Tubs',
        ...(payload.referenceId ? { referenceId: payload.referenceId } : {}),
      };
      const order = await createOrder(createOrderArgs);
      const approveUrl = Array.isArray(order.links)
        ? order.links.find((link) => link.rel === 'approve')?.href
        : undefined;
      sendJson(response, 200, {
        ok: true,
        ...(order.id ? { id: order.id, orderId: order.id } : {}),
        ...(order.status ? { status: order.status } : {}),
        ...(approveUrl ? { approveUrl } : {}),
        order,
      } satisfies PayPalOrderResponse);
    } catch (error) {
      sendJson(response, getPayPalErrorStatus(error), {
        error: error instanceof Error ? error.message : 'PayPal order creation failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/checkout/paypal/capture') {
    try {
      const payload = await readJsonBody<PayPalCaptureRequest>(request);
      const capture = await captureOrder(payload.orderId);
      const donationSignal = toDonationSignalFromPayPalCapture(capture);
      if (donationSignal) {
        emitDonationSignal(donationSignal);
      }
      sendJson(response, 200, {
        ok: true,
        ...(capture.id ? { id: capture.id } : {}),
        ...(capture.status ? { status: capture.status } : {}),
        capture,
        donationSignal: donationSignal ?? null,
      } satisfies PayPalCaptureResponse);
    } catch (error) {
      sendJson(response, getPayPalErrorStatus(error), {
        error: error instanceof Error ? error.message : 'PayPal capture failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/donations/confirm') {
    if (!isDonationWebhookAuthorized(request)) {
      sendJson(response, 401, { error: 'Unauthorized donation confirmation' } satisfies ErrorResponse);
      return true;
    }

    try {
      const payload = await readJsonBody<DonationConfirmRequest>(request);
      const amount = toSafeAmount(payload.amount);
      const currency = normalizeCurrencyCode(payload.currency);
      const signal = {
        certainty: normalizeDonationSignalCertainty(payload.certainty),
        source: String(payload.source || 'manual-confirm'),
        ...(amount ? { amount } : {}),
        ...(currency ? { currency } : {}),
        ...(payload.note ? { note: String(payload.note).slice(0, 180) } : {}),
        ...(payload.donor ? { donor: String(payload.donor).slice(0, 64) } : {}),
        ...(payload.reference ? { reference: String(payload.reference).slice(0, 120) } : {}),
      };
      emitDonationSignal(signal);
      sendJson(response, 200, {
        ok: true,
        signal,
      } satisfies DonationConfirmResponse);
    } catch (error) {
      const statusCode = error instanceof Error && error.name === 'BadRequestError' ? 400 : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Donation confirmation failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/paypal') {
    if (!isDonationWebhookAuthorized(request)) {
      sendJson(response, 401, { error: 'Unauthorized webhook' } satisfies ErrorResponse);
      return true;
    }

    try {
      const event = await readJsonBody<Record<string, unknown>>(request);
      const eventType = String(event.event_type || '').trim();
      const signal = toDonationSignalFromPaypalEvent(eventType, event);
      if (signal) {
        emitDonationSignal(signal);
        sendJson(response, 200, {
          ok: true,
          processed: true,
          eventType,
          signal,
        });
        return true;
      }

      sendJson(response, 200, {
        ok: true,
        processed: false,
        eventType,
      });
    } catch (error) {
      const statusCode = error instanceof SyntaxError ? 400 : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Webhook processing failed',
      } satisfies ErrorResponse);
    }
    return true;
  }

  return false;
}

function getPayPalErrorStatus(error: unknown): number {
  const code = error && typeof error === 'object' ? String((error as { code?: string }).code || '') : '';
  if (code === 'BAD_PAYPAL_AMOUNT' || code === 'BAD_PAYPAL_CURRENCY' || code === 'BAD_PAYPAL_ORDER_ID') {
    return 400;
  }
  if (code === 'MISSING_PAYPAL_CREDENTIALS') {
    return 503;
  }
  return 500;
}
