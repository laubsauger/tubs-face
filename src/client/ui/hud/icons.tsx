import type { JSX } from 'react';
import type { DockTab } from '../../state/app-state.js';

// Line icons for the dock rail, drawn on a 24 px grid with the text colour.
const PATHS: Record<DockTab, string> = {
  chat: 'M4 5h16v11H9l-5 4z',
  studio: 'M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13',
  voice: 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21',
  mind: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  people: 'M9 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M2.5 20a6.5 6.5 0 0 1 13 0M16.5 6.5a2.5 2.5 0 1 1 0 5M17.5 14.5a5 5 0 0 1 4 5.5',
  memory: 'M5 4h11l3 3v13H5zM8.5 9a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M7.5 16a2.5 2.5 0 0 1 5 0M14 9h2.5M14 13h2.5',
  controls: 'M4 7h16M4 17h16M9 5v4M15 15v4',
  stats: 'M5 20v-8M12 20V5M19 20v-5',
  log: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1',
  fx: 'M4 20L15 9M17 3v4M15 5h4M20 10v3M18.5 11.5h3M10 3v2M9 4h2',
};

export function DockIcon({ tab }: { tab: DockTab }): JSX.Element {
  return (
    <svg className="dock-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[tab]} />
    </svg>
  );
}
