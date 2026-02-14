const DONATION_CONFIRM_RE = /\b(?:i(?:'ve| have| just)?\s*(?:sent|donated|paid|venmoed)|sent you|i got you|i did donate|donation sent|venmo sent|paid you)\b/i;
const DONATION_PLEDGE_RE = /\b(?:i(?:'ll| will| am going to| can)\s*(?:donate|send|venmo|pay|chip in|contribute|sponsor|give(?:\s+you)?\s+money)|take my money|i got you(?:\s+(?:today|tonight|later|tomorrow))?|i(?:'m| am)\s+down(?:\s+to)?\s+donate)\b/i;

function summarizeTurnBeat(beat, index) {
    const actor = String(beat?.actor || 'main');
    const action = String(beat?.action || 'speak');
    const emoji = beat?.emotion?.emoji || '-';
    const text = String(beat?.text || '').replace(/\s+/g, ' ').trim();
    const preview = text.length > 56 ? `${text.slice(0, 56)}...` : text;
    return `${index}:${actor}/${action}/${emoji}${preview ? ` "${preview}"` : ''}`;
}

export function summarizeTurnScript(beats) {
    if (!Array.isArray(beats) || beats.length === 0) return '[none]';
    return beats.map((beat, idx) => summarizeTurnBeat(beat, idx)).join(' | ');
}

export function detectDonationSignal(text) {
    if (!text) return null;
    if (DONATION_CONFIRM_RE.test(text)) return 'confirmed';
    if (DONATION_PLEDGE_RE.test(text)) return 'pledge';
    return null;
}
