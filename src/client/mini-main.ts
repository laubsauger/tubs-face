/// <reference types="vite/client" />
import { bootstrapClient, type BootstrapHandle } from './bootstrap-react.js';
import './styles/app.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Mini app root not found');
}

// ?embed=1 is the mini tile inside the face window. Its page background stays
// transparent, so mini Tubs stands on the main stage rather than in a box.
const embedded = new URLSearchParams(window.location.search).has('embed');
if (embedded) {
  document.documentElement.classList.add('is-embedded');
}

let handle: BootstrapHandle | null = null;

void bootstrapClient({ mode: 'mini', root, embedded }).then((h) => { handle = h; });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    handle?.dispose();
    handle = null;
  });
}
