import React from 'react';
import {
  Activity,
  Bot,
  Camera,
  Car,
  Cpu,
  Crosshair,
  Film,
  Palette,
  PencilRuler,
  Router,
  Shield,
  Sliders,
  Sparkles,
  Tag,
  Target,
} from 'lucide-react';
import {
  OPACITY_MANAGER_PRESET,
  BOOST_PAD_TUNER_PRESET,
  DRIFTWOODS_TUNER_PRESET,
  KICKOFF_TRAINING_PRESET,
  GOAL_BARRIER_PRESET,
  REWINDER_CONFIGURATOR_PRESET,
  DEV_TEST_LAB_PRESET,
  EXPERIMENTAL_FEATURES_PRESET,
  EXPERIMENTAL_MULTI_BOTS_PRESET,
  VEHICLE_GARAGE_TUNER_PRESET,
  VEHICLE_GLOBAL_FX_TUNER_PRESET,
  REACHABILITY_TUNER_PRESET,
  REPLAY_DIRECTOR_TUNER_PRESET,
  REPLAY_VIEWER_PRESET,
  NAME_TAG_TUNER_PRESET,
  CAMERA_DETERMINISM_PRESET,
  STATIC_TRAINING_BALL_CAM_TUNER_PRESET,
} from '../../stores/floatingPresets';

export const RotateCcwClockIcon: React.FC<{ className?: string }> = ({ className = 'h-4 w-4 shrink-0' }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    data-lucide="rotate-ccw-clock"
    className={`lucide lucide-rotate-ccw-clock ${className}`}
  >
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </svg>
);

export interface FloatingWindowIconProps {
  category?: string;
  id?: string;
  className?: string;
}

/**
 * Canonical unified icon resolver for floating windows, ghost flights, and minimized stack tray items.
 * Ensures 100% visual consistency between window header, collapsing animation, and minimized tray icon.
 */
export const getFloatingWindowIcon = (category?: string, id?: string, extraClass: string = 'h-4 w-4 shrink-0') => {
  const normId = (id || '').toLowerCase();
  const normCat = (category || '').toLowerCase();

  if (normId === STATIC_TRAINING_BALL_CAM_TUNER_PRESET.id || normCat === 'trainingballcam') {
    return <Camera className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  if (normId === NAME_TAG_TUNER_PRESET.id || normId.includes('name-tag') || normCat === 'nametagtuner') {
    return <Tag className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  if (normId === REPLAY_VIEWER_PRESET.id || normId.includes('replay-viewer') || normCat === 'replayviewer') {
    return <Film className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  if (normId === GOAL_BARRIER_PRESET.id || normId.includes('goal-barrier') || normCat === 'goalbarrier') {
    return <Shield className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  if (normId === REWINDER_CONFIGURATOR_PRESET.id || normId.includes('rewinder') || normCat === 'rewinder') {
    return <RotateCcwClockIcon className={`${extraClass} text-amber-500 dark:text-amber-400`} />;
  }

  if (normId === REPLAY_DIRECTOR_TUNER_PRESET.id || normId.includes('replay-director') || normCat === 'replaydirector') {
    return <Film className={`${extraClass} text-amber-500 dark:text-amber-400`} />;
  }

  if (normId === REACHABILITY_TUNER_PRESET.id || normId.includes('reachability') || normCat === 'reachability') {
    return <Crosshair className={`${extraClass} text-emerald-500 dark:text-emerald-400`} />;
  }

  if (normId === VEHICLE_GLOBAL_FX_TUNER_PRESET.id || normId.includes('vehicle-global') || normCat === 'vehicleglobalfx') {
    return <Car className={`${extraClass} text-emerald-500 dark:text-emerald-400`} />;
  }

  if (normId === VEHICLE_GARAGE_TUNER_PRESET.id || normId.includes('vehicle-garage') || normCat === 'vehicletuner') {
    return <Car className={`${extraClass} text-amber-500 dark:text-amber-400`} />;
  }

  if (normId === EXPERIMENTAL_MULTI_BOTS_PRESET.id || normId.includes('multi-bot') || normCat === 'experimentalbots') {
    return <Bot className={`${extraClass} text-emerald-500 dark:text-emerald-400`} />;
  }

  if (normId === EXPERIMENTAL_FEATURES_PRESET.id || normId.includes('experimental') || normCat === 'experimental') {
    return <Sparkles className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  if (normId === DEV_TEST_LAB_PRESET.id || normId.includes('dev-test-lab') || normCat === 'developerlab') {
    return <Cpu className={`${extraClass} text-amber-500 dark:text-amber-400`} />;
  }

  if (normId === KICKOFF_TRAINING_PRESET.id || normId.includes('kickoff') || normCat === 'training') {
    return <PencilRuler className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  if (normId === OPACITY_MANAGER_PRESET.id || normId.includes('opacity')) {
    return <Sliders className={`${extraClass} text-amber-500 dark:text-amber-400`} />;
  }

  if (normId === BOOST_PAD_TUNER_PRESET.id || normId.includes('boost') || normId.includes('pad')) {
    return <Sparkles className={`${extraClass} text-amber-500 dark:text-amber-400`} />;
  }

  if (normId === DRIFTWOODS_TUNER_PRESET.id || normId.includes('driftwood') || normId.includes('stadium') || normCat === 'graphics') {
    return <Palette className={`${extraClass} text-emerald-500 dark:text-emerald-400`} />;
  }

  if (normCat === 'network' || normId.includes('network')) {
    return <Router className={`${extraClass} text-violet-500 dark:text-violet-400`} />;
  }

  if (normId === CAMERA_DETERMINISM_PRESET.id || normCat === 'cameradeterminism') {
    return <Camera className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  if (normCat === 'determinism' || normId.includes('determinism')) {
    return <Target className={`${extraClass} text-emerald-500 dark:text-emerald-400`} />;
  }

  if (normCat === 'observer' || normId.includes('stream') || normId.includes('oscillo')) {
    return <Activity className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  if (normCat === 'diagnostic' || normId.includes('telemetry')) {
    return <Activity className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  if (normCat === 'kernel' || normId.includes('kernel') || normId.includes('simd')) {
    return <Cpu className={`${extraClass} text-amber-500 dark:text-amber-400`} />;
  }

  if (normCat === 'hitbox' || normId.includes('hitbox')) {
    return <Target className={`${extraClass} text-emerald-500 dark:text-emerald-400`} />;
  }

  if (normId.includes('eq') || normId.includes('dsp') || normId.includes('audio')) {
    return <Sliders className={`${extraClass} text-neutral-800 dark:text-neutral-200`} />;
  }

  return <Activity className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
};

export const FloatingWindowIcon: React.FC<FloatingWindowIconProps> = ({ category, id, className }) => {
  return <>{getFloatingWindowIcon(category, id, className)}</>;
};
