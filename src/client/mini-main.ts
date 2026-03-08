/// <reference types="vite/client" />
import { bootstrapClient, type BootstrapHandle } from './bootstrap-react.js';
import './styles/app.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Mini app root not found');
}

let handle: BootstrapHandle | null = null;

void bootstrapClient({ mode: 'mini', root }).then((h) => { handle = h; });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    handle?.dispose();
    handle = null;
  });
}
