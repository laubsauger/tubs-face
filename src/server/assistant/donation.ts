import type { TurnDonation } from '../../shared/contracts/turn-script.js';
import { runtimeConfig } from '../config/runtime.js';

const DONATION_MARKER = '[[SHOW_QR]]';
export const DONATION_MARKER_RE = /\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/i;
const DONATION_KEYWORDS = /\b(venmo|paypal|cash\s*app|qr\s*code|donat(?:e|ion|ions|ing)|chip\s*in|contribut(?:e|ion)|sponsor|tip(?:s|ping)?|support\s+(?:me|tubs|the\s+(?:build|upgrade|upgrades|project))|help\s+fund|fund\s+(?:the\s+)?(?:build|upgrade|upgrades|project)|back\s+(?:the\s+)?(?:build|project))\b/i;

export interface DonationSignalResult {
  text: string;
  donation: TurnDonation;
}

export function buildDonationPayload(show: boolean, reason = 'none'): TurnDonation {
  return {
    show,
    reason,
    venmoHandle: runtimeConfig.donationHandle,
    qrData: runtimeConfig.donationQrData,
    qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(runtimeConfig.donationQrData)}`,
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

export function stripDonationMarkers(text: string): string {
  return String(text).replace(/\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/gi, ' ');
}
