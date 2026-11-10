import { describe, expect, it } from 'vitest';
import { watchFor } from './watch.js';

// The studio listener sends its live state and camera only to dashboards that
// show them: ten reports and a few pictures a second, for nobody, would load
// the studio Mac and the network for nothing.

const shown = { connected: true, visible: true, dockTab: 'chat' as const, dockFolded: false, uiHidden: false, faceEnrollOpen: false };

describe('watchFor', () => {
  it('asks for the live state while the dashboard is on screen, the camera only where it is drawn', () => {
    expect(watchFor(shown)).toEqual({ live: true, video: false });
    expect(watchFor({ ...shown, dockTab: 'people' })).toEqual({ live: true, video: true });
    expect(watchFor({ ...shown, dockTab: 'studio' })).toEqual({ live: true, video: true });
    expect(watchFor({ ...shown, dockTab: 'studio', dockFolded: true })).toEqual({ live: true, video: false });
    expect(watchFor({ ...shown, faceEnrollOpen: true })).toEqual({ live: true, video: true });
  });

  it('asks for nothing from a hidden or disconnected dashboard', () => {
    expect(watchFor({ ...shown, dockTab: 'people', visible: false })).toEqual({ live: false, video: false });
    expect(watchFor({ ...shown, dockTab: 'people', connected: false })).toEqual({ live: false, video: false });
  });
});
