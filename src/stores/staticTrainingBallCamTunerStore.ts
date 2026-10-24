import { create } from 'zustand';

export interface StaticTrainingBallCamTunerConfig {
  /** Camera distance behind the ball along the velocity direction (UU) */
  distance: number;
  /** Vertical elevation offset relative to the ball center perpendicular to aim (UU) */
  height: number;
  /** Camera pitch offset angle relative to ball velocity pitch (degrees; negative looks downward over the ball) */
  angle: number;
  /** Horizontal lateral offset perpendicular to the velocity direction (UU; negative = left, positive = right) */
  lateralOffset: number;
  /** Temporary override opacity for the ball while in Edit Mode (default 0.7) */
  editBallOpacity: number;
  /** Whether the temporary Edit Mode ball opacity override is active (reverts to Global when testing [G] or playing) */
  enableEditOpacityOverride: boolean;
}

export const DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG: StaticTrainingBallCamTunerConfig = {
  distance: 330,
  height: 400,
  angle: -45,
  lateralOffset: 150,
  editBallOpacity: 0.7,
  enableEditOpacityOverride: true,
};

export const DEFAULT_STATIC_TRAINING_BALL_CAM_TUNER_CONFIG =
  DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG;

const STORAGE_KEY = 'rc_static_training_ball_cam_tuner_v2';

function loadInitialConfig(): StaticTrainingBallCamTunerConfig {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          distance:
            typeof parsed.distance === 'number'
              ? parsed.distance
              : DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG.distance,
          height:
            typeof parsed.height === 'number'
              ? parsed.height
              : DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG.height,
          angle:
            typeof parsed.angle === 'number'
              ? parsed.angle
              : DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG.angle,
          lateralOffset:
            typeof parsed.lateralOffset === 'number'
              ? parsed.lateralOffset
              : DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG.lateralOffset,
          editBallOpacity:
            typeof parsed.editBallOpacity === 'number'
              ? parsed.editBallOpacity
              : DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG.editBallOpacity,
          enableEditOpacityOverride:
            typeof parsed.enableEditOpacityOverride === 'boolean'
              ? parsed.enableEditOpacityOverride
              : DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG.enableEditOpacityOverride,
        };
      }
    }
  } catch {
    // ignore storage errors
  }
  return { ...DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG };
}

function saveConfigToStorage(cfg: StaticTrainingBallCamTunerConfig) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    }
  } catch {
    // ignore storage errors
  }
}

export interface StaticTrainingBallCamTunerState extends StaticTrainingBallCamTunerConfig {
  updateConfig: (patch: Partial<StaticTrainingBallCamTunerConfig>) => void;
  switchLateralSide: () => void;
  resetDefaults: () => void;
}

export const useStaticTrainingBallCamTunerStore = create<StaticTrainingBallCamTunerState>((set, get) => ({
  ...loadInitialConfig(),
  updateConfig: (patch) => {
    const current = get();
    const next: StaticTrainingBallCamTunerConfig = {
      distance: patch.distance !== undefined ? Number(patch.distance) : current.distance,
      height: patch.height !== undefined ? Number(patch.height) : current.height,
      angle: patch.angle !== undefined ? Number(patch.angle) : current.angle,
      lateralOffset:
        patch.lateralOffset !== undefined ? Number(patch.lateralOffset) : current.lateralOffset,
      editBallOpacity:
        patch.editBallOpacity !== undefined
          ? Number(patch.editBallOpacity)
          : current.editBallOpacity,
      enableEditOpacityOverride:
        patch.enableEditOpacityOverride !== undefined
          ? Boolean(patch.enableEditOpacityOverride)
          : current.enableEditOpacityOverride,
    };
    saveConfigToStorage(next);
    set(next);
  },
  switchLateralSide: () => {
    const current = get();
    const next: StaticTrainingBallCamTunerConfig = {
      distance: current.distance,
      height: current.height,
      angle: current.angle,
      lateralOffset: -current.lateralOffset,
      editBallOpacity: current.editBallOpacity,
      enableEditOpacityOverride: current.enableEditOpacityOverride,
    };
    saveConfigToStorage(next);
    set(next);
  },
  resetDefaults: () => {
    const next = { ...DEFAULT_STATIC_TRAINING_BALL_CAM_CONFIG };
    saveConfigToStorage(next);
    set(next);
  },
}));
