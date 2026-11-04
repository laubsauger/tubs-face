/// <reference types="vite/client" />
import { bootstrapClient, type BootstrapHandle } from './bootstrap-react.js';
import './styles/app.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Main app root not found');
}

// /?view=dashboard is the operator HUD for a separate screen, without a face.
const view = new URLSearchParams(window.location.search).get('view');
const mode = view === 'dashboard' ? 'dashboard' : 'main';
if (mode === 'dashboard') {
  document.title = 'Tubs Dashboard';
} else {
  // Lets the dashboard bring this window up again instead of opening a second face.
  window.name = 'tubs-face';
}

let handle: BootstrapHandle | null = null;

void bootstrapClient({ mode, root }).then((h) => { handle = h; });

// Clean up old instance on HMR to prevent duplicate WS connections / audio playback
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    handle?.dispose();
    handle = null;
  });
}
