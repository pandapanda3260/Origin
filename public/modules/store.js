/**
 * Minimal reactive store — inspired by CC-Source/src/state/store.ts
 * Usage: const store = createStore(initialState);
 *        store.getState() / store.setState(fn) / store.subscribe(listener)
 */
export function createStore(initialState, onChange) {
  let state = initialState;
  const listeners = new Set();
  return {
    getState: () => state,
    setState(updater) {
      const prev = state;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (Object.is(next, prev)) return;
      state = next;
      if (onChange) onChange({ newState: next, oldState: prev });
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Global app store.
 * Stage 1: structure only — main.js still uses its own var copies.
 * Stage 3: migrate project/settings/activePage/videoState here.
 */
export const appStore = createStore({
  project: null,
  settings: {
    models: {
      text:       { key: '', base: '', model: '' },
      image:      { key: '', base: '', model: '' },
      multimodal: { key: '', base: '', model: '' },
      video:      { key: '', base: '', model: '', adapter: 'openai_compat' },
    },
  },
  billing: {
    summary: null,
    plans: [],
    topupPacks: [],
    paywall: null,
    pendingOrder: null,
  },
  activePage: 'overview',
  videoState: {
    tasks: [],
    form: { ratio: '9:16', quality: '1080p', duration: 8, startDataUrl: '', endDataUrl: '' },
  },
});
