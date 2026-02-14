import { $, body } from './dom.js';

let hideTimer = null;

function sanitizeHandle(handle) {
    const trimmed = String(handle || '').trim();
    if (!trimmed) return '@TubsBot';
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function buildQrImageUrl(donation) {
    if (donation?.qrImageUrl) return donation.qrImageUrl;
    if (donation?.qrData) {
        return `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(donation.qrData)}`;
    }
    const cleanHandle = sanitizeHandle(donation?.venmoHandle).replace(/^@/, '');
    return `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(`https://venmo.com/${cleanHandle}`)}`;
}

export function hideDonationQr() {
    clearTimeout(hideTimer);
    hideTimer = null;
    const card = $('#donation-card');
    if (!card) return;
    card.classList.remove('visible');
    card.classList.add('hidden');
}

export function showDonationQr(donation) {
    if (!donation?.show || body.classList.contains('sleeping')) return;

    const card = $('#donation-card');
    const qr = $('#donation-qr');
    const handle = $('#donation-handle');
    if (!card || !qr || !handle) return;

    qr.src = buildQrImageUrl(donation);
    handle.textContent = `Venmo ${sanitizeHandle(donation.venmoHandle)}`;

    card.classList.remove('hidden');
    card.classList.add('visible');

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        hideDonationQr();
    }, 12000);
}
