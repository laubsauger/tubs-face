export function renderPanelCardClass(collapsed: boolean): string {
  return `panel-surface panel-surface-compact transition-all ${collapsed ? 'is-collapsed h-11' : ''}`;
}
