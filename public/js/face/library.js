import { logChat } from '../chat-log.js';

let faceLibrary = [];

export async function loadFaceLibrary() {
    try {
        const res = await fetch('/faces');
        const data = await res.json();
        faceLibrary = data.faces || [];
        if (faceLibrary.length > 0) {
            const names = [...new Set(faceLibrary.map(f => f.name))];
            logChat('sys', `Face library: ${faceLibrary.length} embedding(s) for ${names.length} person(s)`);
        }
    } catch (err) {
        console.warn('[Faces] Could not load face library:', err);
        faceLibrary = [];
    }
}

export function getFaceLibrary() {
    return faceLibrary;
}
