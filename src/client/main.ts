import { bootstrapClient } from './bootstrap.js';
import { renderMainApp } from './ui/main-app.js';
import './styles/app.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Main app root not found');
}

void bootstrapClient({
  mode: 'main',
  root,
  render: renderMainApp,
});
