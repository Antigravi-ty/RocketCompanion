import { floatingStore, type PresetConfig } from './floatingStore';

export type { PresetConfig };

export const DIAGNOSTICS_WINDOW_PRESET: PresetConfig = {
  id: 'diagnostics-telemetry',
  title: 'Live System Telemetry',
  category: 'Diagnostic',
  width: 460,
  height: 440,
  resizable: true,
  singleton: true,
};

export const EVENT_STREAM_OB_PRESET: PresetConfig = {
  id: 'event-stream-ob',
  title: 'Event Stream OB',
  category: 'Observer',
  width: 460,
  height: 420,
  resizable: true,
  singleton: true,
};

export const DETERMINISM_HARNESS_PRESET: PresetConfig = {
  id: 'determinism-harness',
  title: 'Dual-Arena Determinism Harness',
  category: 'Determinism',
  width: 440,
  height: 420,
  resizable: true,
  singleton: true,
};

export const CAMERA_DETERMINISM_PRESET: PresetConfig = {
  id: 'camera-determinism-harness',
  title: 'Camera Deterministic Harness',
  category: 'CameraDeterminism',
  width: 460,
  height: 460,
  resizable: true,
  singleton: true,
};

export const NETWORK_DIAGNOSTICS_PRESET: PresetConfig = {
  id: 'network-diagnostics',
  title: 'Multiplayer Network Diagnostics',
  category: 'Network',
  width: 460,
  height: 440,
  resizable: true,
  singleton: true,
};

export const BOOST_PAD_TUNER_PRESET: PresetConfig = {
  id: 'boost-pad-tuner',
  title: 'Boost Pad Visual Tuner',
  category: 'Graphics',
  width: 460,
  height: 540,
  resizable: true,
  singleton: true,
};

export const DRIFTWOODS_TUNER_PRESET: PresetConfig = {
  id: 'driftwoods-tuner',
  title: 'Driftwoods Stadium Tuner',
  category: 'Graphics',
  width: 480,
  height: 560,
  resizable: true,
  singleton: true,
};

export const OPACITY_MANAGER_PRESET: PresetConfig = {
  id: 'opacity-manager',
  title: 'Floating Window Opacity',
  category: 'System',
  width: 320,
  height: 100,
  resizable: false,
  singleton: true,
  defaultCenter: true,
};

export const KICKOFF_TRAINING_PRESET: PresetConfig = {
  id: 'kickoff-training-config',
  title: 'Kickoff Training (PPO)',
  category: 'Training',
  width: 460,
  height: 595,
  resizable: true,
  singleton: true,
};

export const GOAL_BARRIER_PRESET: PresetConfig = {
  id: 'goal-barrier-config',
  title: 'Goal Barrier Config',
  category: 'GoalBarrier',
  width: 460,
  height: 520,
  resizable: true,
  singleton: true,
};

export const REWINDER_CONFIGURATOR_PRESET: PresetConfig = {
  id: 'rewinder-configurator',
  title: 'Rewinder Configurator',
  category: 'Rewinder',
  width: 460,
  height: 520,
  resizable: true,
  singleton: true,
};

export const DEV_TEST_LAB_PRESET: PresetConfig = {
  id: 'dev-test-lab-controller',
  title: 'Subsystem Isolation & MVP Lab',
  category: 'DeveloperLab',
  width: 470,
  height: 560,
  resizable: true,
  singleton: true,
};

export const EXPERIMENTAL_FEATURES_PRESET: PresetConfig = {
  id: 'experimental-features',
  title: 'Atmosphere & FX Tuner',
  category: 'Experimental',
  width: 480,
  height: 580,
  resizable: true,
  singleton: true,
};

export const EXPERIMENTAL_MULTI_BOTS_PRESET: PresetConfig = {
  id: 'experimental-multi-bots',
  title: 'Experimental Multiple Bots Mode',
  category: 'ExperimentalBots',
  width: 490,
  height: 620,
  resizable: true,
  singleton: true,
};

export const VEHICLE_GARAGE_TUNER_PRESET: PresetConfig = {
  id: 'vehicle-garage-tuner',
  title: 'Vehicle Model & Offset Tuner',
  category: 'VehicleTuner',
  width: 480,
  height: 620,
  resizable: true,
  singleton: true,
};

