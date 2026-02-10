import { pupils } from './dom.js';

export function lookAt(x, y) {
    const maxX = 6;
    const maxY = 4;
    const px = Math.max(-maxX, Math.min(maxX, x * maxX));
    const py = Math.max(-maxY, Math.min(maxY, y * maxY));
    pupils.forEach(p => {
        p.style.setProperty('--look-x', `${px}px`);
        p.style.setProperty('--look-y', `${py}px`);
    });
}

export function resetGaze() {
    pupils.forEach(p => {
        p.style.setProperty('--look-x', '0px');
        p.style.setProperty('--look-y', '0px');
    });
}
