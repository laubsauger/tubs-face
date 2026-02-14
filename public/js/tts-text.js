const DONATION_HINT_RE = /\b(venmo|paypal|cash\s*app|donat(?:e|ion|ions|ing)|fundrais(?:er|ing)|wheel(?:s|chair)?(?:\s+fund)?|qr\s*code|chip\s*in|contribut(?:e|ion)|spare\s*change|support\s+(?:me|tubs|the\s+fund)|sponsor|tip(?:s|ping)?|money|fund(?:s|ing|ed)?|beg(?:ging)?|please\s+(?:help|give|support)|give\s+(?:me\s+)?money|rapha|thailand|help\s+(?:me|tubs|out)|need(?:s)?\s+(?:your\s+)?(?:help|money|support|funds))\b/i;
const DONATION_MARKER_RE = /\[{1,2}\s*SHOW[\s_-]*QR\s*\]{1,2}/gi;

export function inferDonationFromText(text) {
    if (!DONATION_HINT_RE.test(String(text || ''))) return null;
    return {
        show: true,
        reason: 'text_fallback',
        venmoHandle: 'tubs-wheel-fund',
    };
}

export function normalizeSpeechText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(DONATION_MARKER_RE, ' ')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}