export const VEHICLE_GLOBAL_FX_TUNER_PRESET: PresetConfig = {
  id: 'vehicle-global-fx-tuner',
  title: 'Vehicle Global Surfaces & FX Tuner',
  category: 'VehicleGlobalFx',
  width: 480,
  height: 620,
  resizable: true,
  singleton: true,
};

export const REACHABILITY_TUNER_PRESET: PresetConfig = {
  id: 'reachability-tuner',
  title: 'Reachability & Intercept Tuner',
  category: 'Reachability',
  width: 470,
  height: 600,
  resizable: true,
  singleton: true,
};

export const REPLAY_DIRECTOR_TUNER_PRESET: PresetConfig = {
  id: 'replay-director-tuner',
  title: 'Replay Director Camera & Slow-Mo Tuner',
  category: 'ReplayDirector',
  width: 470,
  height: 600,
  resizable: true,
  singleton: true,
};

export const REPLAY_VIEWER_PRESET: PresetConfig = {
  id: 'replay-viewer-window',
  title: 'RC Replay Viewer',
  category: 'ReplayViewer',
  width: 460,
  height: 520,
  resizable: true,
  singleton: true,
};

export const NAME_TAG_TUNER_PRESET: PresetConfig = {
  id: 'name-tag-tuner',
  title: 'Multiplayer Name Tag Active Tuner',
  category: 'NameTagTuner',
  width: 480,
  height: 620,
  resizable: true,
  singleton: true,
};

export const STATIC_TRAINING_BALL_CAM_TUNER_PRESET: PresetConfig = {
  id: 'static-training-ball-cam-tuner',
  title: 'Training Ball Camera & Opacity Tuner',
  category: 'TrainingBallCam',
  width: 460,
  height: 580,
  resizable: true,
  singleton: true,
};

export const PRESET_WINDOWS: PresetConfig[] = [
  STATIC_TRAINING_BALL_CAM_TUNER_PRESET,
  REPLAY_VIEWER_PRESET,
  NAME_TAG_TUNER_PRESET,
  GOAL_BARRIER_PRESET,
  REWINDER_CONFIGURATOR_PRESET,
  REPLAY_DIRECTOR_TUNER_PRESET,
  REACHABILITY_TUNER_PRESET,
  VEHICLE_GARAGE_TUNER_PRESET,
  VEHICLE_GLOBAL_FX_TUNER_PRESET,
  EXPERIMENTAL_MULTI_BOTS_PRESET,
  EXPERIMENTAL_FEATURES_PRESET,
  DEV_TEST_LAB_PRESET,
  KICKOFF_TRAINING_PRESET,
  DIAGNOSTICS_WINDOW_PRESET,
  EVENT_STREAM_OB_PRESET,
  DETERMINISM_HARNESS_PRESET,
  CAMERA_DETERMINISM_PRESET,
  NETWORK_DIAGNOSTICS_PRESET,
  BOOST_PAD_TUNER_PRESET,
  DRIFTWOODS_TUNER_PRESET,
  OPACITY_MANAGER_PRESET,
  {
    id: 'simd-short',
    title: '1',
    category: 'Kernel',
    width: 320,
    height: 220,
    resizable: false,
    singleton: true,
  },
  {
    id: 'pid-short-resizable',
    title: '1 (Resizable)',
    category: 'Diagnostic',
    width: 360,
    height: 240,
    resizable: true,
    singleton: false,
  },
  {
    id: 'telemetry-long',
    title: 'Diagnostic Telemetry & Real-Time Engine Spectrogram Stream',
    category: 'Hitbox',
    width: 480,
    height: 280,
    resizable: false,
    singleton: true,
  },
  {
    id: 'aero-long-resizable',
    title: 'Advanced Aerodynamic Downforce Vector Matrix Calibration (Resizable)',
    category: 'Diagnostic',
    width: 500,
    height: 320,
    resizable: true,
    singleton: false,
  },
];

export function toggleFloatingPreset(preset: PresetConfig) {
  const existing = floatingStore.getSnapshot().windows.find((w) => w.id === preset.id);
  if (existing) {
    if (existing.isMinimized) {
      floatingStore.restoreWindow(preset.id);
    } else {
      floatingStore.closeWindow(preset.id);
    }
  } else {
    floatingStore.spawnWindow({
      ...preset,
      startMinimized: false
    });
  }
}
