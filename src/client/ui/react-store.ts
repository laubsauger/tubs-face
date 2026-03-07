import { useSyncExternalStore } from 'react';
import type { AppState, AppStore } from '../state/app-state.js';

export function useAppSelector<T>(store: AppStore, selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
