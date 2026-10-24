import { create } from 'zustand';
import { safeStorage, STORAGE_KEYS } from '../config/storageHelpers';

export interface ReferenceImageItem {
  id: string;
  name: string;
  relativePath: string;
  url: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ResolutionCalibrationProfile {
  resolutionKey: string; // e.g., "4112x2658"
  width: number;
  height: number;
  scaleLinked: boolean;
  scaleX: number;
  scaleY: number;
  offsetX: number; // in px
  offsetY: number; // in px
  opacity: number; // 0 to 1
  invertImage: boolean;
}

export type CameraLookOverridePreset =
  | 'none'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'rearView';

export const DEFAULT_LOOK_HORIZONTAL_MAGNITUDE = 0.95;
export const DEFAULT_LOOK_VERTICAL_MAGNITUDE = 0.81;

export interface ReferenceOverlayState {
  enabled: boolean;
  folderName: string;
  images: ReferenceImageItem[];
  activeIndex: number;
  activeResolutionKey: string; // e.g. "4112x2658" or "ALL"
  profiles: Record<string, ResolutionCalibrationProfile>;

  // Camera Look / Rear-View simulation override
  cameraLookPreset: CameraLookOverridePreset;
  cameraLookStrength: number; // active preset magnitude (0.95 for L/R, 0.81 for U/D)
  cameraLookHorizontalStrength: number; // default 0.95 for Left/Right
  cameraLookVerticalStrength: number; // default 0.81 for Up/Down
  cameraLookXOverride: number; // -1..1 (default 0)
  cameraLookYOverride: number; // -1..1 (default 0)
  rearViewOverride: boolean;

  // Actions
  setEnabled: (enabled: boolean) => void;
  setFolderImages: (folderName: string, images: ReferenceImageItem[]) => void;
  clearImages: () => void;
  setActiveIndex: (index: number) => void;
  stepImage: (delta: number) => void;
  setActiveResolutionKey: (resKey: string) => void;
  getProfile: (resKey?: string) => ResolutionCalibrationProfile;
  updateProfile: (patch: Partial<ResolutionCalibrationProfile>, resKey?: string) => void;
  resetProfile: (resKey?: string) => void;
  importProfilesJson: (data: any) => boolean;
  exportProfilesJson: () => Record<string, any>;

  // Camera Look Override Actions
  setCameraLookPreset: (preset: CameraLookOverridePreset) => void;
  setCameraLookStrength: (strength: number) => void;
  setCameraLookAxes: (lookX: number, lookY: number) => void;
}

const STORAGE_KEY_REF_OVERLAY_PROFILES = STORAGE_KEYS.REF_OVERLAY_PROFILES;

export const DEFAULT_REFERENCE_RESOLUTION = '4112x2658';

export function createDefaultResolutionProfile(
  resKey = DEFAULT_REFERENCE_RESOLUTION
): ResolutionCalibrationProfile {
  const [wStr, hStr] = resKey.split('x');
  const width = parseInt(wStr, 10) || 4112;
  const height = parseInt(hStr, 10) || 2658;
  const isDefaultRef = `${width}x${height}` === DEFAULT_REFERENCE_RESOLUTION;
  return {
    resolutionKey: `${width}x${height}`,
    width,
    height,
    scaleLinked: true,
    scaleX: isDefaultRef ? 0.42 : 1.0,
    scaleY: isDefaultRef ? 0.42 : 1.0,
    offsetX: 0,
    offsetY: isDefaultRef ? 15 : 0,
    opacity: isDefaultRef ? 0.2 : 0.5,
    invertImage: false,
  };
}

function sanitizeProfile(
  key: string,
  raw: Partial<ResolutionCalibrationProfile>
): ResolutionCalibrationProfile {
  const base = createDefaultResolutionProfile(key);
  return {
    resolutionKey: key,
    width: typeof raw.width === 'number' ? raw.width : base.width,
    height: typeof raw.height === 'number' ? raw.height : base.height,
    scaleLinked: typeof raw.scaleLinked === 'boolean' ? raw.scaleLinked : base.scaleLinked,
    scaleX: typeof raw.scaleX === 'number' ? raw.scaleX : base.scaleX,
    scaleY: typeof raw.scaleY === 'number' ? raw.scaleY : base.scaleY,
    offsetX: typeof raw.offsetX === 'number' ? raw.offsetX : base.offsetX,
    offsetY: typeof raw.offsetY === 'number' ? raw.offsetY : base.offsetY,
    opacity: typeof raw.opacity === 'number' ? raw.opacity : base.opacity,
    invertImage: typeof raw.invertImage === 'boolean' ? raw.invertImage : base.invertImage,
  };
}

function loadSavedProfiles(): Record<string, ResolutionCalibrationProfile> {
  const defaultMap: Record<string, ResolutionCalibrationProfile> = {
    [DEFAULT_REFERENCE_RESOLUTION]: createDefaultResolutionProfile(DEFAULT_REFERENCE_RESOLUTION),
  };
  try {
    const raw = safeStorage.get(STORAGE_KEY_REF_OVERLAY_PROFILES);
    if (!raw) return defaultMap;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const src = parsed.profiles || parsed;
      for (const [k, v] of Object.entries(src)) {
        if (v && typeof v === 'object') {
          defaultMap[k] = sanitizeProfile(k, v as Partial<ResolutionCalibrationProfile>);
        }
      }
    }
  } catch (err) {
    console.warn('[referenceOverlayStore] Failed to load saved profiles:', err);
  }
  return defaultMap;
}

