import React, { useState } from 'react';
import {
  AlertTriangle,
  Play,
  RotateCcw,
  Layers,
  Compass,
  Info,
  Eye,
} from 'lucide-react';
import { PanelContainer, PanelHeader, PanelContent, PanelFooter } from '../layout/Panel';
import { VStack } from '../layout/VStack';
import { DEFAULT_PANEL_SIZING } from '../tokens';
import { SegmentedSwitch } from '../primitives/SegmentedSwitch';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { useAppStore } from '../../stores/appStore';

export interface Layer3DevUnderDevelopmentRecipeProps {
  isLight?: boolean;
  onBack?: () => void;
}

/**
 * [Recipe] Layer 3 Developer — 4. Under Development (Unstable / WIP Workspace)
 * Houses uncalibrated, experimental features ported from TricycleCoreWASM & Throwback assets:
 * 1. Three-Wheeler Mode (Tricycle / Psyclops 3-wheel Bullet raycast vehicle)
 * 2. Throwback Stadium (36 .cmf collision meshes, 3D GoalVolume box, ThrowbackHockey_Field.glb & ThrowbackStadium_Collision.glb)
 */
export const Layer3DevUnderDevelopmentRecipe: React.FC<Layer3DevUnderDevelopmentRecipeProps> = ({
  isLight = false,
  onBack,
}) => {
  const [hoveredDesc, setHoveredDesc] = useState<string | null>(null);
  const [isApplyingArena, setIsApplyingArena] = useState<boolean>(false);

  const underDev = useAppStore((s) => s.underDevelopment);
  const updateUnderDev = useAppStore((s) => s.updateUnderDevelopment);
  const closeMenu = useAppStore((s) => s.closeMenu);

  const threeWheelsEnabled = Boolean(underDev?.threeWheelsEnabled);
  const stadiumPreset = underDev?.stadiumPreset || 'standard';
  const showCollisionOverlay = Boolean(underDev?.showThrowbackCollisionOverlay);

  const handleToggleThreeWheels = (enabled: boolean) => {
    updateUnderDev({ threeWheelsEnabled: enabled });
  };

  const handleStadiumSwitch = async (nextPreset: string) => {
    if (nextPreset !== 'standard' && nextPreset !== 'throwback') return;
    setIsApplyingArena(true);
    try {
      await updateUnderDev({ stadiumPreset: nextPreset as 'standard' | 'throwback' });
    } finally {
      setIsApplyingArena(false);
    }
  };

  const handleToggleCollisionOverlay = (visible: boolean) => {
    updateUnderDev({ showThrowbackCollisionOverlay: visible });
  };

  return (
    <PanelContainer
      isLight={isLight}
      sizing={DEFAULT_PANEL_SIZING['layer3-dev-under-development']}
      className="w-full"
    >
      <PanelHeader title="4. UNDER DEVELOPMENT (UNSTABLE)" onBack={onBack} isLight={isLight} />

      <PanelContent scrollable className="p-6">
        <VStack gap="md" isLight={isLight}>
          {/* Unstable / In-Development Warning Banner */}
          <div
            className={`flex items-start gap-3 w-full p-3.5 rounded-xl border select-none ${
              isLight
                ? 'bg-rose-500/10 border-rose-500/30 text-rose-950'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
            }`}
            onMouseEnter={() =>
              setHoveredDesc(
                'Purely in-development staging area: Features here are intentionally uncalibrated and unstable until core main-branch workflows are finalized.'
              )
            }
            onMouseLeave={() => setHoveredDesc(null)}
          >
            <AlertTriangle className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex flex-col text-left leading-snug min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-rose-400">
                  Unstable Staging Area · Purely In Development
                </span>
              </div>
              <span className={`text-[11px] mt-1 ${isLight ? 'text-neutral-700' : 'text-neutral-300'}`}>
                This workspace holds raw asset and WASM bridge integrations (Three-Wheeler Tricycle mode and Throwback Stadium) for quick inspection only. Scene calibration and edge-case fixes are deferred until main-branch stabilization completes.
              </span>
            </div>
          </div>

          {/* Section 1: Three-Wheeler Mode (Tricycle / Psyclops) */}
          <div
            className={`flex flex-col gap-3 w-full p-4 rounded-xl border transition-colors select-none ${
              isLight
                ? 'bg-neutral-50 border-neutral-200 text-neutral-900'
                : 'bg-neutral-900/70 border-neutral-800 text-neutral-100'
            }`}
            onMouseEnter={() =>
              setHoveredDesc(
                'Three-Wheeler (Tricycle / Psyclops): Collapses the two front wheels into a single center-mounted steerable wheel (Y=0) in Bullet btVehicleRL with modified steering and handbrake curves.'
              )
            }
            onMouseLeave={() => setHoveredDesc(null)}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 bg-purple-500/20 text-purple-400">
                  <Compass className="h-5 w-5" />
                </div>
                <div className="flex flex-col text-left leading-tight min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold truncate">Three-Wheeler Mode (Tricycle / Psyclops)</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider font-semibold bg-purple-500/20 border-purple-500/40 text-purple-400">
                      {threeWheelsEnabled ? '3 Wheels Active' : '4 Wheels Standard'}
                    </span>
                  </div>
                  <span className={`text-xs mt-0.5 ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>
                    WASM Bridge: _physics_setCarThreeWheels · Single center front wheel + 2 rear wheels
                  </span>
                </div>
              </div>

              <ToggleSwitch
                checked={threeWheelsEnabled}
                onCheckedChange={handleToggleThreeWheels}
                isLight={isLight}
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-neutral-500/15 text-[11px]">
              <span className={isLight ? 'text-neutral-500' : 'text-neutral-400'}>
                Front Axle: [51.25, 0.0, 12.5] · Rear Axle: [-33.75, ±29.50, 15.0]
              </span>
              <button
                type="button"
                onClick={() => {
                  if (!threeWheelsEnabled) {
                    handleToggleThreeWheels(true);
                  }
                  closeMenu();
                }}
                className={`py-1 px-2.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 active:scale-95 ${
                  isLight
                    ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-800 text-white'
                    : 'bg-purple-500/20 hover:bg-purple-500/30 border-purple-500/40 text-purple-300'
                }`}
              >
                <Play className="h-3 w-3 fill-current" />
                <span>Enable & Drive</span>
              </button>
            </div>
          </div>

          {/* Section 2: Throwback Stadium (36 CMF Collision Meshes + Field & Collision GLBs) */}
          <div
            className={`flex flex-col gap-3 w-full p-4 rounded-xl border transition-colors select-none ${
              isLight
                ? 'bg-neutral-50 border-neutral-200 text-neutral-900'
                : 'bg-neutral-900/70 border-neutral-800 text-neutral-100'
            }`}
            onMouseEnter={() =>
              setHoveredDesc(
                'Throwback Stadium: Loads 36 .cmf collision meshes, ThrowbackHockey_Field.glb visual arena, 3D GoalVolume box (Y: 4922..5460) with open back-pass space, and Throwback boost pad layout.'
              )
            }
            onMouseLeave={() => setHoveredDesc(null)}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 bg-rose-500/20 text-rose-400">
                  <Layers className="h-5 w-5" />
                </div>
                <div className="flex flex-col text-left leading-tight min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold truncate">Throwback Stadium Arena & Collision</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider font-semibold bg-rose-500/20 border-rose-500/40 text-rose-400">
                      {stadiumPreset === 'throwback' ? 'Throwback (36 CMF)' : 'Standard (16 CMF)'}
                    </span>
                  </div>
                  <span className={`text-xs mt-0.5 ${isLight ? 'text-neutral-600' : 'text-neutral-400'}`}>
                    ThrowbackHockey_Field.glb · ThrowbackStadium_Collision.glb · 3D GoalVolume AABB
                  </span>
                </div>
              </div>

              <div className="w-52 shrink-0">
                <SegmentedSwitch
                  value={stadiumPreset}
                  onValueChange={handleStadiumSwitch}
                  options={[
                    { value: 'standard', label: 'Standard' },
                    { value: 'throwback', label: isApplyingArena ? 'Loading...' : 'Throwback' },
                  ]}
                  size="sm"
                  fullWidth
                  isLight={isLight}
                />
              </div>
            </div>

            {/* Collision GLB Wireframe Overlay Toggle */}
            <div className="flex items-center justify-between pt-2 border-t border-neutral-500/15">
              <div className="flex items-center gap-2">
                <Eye className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                <span className={`text-xs font-medium ${isLight ? 'text-neutral-700' : 'text-neutral-300'}`}>
                  Show ThrowbackStadium_Collision.glb Wireframe Overlay
                </span>
              </div>
              <ToggleSwitch
                checked={showCollisionOverlay}
                onCheckedChange={handleToggleCollisionOverlay}
                isLight={isLight}
              />
            </div>

            {/* Quick Inspect / Reset Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-neutral-500/15 text-[11px]">
              <span className={isLight ? 'text-neutral-500' : 'text-neutral-400'}>
                Bounds: 4096 × 6910 × 2044 UU · Goal Volume Y: [4922, 5460] · 34 Pads
              </span>
              <div className="flex items-center gap-2">
                {stadiumPreset === 'throwback' && (
                  <button
                    type="button"
                    onClick={() => handleStadiumSwitch('standard')}
                    className={`py-1 px-2.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1 active:scale-95 ${
                      isLight
                        ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800'
                        : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
                    }`}
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Restore Standard</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    if (stadiumPreset !== 'throwback') {
                      await handleStadiumSwitch('throwback');
                    }
                    closeMenu();
                  }}
                  className={`py-1 px-2.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 active:scale-95 ${
                    isLight
                      ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-800 text-white'
                      : 'bg-rose-500/20 hover:bg-rose-500/30 border-rose-500/40 text-rose-300'
                  }`}
                >
                  <Play className="h-3 w-3 fill-current" />
                  <span>Load & Inspect</span>
                </button>
              </div>
            </div>
          </div>
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
              'Unstable / Under Development workspace for Three-Wheeler mode and Throwback Stadium inspection.'}
          </span>
        </div>
      </PanelFooter>
    </PanelContainer>
  );
};
