const PAYPAL_ENV = String(process.env.PAYPAL_ENV || 'sandbox').trim().toLowerCase();

interface PayPalOrderLink {
  rel?: string;
  href?: string;
}

export interface PayPalOrderRecord {
  id?: string;
  status?: string;
  links?: PayPalOrderLink[];
  purchase_units?: unknown[];
  payer?: unknown;
  [key: string]: unknown;
}

export interface CreatePayPalOrderArgs {
  amount: string;
  currency?: string;
  description?: string;
  referenceId?: string;
}

export function getPayPalBaseUrl(): string {
  return PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

export async function createOrder(options: CreatePayPalOrderArgs): Promise<PayPalOrderRecord> {
  const token = await getAccessToken();
  const response = await fetch(`${getPayPalBaseUrl()}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildCreateOrderBody(options)),
  });

  const data = await safeReadJson(response);
  if (!response.ok) {
    const error = new Error(`PayPal order creation failed (${response.status})`);
    error.name = 'PayPalCreateOrderError';
    Object.assign(error, { code: 'PAYPAL_CREATE_ORDER_FAILED', details: data });
    throw error;
  }
  return data;
}

export async function captureOrder(orderId: string): Promise<PayPalOrderRecord> {
  const trimmedOrderId = String(orderId || '').trim();
  if (!trimmedOrderId) {
    const error = new Error('orderId is required');
    error.name = 'BadPayPalOrderIdError';
    Object.assign(error, { code: 'BAD_PAYPAL_ORDER_ID' });
    throw error;
  }

  const token = await getAccessToken();
  const response = await fetch(`${getPayPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(trimmedOrderId)}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await safeReadJson(response);
  if (!response.ok) {
    const error = new Error(`PayPal capture failed (${response.status})`);
    error.name = 'PayPalCaptureError';
    Object.assign(error, { code: 'PAYPAL_CAPTURE_FAILED', details: data });
    throw error;
  }
  return data;
}

async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret } = getPayPalCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const details = await safeReadJson(response);
    const error = new Error(`PayPal token request failed (${response.status})`);
    error.name = 'PayPalTokenError';
    Object.assign(error, { code: 'PAYPAL_TOKEN_FAILED', details });
    throw error;
  }

  const data = await safeReadJson(response);
  const accessToken = String(data.access_token || '').trim();
  if (!accessToken) {
    throw new Error('PayPal token response missing access_token');
  }
  return accessToken;
}

function getPayPalCredentials(): { clientId: string; clientSecret: string } {
  const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    const error = new Error('PayPal credentials missing (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)');
    error.name = 'MissingPayPalCredentialsError';
    Object.assign(error, { code: 'MISSING_PAYPAL_CREDENTIALS' });
    throw error;
  }
  return { clientId, clientSecret };
}

function buildCreateOrderBody(options: CreatePayPalOrderArgs): Record<string, unknown> {
  const total = formatAmount(options.amount);
  const currency = normalizeCurrency(options.currency);
  const unit: Record<string, unknown> = {
    amount: {
      currency_code: currency,
      value: total,
    },
  };
  if (options.description) {
    unit.description = String(options.description).slice(0, 120);
  }
  if (options.referenceId) {
    unit.reference_id = String(options.referenceId).slice(0, 120);
  }

  return {
    intent: 'CAPTURE',
    purchase_units: [unit],
  };
}

function formatAmount(value: string): string {
  const amount = Number.parseFloat(String(value));
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('Amount must be a positive number');
    error.name = 'BadPayPalAmountError';
    Object.assign(error, { code: 'BAD_PAYPAL_AMOUNT' });
    throw error;
  }
  return amount.toFixed(2);
}

function normalizeCurrency(value: string | undefined): string {
  const currency = String(value || 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    const error = new Error('Currency must be a 3-letter code');
    error.name = 'BadPayPalCurrencyError';
    Object.assign(error, { code: 'BAD_PAYPAL_CURRENCY' });
    throw error;
  }
  return currency;
}

async function safeReadJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}