function saveProfilesToStorage(profiles: Record<string, ResolutionCalibrationProfile>) {
  safeStorage.set(STORAGE_KEY_REF_OVERLAY_PROFILES, JSON.stringify({ profiles }));
}

export const useReferenceOverlayStore = create<ReferenceOverlayState>((set, get) => ({
  enabled: true,
  folderName: '',
  images: [],
  activeIndex: 0,
  activeResolutionKey: DEFAULT_REFERENCE_RESOLUTION,
  profiles: loadSavedProfiles(),

  cameraLookPreset: 'none',
  cameraLookStrength: DEFAULT_LOOK_HORIZONTAL_MAGNITUDE,
  cameraLookHorizontalStrength: DEFAULT_LOOK_HORIZONTAL_MAGNITUDE,
  cameraLookVerticalStrength: DEFAULT_LOOK_VERTICAL_MAGNITUDE,
  cameraLookXOverride: 0,
  cameraLookYOverride: 0,
  rearViewOverride: false,

  setEnabled: (enabled) => set({ enabled }),

  setFolderImages: (folderName, images) => {
    const prevImages = get().images;
    prevImages.forEach((img) => {
      if (img.url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(img.url);
        } catch (err) {
          console.warn('[referenceOverlayStore] Failed to revoke previous blob URL:', err);
        }
      }
    });

    if (images.length === 0) {
      set({ folderName: '', images: [], activeIndex: 0 });
      return;
    }

    const hasRefRes = images.some(
      (img) => `${img.width}x${img.height}` === DEFAULT_REFERENCE_RESOLUTION
    );
    const firstImg = images[0];
    const targetResKey = hasRefRes
      ? DEFAULT_REFERENCE_RESOLUTION
      : `${firstImg.width}x${firstImg.height}`;

    const profiles = { ...get().profiles };
    for (const img of images) {
      const rk = `${img.width}x${img.height}`;
      if (!profiles[rk]) {
        profiles[rk] = createDefaultResolutionProfile(rk);
      }
    }
    saveProfilesToStorage(profiles);

    const firstMatchingIdx = images.findIndex(
      (img) => `${img.width}x${img.height}` === targetResKey
    );

    set({
      enabled: true,
      folderName,
      images,
      activeResolutionKey: targetResKey,
      activeIndex: firstMatchingIdx >= 0 ? firstMatchingIdx : 0,
      profiles,
    });
  },

  clearImages: () => {
    const prevImages = get().images;
    prevImages.forEach((img) => {
      if (img.url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(img.url);
        } catch (err) {
          console.warn('[referenceOverlayStore] Failed to revoke blob URL during clearImages:', err);
        }
      }
    });
    set({ folderName: '', images: [], activeIndex: 0 });
  },

  setActiveIndex: (index) => {
    const imgs = get().images;
    if (imgs.length === 0) return;
    const clamped = ((index % imgs.length) + imgs.length) % imgs.length;
    const img = imgs[clamped];
    const resKey = img ? `${img.width}x${img.height}` : get().activeResolutionKey;
    set({ activeIndex: clamped, activeResolutionKey: resKey });
  },

  stepImage: (delta) => {
    const { images, activeIndex, activeResolutionKey } = get();
    if (images.length === 0) return;
    const matchingIndices = images
      .map((img, idx) => ({ img, idx }))
      .filter(({ img }) =>
        activeResolutionKey === 'ALL'
          ? true
          : `${img.width}x${img.height}` === activeResolutionKey
      )
      .map((item) => item.idx);

    const pool = matchingIndices.length > 0 ? matchingIndices : images.map((_, i) => i);
    const currentPos = Math.max(0, pool.indexOf(activeIndex));
    const nextPos = ((currentPos + delta) % pool.length + pool.length) % pool.length;
    const nextIdx = pool[nextPos];
    const nextImg = images[nextIdx];
    set({
      activeIndex: nextIdx,
      activeResolutionKey:
        activeResolutionKey === 'ALL'
          ? 'ALL'
          : nextImg
          ? `${nextImg.width}x${nextImg.height}`
          : activeResolutionKey,
    });
  },

  setActiveResolutionKey: (resKey) => {
    const { images, profiles } = get();
    const nextProfiles = { ...profiles };
    if (resKey !== 'ALL' && !nextProfiles[resKey]) {
      nextProfiles[resKey] = createDefaultResolutionProfile(resKey);
      saveProfilesToStorage(nextProfiles);
    }
    const firstIdx = images.findIndex((img) =>
      resKey === 'ALL' ? true : `${img.width}x${img.height}` === resKey
    );
    set({
      activeResolutionKey: resKey,
      activeIndex: firstIdx >= 0 ? firstIdx : 0,
      profiles: nextProfiles,
    });
  },

  getProfile: (resKey) => {
    const state = get();
    const currentImg = state.images[state.activeIndex];
    const effectiveKey =
      resKey ||
      (state.activeResolutionKey !== 'ALL'
        ? state.activeResolutionKey
        : currentImg
        ? `${currentImg.width}x${currentImg.height}`
        : DEFAULT_REFERENCE_RESOLUTION);
    return (
      state.profiles[effectiveKey] || createDefaultResolutionProfile(effectiveKey)
    );
  },

  updateProfile: (patch, resKey) => {
    const state = get();
    const currentImg = state.images[state.activeIndex];
    const effectiveKey =
      resKey ||
      (state.activeResolutionKey !== 'ALL'
        ? state.activeResolutionKey
        : currentImg
        ? `${currentImg.width}x${currentImg.height}`
        : DEFAULT_REFERENCE_RESOLUTION);

    const existing =
      state.profiles[effectiveKey] || createDefaultResolutionProfile(effectiveKey);
    const next: ResolutionCalibrationProfile = sanitizeProfile(effectiveKey, {
      ...existing,
      ...patch,
    });

    // Enforce linked scale X & Y when scaleLinked is true
    if (next.scaleLinked) {
      if (patch.scaleX !== undefined && patch.scaleY === undefined) {
        next.scaleY = patch.scaleX;
      } else if (patch.scaleY !== undefined && patch.scaleX === undefined) {
        next.scaleX = patch.scaleY;
      } else if (patch.scaleLinked === true) {
        next.scaleY = next.scaleX;
      }
    }

    const nextProfiles = {
      ...state.profiles,
      [effectiveKey]: next,
    };
    saveProfilesToStorage(nextProfiles);
    set({ profiles: nextProfiles });
  },

  resetProfile: (resKey) => {
    const state = get();
    const currentImg = state.images[state.activeIndex];
    const effectiveKey =
      resKey ||
      (state.activeResolutionKey !== 'ALL'
        ? state.activeResolutionKey
        : currentImg
        ? `${currentImg.width}x${currentImg.height}`
        : DEFAULT_REFERENCE_RESOLUTION);
    const fresh = createDefaultResolutionProfile(effectiveKey);
    const nextProfiles = {
      ...state.profiles,
      [effectiveKey]: fresh,
    };
    saveProfilesToStorage(nextProfiles);
    set({ profiles: nextProfiles });
  },

  importProfilesJson: (data) => {
    if (!data || typeof data !== 'object') return false;
    const rawProfiles = data.referenceOverlayProfiles || data.profiles || data;
    if (!rawProfiles || typeof rawProfiles !== 'object') return false;
    const nextProfiles = { ...get().profiles };
    let importedCount = 0;
    for (const [k, v] of Object.entries(rawProfiles)) {
      if (v && typeof v === 'object' && /^\d+x\d+$/.test(k)) {
        nextProfiles[k] = sanitizeProfile(k, v as Partial<ResolutionCalibrationProfile>);
        importedCount++;
      }
    }
    if (importedCount > 0) {
      saveProfilesToStorage(nextProfiles);
      set({ profiles: nextProfiles });
      return true;
    }
    return false;
  },

  exportProfilesJson: () => {
    const state = get();
    const activeProfile = state.getProfile();
    return {
      version: 'hitbox-reference-overlay-v1',
      exportedAt: new Date().toISOString(),
      activeResolutionKey: activeProfile.resolutionKey,
      activeProfile,
      profiles: state.profiles,
    };
  },

  setCameraLookPreset: (preset) => {
    const state = get();
    let lookX = 0;
    let lookY = 0;
    let rearView = false;
    let nextStrength = state.cameraLookStrength;

    if (preset === 'left') {
      nextStrength = state.cameraLookHorizontalStrength || DEFAULT_LOOK_HORIZONTAL_MAGNITUDE;
      lookX = -nextStrength;
    } else if (preset === 'right') {
      nextStrength = state.cameraLookHorizontalStrength || DEFAULT_LOOK_HORIZONTAL_MAGNITUDE;
      lookX = nextStrength;
    } else if (preset === 'up') {
      nextStrength = state.cameraLookVerticalStrength || DEFAULT_LOOK_VERTICAL_MAGNITUDE;
      lookY = -nextStrength;
    } else if (preset === 'down') {
      nextStrength = state.cameraLookVerticalStrength || DEFAULT_LOOK_VERTICAL_MAGNITUDE;
      lookY = nextStrength;
    } else if (preset === 'rearView') {
      rearView = true;
    }

    set({
      cameraLookPreset: preset,
      cameraLookStrength: nextStrength,
      cameraLookXOverride: lookX,
      cameraLookYOverride: lookY,
      rearViewOverride: rearView,
    });
  },

  setCameraLookStrength: (strength) => {
    const clamped = Math.max(0, Math.min(1, Number(strength) || 0));
    const state = get();
    const preset = state.cameraLookPreset;
    let lookX = state.cameraLookXOverride;
    let lookY = state.cameraLookYOverride;
    let nextH = state.cameraLookHorizontalStrength;
    let nextV = state.cameraLookVerticalStrength;

    if (preset === 'left') {
      lookX = -clamped;
      lookY = 0;
      nextH = clamped;
    } else if (preset === 'right') {
      lookX = clamped;
      lookY = 0;
      nextH = clamped;
    } else if (preset === 'up') {
      lookX = 0;
      lookY = -clamped;
      nextV = clamped;
    } else if (preset === 'down') {
      lookX = 0;
      lookY = clamped;
      nextV = clamped;
    }
    set({
      cameraLookStrength: clamped,
      cameraLookHorizontalStrength: nextH,
      cameraLookVerticalStrength: nextV,
      cameraLookXOverride: lookX,
      cameraLookYOverride: lookY,
    });
  },

  setCameraLookAxes: (lookX, lookY) => {
    const cx = Math.max(-1, Math.min(1, Number(lookX) || 0));
    const cy = Math.max(-1, Math.min(1, Number(lookY) || 0));
    set({
      cameraLookXOverride: cx,
      cameraLookYOverride: cy,
      rearViewOverride: false,
    });
  },
}));
