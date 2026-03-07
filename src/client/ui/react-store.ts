import { useStore, type StoreApi } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { AppState, AppStore } from '../state/app-state.js';

export function useAppSelector<T>(store: AppStore, selector: (state: AppState) => T): T {
  return useStore(store as unknown as StoreApi<AppState>, useShallow(selector));
}
