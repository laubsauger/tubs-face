/// <reference types="vite/client" />
import { bootstrapClient, type BootstrapHandle } from './bootstrap-react.js';
import './styles/app.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Spectator app root not found');
}

const params = new URLSearchParams(window.location.search);
const actorParam = params.get('actor');
const actor: 'main' | 'small' = actorParam === 'small' ? 'small' : 'main';

let handle: BootstrapHandle | null = null;

void bootstrapClient({ mode: 'spectator', root, actor }).then((h) => { handle = h; });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    handle?.dispose();
    handle = null;
  });
}
