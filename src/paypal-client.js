const PAYPAL_ENV = String(process.env.PAYPAL_ENV || 'sandbox').trim().toLowerCase();

function getPayPalBaseUrl() {
  return PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function getPayPalCredentials() {
  const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    const err = new Error('PayPal credentials missing (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)');
    err.code = 'MISSING_PAYPAL_CREDENTIALS';
    throw err;
  }
  return { clientId, clientSecret };
}

async function getAccessToken() {
  const { clientId, clientSecret } = getPayPalCredentials();
  const baseUrl = getPayPalBaseUrl();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const details = await safeReadJson(res);
    const err = new Error(`PayPal token request failed (${res.status})`);
    err.code = 'PAYPAL_TOKEN_FAILED';
    err.details = details;
    throw err;
  }

  const data = await res.json();
  return data.access_token;
}

function formatAmount(value) {
  const amount = Number.parseFloat(String(value));
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('Amount must be a positive number');
    err.code = 'BAD_PAYPAL_AMOUNT';
    throw err;
  }
  return amount.toFixed(2);
}

function normalizeCurrency(value) {
  const currency = String(value || 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    const err = new Error('Currency must be a 3-letter code');
    err.code = 'BAD_PAYPAL_CURRENCY';
    throw err;
  }
  return currency;
}

function buildCreateOrderBody({ amount, currency, description, referenceId }) {
  const total = formatAmount(amount);
  const code = normalizeCurrency(currency);
  const unit = {
    amount: {
      currency_code: code,
      value: total,
    },
  };
  if (description) unit.description = String(description).slice(0, 120);
  if (referenceId) unit.reference_id = String(referenceId).slice(0, 120);

  return {
    intent: 'CAPTURE',
    purchase_units: [unit],
  };
}

async function createOrder(options) {
  const token = await getAccessToken();
  const baseUrl = getPayPalBaseUrl();
  const body = buildCreateOrderBody(options);

  const res = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await safeReadJson(res);
  if (!res.ok) {
    const err = new Error(`PayPal order creation failed (${res.status})`);
    err.code = 'PAYPAL_CREATE_ORDER_FAILED';
    err.details = data;
    throw err;
  }

  return data;
}

async function captureOrder(orderId) {
  const trimmedOrderId = String(orderId || '').trim();
  if (!trimmedOrderId) {
    const err = new Error('orderId is required');
    err.code = 'BAD_PAYPAL_ORDER_ID';
    throw err;
  }

  const token = await getAccessToken();
  const baseUrl = getPayPalBaseUrl();

  const res = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(trimmedOrderId)}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await safeReadJson(res);
  if (!res.ok) {
    const err = new Error(`PayPal capture failed (${res.status})`);
    err.code = 'PAYPAL_CAPTURE_FAILED';
    err.details = data;
    throw err;
  }

  return data;
}

async function safeReadJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

module.exports = {
  createOrder,
  captureOrder,
  getPayPalBaseUrl,
};
