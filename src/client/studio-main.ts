/// <reference types="vite/client" />
import { bootstrapClient, type BootstrapHandle } from './bootstrap-react.js';
import './styles/app.css';

// studio-face.html?actor=main|small[&size=1024][&monitor=1]: one head for the
// studio, published to the site node (see studio/runtime.ts).
const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Studio app root not found');
}

const params = new URLSearchParams(window.location.search);
const actor: 'main' | 'small' = params.get('actor') === 'small' ? 'small' : 'main';
const requestedSize = Number.parseInt(params.get('size') ?? '', 10);
const size = Number.isFinite(requestedSize) ? Math.max(256, Math.min(2048, requestedSize)) : 1024;
const monitor = params.get('monitor') === '1' || params.get('monitor') === 'true';
document.title = `Tubs studio · ${actor}`;
document.documentElement.classList.add('is-studio');

let handle: BootstrapHandle | null = null;

void bootstrapClient({ mode: 'studio', root, actor, studio: { size, monitor } }).then((h) => { handle = h; });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    handle?.dispose();
    handle = null;
  });
}
