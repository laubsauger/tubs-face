import type { AppState } from '../state/app-state.js';

export function renderMiniApp(root: HTMLElement, state: AppState): void {
  root.innerHTML = `
    <main class="mini-shell">
      <p class="eyebrow">Mini</p>
      <h1>${state.connected ? 'Connected' : 'Waiting'}</h1>
      <p class="mini-copy">
        ${state.connected
          ? `Last message: ${escapeHtml(state.lastMessageType)}`
          : 'Waiting for the TypeScript bridge server.'}
      </p>
      <dl class="mini-kv">
        <div><dt>Render</dt><dd>${escapeHtml(state.config?.faceRenderMode ?? 'n/a')}</dd></div>
        <div><dt>Mode</dt><dd>${escapeHtml(state.health?.processingMode ?? 'n/a')}</dd></div>
        <div><dt>Model</dt><dd>${escapeHtml(state.config?.llmModel ?? 'n/a')}</dd></div>
        <div><dt>Expression</dt><dd>${escapeHtml(state.currentExpression)}</dd></div>
        <div><dt>Sleep</dt><dd>${state.sleeping ? 'yes' : 'no'}</dd></div>
        <div><dt>Listen</dt><dd>${escapeHtml(state.listenState)}</dd></div>
      </dl>
    </main>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
