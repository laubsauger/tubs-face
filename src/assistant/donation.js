const {
  DONATION_MARKER,
  DONATION_MARKER_RE,
  DONATION_KEYWORDS,
  DONATION_NUDGE_INTERVAL,
  DEFAULT_VENMO_HANDLE,
  DEFAULT_DONATION_QR_DATA,
} = require('./constants');

function buildDonationPayload(show, reason = 'none') {
  return {
    show: Boolean(show),
    reason,
    venmoHandle: DEFAULT_VENMO_HANDLE,
    qrData: DEFAULT_DONATION_QR_DATA,
    qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(DEFAULT_DONATION_QR_DATA)}`,
  };
}

function stripDonationMarkers(text) {
  return String(text || '').replace(/\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/gi, ' ');
}

function extractDonationSignal(text) {
  let cleaned = String(text || '');
  let show = false;
  let reason = 'none';

  if (cleaned.includes(DONATION_MARKER) || DONATION_MARKER_RE.test(cleaned)) {
    show = true;
    reason = 'marker';
    cleaned = stripDonationMarkers(cleaned);
  }

  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!show && DONATION_KEYWORDS.test(cleaned)) {
    show = true;
    reason = 'keyword';
  }

  return {
    text: cleaned,
    donation: buildDonationPayload(show, reason),
  };
}

function maybeInjectDonationNudge(text, alreadyShowingQr, replyCount) {
  if (alreadyShowingQr) return { text, forcedQr: false };
  if (replyCount === 0 || replyCount % DONATION_NUDGE_INTERVAL !== 0) {
    return { text, forcedQr: false };
  }

  const extra = ` Venmo @${DEFAULT_VENMO_HANDLE}.`;
  return {
    text: `${text}${extra}`,
    forcedQr: true,
  };
}

module.exports = {
  buildDonationPayload,
  stripDonationMarkers,
  extractDonationSignal,
  maybeInjectDonationNudge,
};
