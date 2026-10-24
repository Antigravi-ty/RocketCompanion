import React, { useState } from 'react';
import {
  Sparkles,
  Box,
  Car,
  Crosshair,
  Film,
  PencilRuler,
  Keyboard,
  Disc3,
  Sliders,
  ArrowRight,
  Activity,
  Target,
  Camera,
  Tag,
  Info,
} from 'lucide-react';
import { PanelContainer, PanelHeader, PanelContent, PanelFooter } from '../layout/Panel';
import { VStack } from '../layout/VStack';
import { DEFAULT_PANEL_SIZING } from '../tokens';
import {
  VEHICLE_GARAGE_TUNER_PRESET,
  NAME_TAG_TUNER_PRESET,
  GOAL_VOLUME_TUNER_PRESET,
  REACHABILITY_TUNER_PRESET,
  REPLAY_DIRECTOR_TUNER_PRESET,
  KICKOFF_TRAINING_PRESET,
  EVENT_STREAM_OB_PRESET,
  DETERMINISM_HARNESS_PRESET,
  CAMERA_DETERMINISM_PRESET,
} from '../../stores/floatingPresets';
import {
  audioConfig,
  setCarBallSoundMode,
  setCarCarSoundMode,
} from '../../config/audioConfig.js';
import { useKickoffTrainingStore } from '../../stores/kickoffTrainingStore';
import { FloatingWindowCard } from './settings/components/FloatingWindowCard';
import { SettingSegmentedRow } from './settings/components/SettingSegmentedRow';
import { SettingSliderRow } from './settings/components/SettingSliderRow';
import { BoostAudioVariationTunerCard } from './settings/components/BoostAudioVariationTunerCard';

export interface Layer3DevActiveTunersRecipeProps {
  isLight?: boolean;
  onBack?: () => void;
  onNavigateAdvancedAudio?: () => void;
}

/**
 * [Recipe] Layer 3 Active Tuners, Audio & Diagnostics
 * Hosts all uncalibrated / actively tuned developer tools:
 * - Vehicle Model & Offset Tuner (Per-Vehicle Hitbox & Align, Wheel Hub Anchors & Boost Nozzle Offsets)
 * - Multiplayer Name Tag Active Tuner (6-Car Kickoff Stadium Spawner, Horizontal Pill Dimensions, Typography & Team Colors)
 * - Reachability & Intercept Tuner
 * - Kickoff Training (PPO) & Kickoff Rhythm Overlay Key Stagger
 * - Audio Variant Sound Sets & Advanced Audio Settings (navigates to Layer 4)
 * - Event Stream OB & Dual-Arena Determinism Harness (clean, without Shift+I / Shift+O badges)
 */
