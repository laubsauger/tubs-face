import type { AppStore, PanelKey } from '../state/app-state.js';

export interface PanelRuntime {
  init(): void;
  bind(root: HTMLElement): void;
  dispose(): void;
}

const CHAT_PANEL_MIN_WIDTH = 320;
const CHAT_PANEL_MAX_WIDTH = 920;

export function createPanelRuntime(store: AppStore): PanelRuntime {
  let uptimeTimer: number | null = null;
  let dragCleanup: (() => void) | null = null;

  return {
    init(): void {
      uptimeTimer = window.setInterval(() => {
        store.setState((current) => {
          if (current.sleeping) {
            return current;
          }

          return {
            ...current,
            awakeElapsedSec: Math.max(0, Math.floor((Date.now() - current.awakeSinceTs) / 1000)),
          };
        });
      }, 1000);
    },
    bind(root: HTMLElement): void {
      bindPanelToggles(root);
      bindChatResize(root);
    },
    dispose(): void {
      if (uptimeTimer != null) {
        window.clearInterval(uptimeTimer);
        uptimeTimer = null;
      }
      dragCleanup?.();
      dragCleanup = null;
    },
  };

  function bindPanelToggles(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('[data-panel-toggle]').forEach((button) => {
      button.onclick = () => {
        const key = button.dataset.panelToggle as PanelKey | undefined;
        if (!key) {
          return;
        }

        store.setState((current) => ({
          ...current,
          collapsedPanels: {
            ...current.collapsedPanels,
            [key]: !current.collapsedPanels[key],
          },
        }));
      };
    });
  }

  function bindChatResize(root: HTMLElement): void {
    const handle = root.querySelector<HTMLDivElement>('#chat-panel-resize');
    const panel = root.querySelector<HTMLElement>('#chat-panel-card');
    if (!handle || !panel) {
      dragCleanup?.();
      dragCleanup = null;
      return;
    }

    handle.onmousedown = (event: MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panel.getBoundingClientRect().width;

      const onMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = Math.max(CHAT_PANEL_MIN_WIDTH, Math.min(CHAT_PANEL_MAX_WIDTH, Math.round(startWidth + delta)));
        store.setState((current) => ({
          ...current,
          chatPanelWidth: nextWidth,
        }));
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      dragCleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  }
}
