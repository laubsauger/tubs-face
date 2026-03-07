import { bootstrapClient } from './bootstrap-react.js';
import './styles/app.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Main app root not found');
}

void bootstrapClient({
  mode: 'main',
  root,
});