export const Layer3DevActiveTunersRecipe: React.FC<Layer3DevActiveTunersRecipeProps> = ({
  isLight = false,
  onBack,
  onNavigateAdvancedAudio,
}) => {
  const [hoveredDesc, setHoveredDesc] = useState<string | null>(null);
  const [carBallMode, setCarBallMode] = React.useState<string>(
    () => String(audioConfig.get('carBallSoundMode') || 'vehicle_body')
  );
  const [carCarMode, setCarCarMode] = React.useState<string>(
    () => String(audioConfig.get('carCarSoundMode') || 'vehicle_detail')
  );
  const wsVerticalOffsetPct = useKickoffTrainingStore((s) => s.wsVerticalOffsetPct);
  const setWsVerticalOffsetPct = useKickoffTrainingStore((s) => s.setWsVerticalOffsetPct);

  React.useEffect(() => {
    const handleSettingsChanged = () => {
      setCarBallMode(String(audioConfig.get('carBallSoundMode') || 'vehicle_body'));
      setCarCarMode(String(audioConfig.get('carCarSoundMode') || 'vehicle_detail'));
    };
    return audioConfig.subscribe(handleSettingsChanged);
  }, []);

  const onCarBallModeChange = (mode: string) => {
    setCarBallMode(mode);
    setCarBallSoundMode(mode);
  };

  const onCarCarModeChange = (mode: string) => {
    setCarCarMode(mode);
    setCarCarSoundMode(mode);
  };

  const ballSoundOptions = [
    { value: 'vehicle_body', label: 'Vehicle Body (Random 1 of 4)' },
    { value: 'vehicle_accent', label: 'Vehicle Accent (Single File)' },
  ];

  const carCarSoundOptions = [
    { value: 'vehicle_detail', label: 'Vehicle Detail (Default)' },
    { value: 'sfx_collision', label: 'SoundFX Collision' },
  ];

  return (
    <PanelContainer
      isLight={isLight}
      sizing={DEFAULT_PANEL_SIZING['layer3-dev-active-tuners']}
      className="w-full"
    >
      <PanelHeader title="ACTIVE TUNERS & DIAGNOSTICS" onBack={onBack} isLight={isLight} />

      <PanelContent scrollable className="p-6">
        <VStack gap="md" isLight={isLight}>
          {/* 1. Vehicle Model & Offset Tuner (Per-Vehicle Spatial Calibration) */}
          <FloatingWindowCard
            preset={VEHICLE_GARAGE_TUNER_PRESET}
            icon={<Car className="h-5 w-5" />}
            iconBgClass="bg-amber-500/10 text-amber-500"
            badge="Per-Model Offsets"
            badgeClass="bg-amber-500/15 border-amber-500/30 text-amber-400"
            description="Hitbox & Align, Per-Vehicle Wheel Hub Anchors & Dual Boost Exhaust Nozzle Offsets"
            hoverTooltip="Vehicle Model & Offset Tuner: Per-vehicle spatial calibration for Fennec & Insidio (Hitbox archetype, Chassis Center Offset, Wheel Hub Anchors & Boost Nozzle Offsets)."
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />

          {/* 2. Multiplayer Name Tag Active Tuner (6-Car Kickoff Arena Evaluation) */}
          <FloatingWindowCard
            preset={NAME_TAG_TUNER_PRESET}
            icon={<Tag className="h-5 w-5" />}
            iconBgClass="bg-sky-500/10 text-sky-500"
            badge="6-Car Kickoff · Pill UI"
            badgeClass="bg-sky-500/15 border-sky-500/30 text-sky-400"
            description="Horizontal pill dimensions, border, font size, truncation, opacity, team colors & 6-car kickoff stadium spawner"
            hoverTooltip="Multiplayer Name Tag Active Tuner: Floating tuner with explicit button to enter the stadium, spawn 6 cars at kickoff slots, reshuffle formations, and evaluate camera-relative horizontal pill name tags."
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />

          {/* 2.25 Goal Volume Hitbox Active Tuner */}
          <FloatingWindowCard
            preset={GOAL_VOLUME_TUNER_PRESET}
            icon={<Box className="h-5 w-5" />}
            iconBgClass="bg-emerald-500/10 text-emerald-500"
            badge="3D AABB · JSON Export"
            badgeClass="bg-emerald-500/15 border-emerald-500/30 text-emerald-400"
            description="Goal Volume Hitbox 3D wireframe overlay (default off), Standard & Throwback AABB calibration & JSON export"
            hoverTooltip="Goal Volume Hitbox Active Tuner: Toggle the 3D Goal Volume & Ball-Center Trigger wireframe overlay (default off), tune Standard & Throwback goal bounds, and export/import JSON."
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />

          {/* 2.5 Reachability & Intercept Tuner */}
          <FloatingWindowCard
            preset={REACHABILITY_TUNER_PRESET}
            icon={<Crosshair className="h-5 w-5" />}
            iconBgClass="bg-emerald-500/10 text-emerald-500"
            badge="LUT · 3D Horn · Cross"
            badgeClass="bg-emerald-500/15 border-emerald-500/30 text-emerald-400"
            description="Ground 1s/2s/3s Isochrone LUT (Boost=0), Boost-Driven 3D Horn & Optimal Intercept 3D Cross"
            hoverTooltip="Reachability & Intercept Tuner: Real-time 1.4µs WASM LUT ground reachability, boost-driven 3D spacetime interception horn, and 3D orthogonal intercept cross."
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />

          {/* 2.75 Replay Director Camera & Slow-Mo Tuner */}
          <FloatingWindowCard
            preset={REPLAY_DIRECTOR_TUNER_PRESET}
            icon={<Film className="h-5 w-5" />}
            iconBgClass="bg-amber-500/10 text-amber-500"
            badge="AutoCam · 2-Touch · Slow-Mo"
            badgeClass="bg-amber-500/15 border-amber-500/30 text-amber-400"
            description="Corridor distances, eye/gaze/striker-switch damping, 2-touch lookahead & 50% slow-mo plateaus"
            hoverTooltip="Replay Director Camera & Slow-Mo Tuner: Live floating tuner for REPLAY_DIRECTOR_CONFIG parameters during Goal Replays."
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />

          {/* 3. Kickoff Training (PPO) Floating Window */}
          <FloatingWindowCard
            preset={KICKOFF_TRAINING_PRESET}
            icon={<PencilRuler className="h-5 w-5" />}
            iconBgClass="bg-sky-500/10 text-sky-500"
            badge="PPO AI"
            badgeClass="bg-sky-500/15 border-sky-500/30 text-sky-400"
            description="Kickoff sub-modes, realistic wait (0.25s steps), N/120 speed & W/S offset"
            hoverTooltip="Kickoff Training Config: Floating tuner for PPO AI kickoff training parameters."
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />

          {/* 4. Kickoff Rhythm Overlay Key Stagger */}
          <div
            className={`w-full p-2.5 rounded-xl border select-none flex flex-col gap-2 ${
              isLight ? 'bg-neutral-50/80 border-neutral-200' : 'bg-neutral-850/80 border-neutral-700/80'
            }`}
          >
            <div className="flex items-center gap-2 px-1 pb-1 border-b border-neutral-700/30">
              <Keyboard className="h-4 w-4 text-sky-500 shrink-0" />
              <div className="flex flex-col text-left leading-tight min-w-0">
                <span className={`text-xs font-semibold ${isLight ? 'text-neutral-800' : 'text-neutral-200'}`}>
                  Kickoff Rhythm Overlay Key Stagger
                </span>
                <span className={`text-[10px] mt-0.5 ${isLight ? 'text-neutral-500' : 'text-neutral-400'}`}>
                  W (upward) & S (downward) vertical container offset (0% – 50%, default 10%)
                </span>
              </div>
            </div>

            <SettingSliderRow
              label="W / S Vertical Offset"
              value={wsVerticalOffsetPct}
              min={0}
              max={50}
              step={1}
              unit="%"
              onChange={(val) => setWsVerticalOffsetPct(val)}
              onHover={() =>
                setHoveredDesc(
                  'Adjusts the vertical stagger of W (upward) and S (downward) key receptors in the Kickoff Training rhythm overlay.'
                )
              }
              onLeave={() => setHoveredDesc(null)}
              isLight={isLight}
            />
          </div>

          {/* 5. Boost Audio Variation Tuner (7 Variations × Start / Loop / End Matrix) */}
          <BoostAudioVariationTunerCard
            isLight={isLight}
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
          />

          {/* 5.5 Audio Variant Sound Sets */}
          <div
            className={`w-full p-2.5 rounded-xl border select-none flex flex-col gap-2 ${
              isLight ? 'bg-neutral-50/80 border-neutral-200' : 'bg-neutral-850/80 border-neutral-700/80'
            }`}
          >
            <div className="flex items-center gap-2 px-1 pb-1 border-b border-neutral-700/30">
              <Disc3 className="h-4 w-4 text-amber-500 shrink-0" />
              <div className="flex flex-col text-left leading-tight min-w-0">
                <span className={`text-xs font-semibold ${isLight ? 'text-neutral-800' : 'text-neutral-200'}`}>
                  Audio Variant Sound Sets
                </span>
                <span className={`text-[10px] mt-0.5 ${isLight ? 'text-neutral-500' : 'text-neutral-400'}`}>
                  Ball Hit & Vehicle Collision Sound Schemes
                </span>
              </div>
            </div>

            <SettingSegmentedRow
              label="Car-Ball Hit Audio"
              subtitle="Vehicle Body (Random 1 of 4) vs Vehicle Accent"
              value={carBallMode}
              onChange={onCarBallModeChange}
              options={ballSoundOptions}
              onHover={() =>
                setHoveredDesc(
                  'Car-Ball impact audio scheme: Vehicle Body (random 01-04) or Vehicle Accent (single asset).'
                )
              }
              onLeave={() => setHoveredDesc(null)}
              isLight={isLight}
            />

            <SettingSegmentedRow
              label="Car-Car Bump Audio"
              subtitle="Vehicle Detail default (Random 1 of 6) vs SoundFX Collision"
              value={carCarMode}
              onChange={onCarCarModeChange}
              options={carCarSoundOptions}
              onHover={() =>
                setHoveredDesc(
                  'Car-Car collision audio scheme: Vehicle Detail (Random 1 of 6, default) or SoundFX Collision.'
                )
              }
              onLeave={() => setHoveredDesc(null)}
              isLight={isLight}
            />
          </div>

          {/* 6. Advanced Audio Settings (Navigates to Layer 4) */}
          <div
            className={`flex items-center justify-between w-full py-2 px-3 rounded-xl border transition-colors select-none ${
              isLight ? 'bg-neutral-50/80 border-neutral-200' : 'bg-neutral-850/80 border-neutral-700/80'
            }`}
            onMouseEnter={() =>
              setHoveredDesc(
                'Open Layer 4 Advanced Audio Settings: Multi-bus audio calibration (0% - 500%), direct numeric inputs, and JSON export.'
              )
            }
            onMouseLeave={() => setHoveredDesc(null)}
          >
            <div className="flex items-center gap-2.5 min-w-0 pr-2">
              <Sliders className="h-4 w-4 text-amber-500 shrink-0" />
              <div className="flex flex-col text-left leading-tight min-w-0">
                <span
                  className={`text-xs font-semibold truncate ${
                    isLight ? 'text-neutral-800' : 'text-neutral-200'
                  }`}
                >
                  Advanced Audio Settings (Layer 4)
                </span>
                <span
                  className={`text-[11px] mt-0.5 truncate ${
                    isLight ? 'text-neutral-500' : 'text-neutral-400'
                  }`}
                >
                  Extended 0% - 500% multi-bus calibration & JSON export
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigateAdvancedAudio?.()}
              className={`py-1 px-3 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 shrink-0 ${
                isLight
                  ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800'
                  : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
              }`}
            >
              <span>Configure</span>
              <ArrowRight className="h-3 w-3 opacity-75" />
            </button>
          </div>

          {/* 7. Event Stream OB (Shift+I removed) */}
          <FloatingWindowCard
            preset={EVENT_STREAM_OB_PRESET}
            icon={<Activity className="h-5 w-5" />}
            iconBgClass="bg-sky-500/10 text-sky-500"
            description="Physics collision observer, impulse curves & threshold visualizer"
            hoverTooltip="Event Stream OB: Real-time collision dynamics observer, impulse curves & audio threshold calibration."
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />

          {/* 8. Dual-Arena Determinism Harness (Shift+O removed) */}
          <FloatingWindowCard
            preset={DETERMINISM_HARNESS_PRESET}
            icon={<Target className="h-5 w-5" />}
            iconBgClass="bg-emerald-500/10 text-emerald-500"
            description="Bit-exact physics rollback verification & desync delta monitoring"
            hoverTooltip="Dual-Arena Determinism Harness: Parallel RocketSim physics verification with live rollback desync checking."
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />

          {/* 9. Camera Deterministic Harness */}
          <FloatingWindowCard
            preset={CAMERA_DETERMINISM_PRESET}
            icon={<Camera className="h-5 w-5" />}
            iconBgClass="bg-sky-500/10 text-sky-500"
            badge="WASM vs Clean JS · 600+600f"
            badgeClass="bg-sky-500/15 border-sky-500/30 text-sky-400"
            description="Live toggle between Legacy WASM & Clean JS camera with 600+600f CSV auto-capture"
            hoverTooltip="Camera Deterministic Harness: Side-by-side comparison between legacy camera.wasm and deobfuscated Clean JS camera, with live source toggle and 600+600 frame CSV export (toPrecision(8))."
            onHover={setHoveredDesc}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />
        </VStack>
      </PanelContent>

      <PanelFooter isLight={isLight}>
        <div className="flex items-center gap-2 w-full text-xs truncate">
          <Info className="h-3.5 w-3.5 text-neutral-400 shrink-0" />
          <span
            className={`truncate transition-colors duration-150 ${
              hoveredDesc
                ? isLight
                  ? 'text-neutral-900'
                  : 'text-neutral-100'
                : isLight
                ? 'text-neutral-400'
                : 'text-neutral-500'
            }`}
          >
            {hoveredDesc ||
              'Active tuners under calibration (Atmosphere, Vehicle, Kickoff, Audio & Diagnostics).'}
          </span>
        </div>
      </PanelFooter>
    </PanelContainer>
  );
};
