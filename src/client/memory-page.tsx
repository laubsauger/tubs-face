// /?view=memory: the memory view on its own page, one quick link away. Only
// HTTP to this server: no socket, face, audio, mic or camera.

import { createRoot } from 'react-dom/client';
import { MemoryView } from './ui/panels/MemoryPanel.js';

export function mountMemoryPage(root: HTMLElement): () => void {
  document.title = 'Tubs Memory';
  const reactRoot = createRoot(root);
  reactRoot.render(
    <main className="memory-page">
      <MemoryView active layout="page" />
    </main>,
  );
  return () => reactRoot.unmount();
}
