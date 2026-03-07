const DONATION_CONFIRM_RE = /\b(?:i(?:'ve| have| just)?\s*(?:sent|donated|paid|venmoed)|sent you|i got you|i did donate|donation sent|venmo sent|paid you)\b/i;
const DONATION_PLEDGE_RE = /\b(?:i(?:'ll| will| am going to| can)\s*(?:donate|send|venmo|pay|chip in|contribute|sponsor|give(?:\s+you)?\s+money)|take my money|i got you(?:\s+(?:today|tonight|later|tomorrow))?|i(?:'m| am)\s+down(?:\s+to)?\s+donate)\b/i;

export function detectDonationSignal(text: string): 'confirmed' | 'pledge' | null {
  if (!text) {
    return null;
  }
  if (DONATION_CONFIRM_RE.test(text)) {
    return 'confirmed';
  }
  if (DONATION_PLEDGE_RE.test(text)) {
    return 'pledge';
  }
  return null;
}
