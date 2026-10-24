/**
 * storageHelpers.ts
 * Pure LocalStorage persistence, storage key constants (SSOT), and validation helpers.
 */

export const STORAGE_KEYS = Object.freeze({
  UI_SCALE: 'ui-scale',
  UI_THEME: 'ui-theme',
  GAME_THEME: 'theme',
  SAFE_AREA_MARGIN: 'simpleui-safe-area-margin',
  SAFE_AREA_VISIBLE: 'simpleui-safe-area-visible',
  DISPLAY_SETTINGS: 'display-settings',
  COLOR_PREFS: 'color-preferences',
  PLAYER_NAME: 'player-name',
  CAMERA_SETTINGS: 'camera-settings',
  GRAPHICS_SETTINGS: 'graphics-settings',
  AUDIO_SETTINGS: 'audio-settings',
  MATERIALS: 'visual-materials',
  TRAJECTORY: 'ball-trajectory-config',
  TELEMETRY_SETTINGS: 'telemetry-settings',
  BOOST_PAD_TUNER: 'boost-pad-tuner',
  DRIFTWOODS_TUNER: 'driftwoods-tuner',
  CLOCK_PACING: 'clock-pacing',
  INPUT_BUFFER_TARGET: 'input-buffer-target',
  INPUT_BUFFER_THRESHOLD: 'input-buffer-threshold',
  FLOATING_OPACITY: 'floating-window-opacity',
  BOT_SETTINGS: 'bot-settings',
  KICKOFF_WS_OFFSET_PCT: 'kickoff-ws-offset-pct',
  INPUT_BINDINGS: 'input-bindings',
  CONTROLLER_SELECTION: 'controller-selection',
  TOUCH_SETTINGS: 'touch-settings',
  SIGNALING_URL: 'signaling-url',
  ACTIVE_HOST: 'active-host',
  REF_OVERLAY_PROFILES: 'hitbox-ref-overlay-profiles',
});

export const UI_THEME_STORAGE_KEY = STORAGE_KEYS.UI_THEME;

export const safeStorage = {
  get: (k: string, fallback: string | null = null): string | null => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(k) ?? fallback : fallback;
    } catch (err) {
      console.warn(`[safeStorage] Error reading key "${k}" from localStorage:`, err);
      return fallback;
    }
  },
  getItem: (k: string, fallback: string | null = null): string | null => {
    return safeStorage.get(k, fallback);
  },
  set: (k: string, v: unknown): void => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(k, String(v));
    } catch (err) {
      console.warn(`[safeStorage] Error writing key "${k}" to localStorage:`, err);
    }
  },
  setItem: (k: string, v: unknown): void => {
    safeStorage.set(k, v);
  },
  remove: (k: string): void => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(k);
    } catch (err) {
      console.warn(`[safeStorage] Error removing key "${k}" from localStorage:`, err);
    }
  },
  removeItem: (k: string): void => {
    safeStorage.remove(k);
  },
};

export function safeLocalStorageGet(key: string): string | null {
  return safeStorage.get(key, null);
}

export function safeLocalStorageSet(key: string, value: string): void {
  safeStorage.set(key, value);
}

export function safeLocalStorageRemove(key: string): void {
  safeStorage.remove(key);
}

export function isPlainObject(val: unknown): val is Record<string, any> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function booleanOrDefault(val: unknown, fallback: boolean): boolean {
  if (typeof val !== 'boolean' && val !== undefined && val !== null) {
    console.warn('[storageHelpers] Non-boolean value in booleanOrDefault, falling back:', { val, fallback });
  }
  return typeof val === 'boolean' ? val : fallback;
}

export function clampNumberOrDefault(
  val: unknown,
  fallback: number,
  constraints: { min?: number; max?: number; integer?: boolean } = {}
): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    if (val !== undefined && val !== null) {
      console.warn('[storageHelpers] Non-finite number in clampNumberOrDefault, falling back:', { val, fallback });
    }
    return fallback;
  }
  let num = val;
  if (constraints.integer) num = Math.round(num);
  if (constraints.min !== undefined) num = Math.max(constraints.min, num);
  if (constraints.max !== undefined) num = Math.min(constraints.max, num);
  return num;
}

export function stringOrDefault(val: unknown, allowed: readonly string[] | Set<string>, fallback: string): string {
  if (typeof val === 'string') {
    if (Array.isArray(allowed) && allowed.includes(val)) return val;
    if (allowed instanceof Set && allowed.has(val)) return val;
  }
  if (val !== undefined && val !== null) {
    console.warn('[storageHelpers] Disallowed string in stringOrDefault, falling back:', { val, fallback });
  }
  return fallback;
}

export function filterArraySlice<T>(val: unknown, filterFn: (item: any) => boolean, maxLen: number): T[] | null {
  return Array.isArray(val) ? (val.filter(filterFn).slice(0, maxLen) as T[]) : null;
}

export interface LocalStorageStore<T> {
  key: string;
  defaults: () => T;
  load: () => T;
  get: () => T;
  loadInto: (target: T) => T;
  save: (data: T) => void;
  clear: () => void;
}

export function createLocalStorageStore<T extends Record<string, any>>(
  key: string,
  defaultFactory: () => T,
  migrateFn?: (target: T, loaded: any) => void
): LocalStorageStore<T> {
  const load = (): T => {
    const defaults = defaultFactory();
    const raw = safeStorage.get(key);
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        if (migrateFn) {
          migrateFn(defaults, parsed);
        } else {
          Object.assign(defaults, parsed);
        }
        return defaults;
      }
      console.warn(`[storageHelpers] Stored settings for key "${key}" is not a plain object, falling back to defaults:`, parsed);
      return defaultFactory();
    } catch (err) {
      console.warn(`[storageHelpers] Corrupted stored settings for key "${key}", using defaults:`, err);
      return defaultFactory();
    }
  };

  return {
    key,
    defaults: defaultFactory,
    load,
    get: load,
    loadInto(target: T) {
      return Object.assign(target, load());
    },
    save(data: T) {
      try {
        safeStorage.set(key, JSON.stringify(data));
      } catch (err) {
        console.warn(`[storageHelpers] Failed to stringify settings for key "${key}":`, err);
      }
    },
    clear() {
      safeStorage.remove(key);
    },
  };
}
