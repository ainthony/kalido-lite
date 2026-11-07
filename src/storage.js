import { get, set, del } from 'idb-keyval';

// Everything stays on-device (IndexedDB), like the original app.
export const saveFile = (key, file) => set(key, file);
export const loadFile = (key) => get(key);
export const removeFile = (key) => del(key);

export function loadPrefs(defaults) {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('kfl-prefs') || '{}') };
  } catch {
    return { ...defaults };
  }
}
export function savePrefs(prefs) {
  try {
    localStorage.setItem('kfl-prefs', JSON.stringify(prefs));
  } catch {
    /* private mode: ignore */
  }
}
