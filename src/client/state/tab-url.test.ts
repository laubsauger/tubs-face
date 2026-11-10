import { describe, expect, it } from 'vitest';
import { DOCK_TABS, createAppStore, tabFromUrl } from './app-state.js';

// The sentient panel's pulse bar opens the dashboard on the People tab
// (&tab=people) to show who is recognised. A link must open that tab even if
// the operator left the dock folded on another one; a tab this view doesn't
// have (the dashboard has no Chat) or a made-up one is ignored.

const dashboardTabs = DOCK_TABS.filter((tab) => tab !== 'chat');

describe('tabFromUrl', () => {
  it('takes a tab the view has, and nothing else', () => {
    expect(tabFromUrl('?view=dashboard&tab=people', dashboardTabs)).toBe('people');
    expect(tabFromUrl('?view=dashboard&tab=chat', dashboardTabs)).toBeNull();
    expect(tabFromUrl('?view=dashboard&tab=nope', dashboardTabs)).toBeNull();
    expect(tabFromUrl('?view=dashboard', dashboardTabs)).toBeNull();
  });

  it('opens the store on that tab with the dock unfolded, ahead of the stored preference', () => {
    const store = createAppStore(undefined, { tab: 'people' });
    expect(store.getState()).toMatchObject({ dockTab: 'people', dockFolded: false });
    expect(createAppStore(undefined, { tab: null }).getState().dockTab).toBe('chat');
  });
});
