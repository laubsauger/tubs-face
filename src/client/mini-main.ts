import { bootstrapClient } from './bootstrap.js';
import { renderMiniApp } from './ui/mini-app.js';
import './styles/app.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Mini app root not found');
}

void bootstrapClient({
  mode: 'mini',
  root,
  render: renderMiniApp,
});
