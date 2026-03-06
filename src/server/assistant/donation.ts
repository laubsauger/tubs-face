import type { TurnDonation } from '../../shared/contracts/turn-script.js';

const DONATION_MARKER = '[[SHOW_QR]]';
const DONATION_MARKER_RE = /\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/i;
const DONATION_KEYWORDS = /\b(venmo|paypal|cash\s*app|donat(?:e|ion|ions|ing)|fundrais(?:er|ing)|wheel(?:s|chair)?(?:\s+fund)?|qr\s*code|chip\s*in|contribut(?:e|ion)|spare\s*change|support\s+(?:me|tubs|the\s+fund)|sponsor|tip(?:s|ping)?|money|fund(?:s|ing|ed)?|beg(?:ging)?|please\s+(?:help|give|support)|give\s+(?:me\s+)?money|rapha|thailand|help\s+(?:me|tubs|out)|need(?:s)?\s+(?:your\s+)?(?:help|money|support|funds))\b/i;
const DONATION_NUDGE_INTERVAL = 6;
const DEFAULT_VENMO_HANDLE = process.env.DONATION_VENMO || 'TubsBot';
const DEFAULT_DONATION_QR_DATA = process.env.DONATION_QR_DATA || `https://venmo.com/${DEFAULT_VENMO_HANDLE}`;

export interface DonationSignalResult {
  text: string;
  donation: TurnDonation;
}

export interface DonationNudgeResult {
  text: string;
  forcedQr: boolean;
}

export function buildDonationPayload(show: boolean, reason = 'none'): TurnDonation {
  return {
    show,
    reason,
    venmoHandle: DEFAULT_VENMO_HANDLE,
    qrData: DEFAULT_DONATION_QR_DATA,
    qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(DEFAULT_DONATION_QR_DATA)}`,
  };
}

export function extractDonationSignal(text: string): DonationSignalResult {
  let cleaned = String(text);
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

export function maybeInjectDonationNudge(text: string, alreadyShowingQr: boolean, replyCount: number): DonationNudgeResult {
  if (alreadyShowingQr || replyCount === 0 || replyCount % DONATION_NUDGE_INTERVAL !== 0) {
    return { text, forcedQr: false };
  }

  return {
    text: `${text} Venmo @${DEFAULT_VENMO_HANDLE}.`,
    forcedQr: true,
  };
}

function stripDonationMarkers(text: string): string {
  return String(text).replace(/\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/gi, ' ');
}
