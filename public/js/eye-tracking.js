import { eyes } from './dom.js';

export function lookAt(x, y) {
    const maxX = 12;
    const maxY = 8;
    const px = Math.max(-maxX, Math.min(maxX, x * maxX));
    const py = Math.max(-maxY, Math.min(maxY, y * maxY));
    eyes.forEach(e => {
        e.style.setProperty('--look-x', `${px}px`);
        e.style.setProperty('--look-y', `${py}px`);
    });
}

export function resetGaze() {
    eyes.forEach(e => {
        e.style.setProperty('--look-x', '0px');
        e.style.setProperty('--look-y', '0px');
    });
}
