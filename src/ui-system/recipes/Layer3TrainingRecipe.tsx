import React, { useState } from 'react';
import { Zap, Box, Shield, Info, Plus, X } from 'lucide-react';
import { PanelContainer, PanelHeader, PanelContent, PanelFooter } from '../layout/Panel';
import { DEFAULT_PANEL_SIZING } from '../tokens';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { SegmentedSwitch } from '../primitives/SegmentedSwitch';
import { VStack } from '../layout/VStack';
import { useAppStore, type GameplayConfig } from '../../stores/appStore';
import { useFloatingStore, floatingStore, type FloatingWindowConfig } from '../../stores/floatingStore';
import { GOAL_BARRIER_PRESET, REWINDER_CONFIGURATOR_PRESET } from '../../stores/floatingPresets';
import { RotateCcwClockIcon } from '../navigation/FloatingWindowIcon';

export interface Layer3TrainingRecipeProps {
  isLight?: boolean;
  onBack?: () => void;
  gameplay?: GameplayConfig;
  onUpdateGameplay?: (patch: Partial<GameplayConfig>) => void;
}

interface CompactToolSpawnerRowProps {
  preset: FloatingWindowConfig;
  icon: React.ReactNode;
  hoverTooltip: string;
  onHover: (desc: string) => void;
  onLeave: () => void;
  isLight?: boolean;
}

const CompactToolSpawnerRow: React.FC<CompactToolSpawnerRowProps> = ({
  preset,
  icon,
  hoverTooltip,
  onHover,
  onLeave,
  isLight = false,
}) => {
  const { windows } = useFloatingStore();
  const existingWindow = windows.find((w) => w.id === preset.id);

  return (
    <div
      onMouseEnter={() => onHover(hoverTooltip)}
      onMouseLeave={onLeave}
      className={`p-3.5 rounded-xl border flex items-center justify-between gap-3 transition-colors select-none ${
        isLight
          ? 'bg-neutral-50/90 hover:bg-neutral-100/80 border-neutral-200'
          : 'bg-neutral-850/90 hover:bg-neutral-800/80 border-neutral-700/80'
      }`}
    >
      <div className="flex items-center gap-2.5 min-w-0 pr-2">
        {icon}
        <span
          className={`text-xs font-semibold truncate ${
            isLight ? 'text-neutral-800' : 'text-neutral-200'
          }`}
        >
          {preset.title}
        </span>
      </div>

      <div className="flex items-center shrink-0">
        {existingWindow ? (
          <button
            type="button"
            onClick={() => floatingStore.closeWindow(preset.id)}
            title={`Close "${preset.title}"`}
            className="h-7 w-7 rounded-lg border flex items-center justify-center cursor-pointer transition-all active:scale-95 outline-none bg-red-500/15 hover:bg-red-500/25 border-red-400/40 text-red-500 shrink-0"
          >
            <X className="h-3.5 w-3.5 stroke-[2.5]" />
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              const containerEl =
                document.getElementById('game-ui-viewport-host') ||
                document.body;
              floatingStore.spawnWithFlight(preset, e.currentTarget, containerEl);
            }}
            title={`Spawn "${preset.title}" into Stack`}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-all active:scale-95 shadow-2xs shrink-0 ${
              isLight
                ? 'bg-neutral-900 hover:bg-neutral-800 text-white border border-neutral-800'
                : 'bg-neutral-100 hover:bg-white text-neutral-950 font-bold border border-neutral-200'
            }`}
          >
            <Plus className="h-3.5 w-3.5 stroke-[2.5]" />
            <span>Spawn</span>
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * [Recipe] Layer 3 Training Configuration Panel (Width: 480px)
 * Streamlined compound panel for practice rules:
 * - Boost Rule: SegmentedSwitch (Unlimited vs Standard)
 * - Show Car Hitbox: ToggleSwitch
 * - Goal Barrier Config: Compact single-line floating window spawner
 * - Rewinder Configurator: Compact single-line floating window spawner
 */
export const Layer3TrainingRecipe: React.FC<Layer3TrainingRecipeProps> = ({
  isLight = false,
  onBack,
  gameplay: propGameplay,
  onUpdateGameplay: propUpdateGameplay,
}) => {
  const storeGameplay = useAppStore((s) => s.gameplay);
  const storeUpdateGameplay = useAppStore((s) => s.updateGameplay);

  const gameplay = propGameplay ?? storeGameplay;
  const updateGameplay = propUpdateGameplay ?? storeUpdateGameplay;

  const [hoveredDesc, setHoveredDesc] = useState<string | null>(null);

  const boostValue = gameplay.unlimitedBoost ? 'unlimited' : 'standard';

  return (
    <PanelContainer isLight={isLight} sizing={DEFAULT_PANEL_SIZING['layer3-training-detail']} className="w-full">
      <PanelHeader
        title="TRAINING CONFIGURATION"
        onBack={onBack}
        isLight={isLight}
      />

      <PanelContent scrollable className="p-4 sm:p-5">
        <VStack gap="md" isLight={isLight}>
          {/* Section 1: Boost Replenishment Rule */}
          <div
            className={`p-3.5 rounded-xl border flex flex-col gap-2.5 transition-colors select-none ${
              isLight ? 'bg-neutral-50/90 border-neutral-200' : 'bg-neutral-850/90 border-neutral-700/80'
            }`}
            onMouseEnter={() =>
              setHoveredDesc('Choose between continuous unlimited boost refill or authentic 100% capacity limitation in practice.')
            }
            onMouseLeave={() => setHoveredDesc(null)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500 shrink-0" />
                <span className={`text-xs font-semibold ${isLight ? 'text-neutral-800' : 'text-neutral-200'}`}>
                  Boost Rule
                </span>
              </div>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-medium ${
                gameplay.unlimitedBoost
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : isLight
                  ? 'bg-neutral-200 text-neutral-700'
                  : 'bg-neutral-800 text-neutral-300'
              }`}>
                {gameplay.unlimitedBoost ? 'UNLIMITED' : 'STANDARD'}
              </span>
            </div>

            <p className={`text-[11px] leading-relaxed ${isLight ? 'text-neutral-500' : 'text-neutral-400'}`}>
              Select whether boost remains permanently full or follows standard consumption and canister pickup mechanics.
            </p>

            <div className="pt-0.5">
              <SegmentedSwitch
                value={boostValue}
                fullWidth
                isLight={isLight}
                onValueChange={(val) => updateGameplay({ unlimitedBoost: val === 'unlimited' })}
                options={[
                  { value: 'unlimited', label: 'Unlimited' },
                  { value: 'standard', label: 'Standard (100%)' },
                ]}
              />
            </div>
          </div>

          {/* Section 2: Show Car Hitbox Wireframe */}
          <div
            className={`p-3.5 rounded-xl border flex items-center justify-between transition-colors cursor-pointer select-none ${
              isLight ? 'bg-neutral-50/90 border-neutral-200 hover:bg-neutral-100/80' : 'bg-neutral-850/90 border-neutral-700/80 hover:bg-neutral-800/80'
            }`}
            onClick={() => updateGameplay({ showCarHitbox: !gameplay.showCarHitbox })}
            onMouseEnter={() =>
              setHoveredDesc('Draws accurate 3D oriented bounding box (OBB) wireframe around the vehicle.')
            }
            onMouseLeave={() => setHoveredDesc(null)}
          >
            <div className="flex items-center gap-2.5 min-w-0 pr-2">
              <Box className="h-4 w-4 text-emerald-500 shrink-0" />
              <div className="flex flex-col text-left leading-tight min-w-0">
                <span className={`text-xs font-semibold truncate ${
                  isLight ? 'text-neutral-800' : 'text-neutral-200'
                }`}>
                  Show Car Hitbox
                </span>
                <span className={`text-[11px] mt-0.5 truncate ${
                  isLight ? 'text-neutral-500' : 'text-neutral-400'
                }`}>
                  Draws vehicle 3D collision wireframe in real time
                </span>
              </div>
            </div>

            <ToggleSwitch
              checked={Boolean(gameplay.showCarHitbox)}
              onCheckedChange={(checked) => updateGameplay({ showCarHitbox: checked })}
              isLight={isLight}
              variant="neutral"
            />
          </div>

          {/* Section 2.5: Disable Goal Reset */}
          <div
            className={`p-3.5 rounded-xl border flex items-center justify-between transition-colors cursor-pointer select-none ${
              isLight ? 'bg-neutral-50/90 border-neutral-200 hover:bg-neutral-100/80' : 'bg-neutral-850/90 border-neutral-700/80 hover:bg-neutral-800/80'
            }`}
            onClick={() => updateGameplay({ goalRestart: Boolean(!gameplay.goalRestart) })}
            onMouseEnter={() =>
              setHoveredDesc('When enabled, scoring a goal will not trigger goal replay or reset the ball to kickoff, allowing continuous practice inside and around the goal.')
            }
            onMouseLeave={() => setHoveredDesc(null)}
          >
            <div className="flex items-center gap-2.5 min-w-0 pr-2">
              <RotateCcwClockIcon className="h-4 w-4 text-rose-400 shrink-0" />
              <div className="flex flex-col text-left leading-tight min-w-0">
                <span className={`text-xs font-semibold truncate ${
                  isLight ? 'text-neutral-800' : 'text-neutral-200'
                }`}>
                  Disable Goal Reset
                </span>
                <span className={`text-[11px] mt-0.5 truncate ${
                  isLight ? 'text-neutral-500' : 'text-neutral-400'
                }`}>
                  Keep playing without goal replay or kickoff reset when ball enters the net
                </span>
              </div>
            </div>

            <ToggleSwitch
              checked={!gameplay.goalRestart}
              onCheckedChange={(disableReset) => updateGameplay({ goalRestart: !disableReset })}
              isLight={isLight}
              variant="neutral"
            />
          </div>

          {/* Section 3: Goal Barrier Config Floating Window */}
          <CompactToolSpawnerRow
            preset={GOAL_BARRIER_PRESET}
            icon={<Shield className="h-4 w-4 text-sky-500 shrink-0" />}
            hoverTooltip="Spawn the Goal Barrier Config floating window to draw custom rectangular barrier regions with boolean union/subtraction and native RocketSim collision."
            onHover={(desc) => setHoveredDesc(desc)}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />

          {/* Section 4: Rewinder Configurator Floating Window */}
          <CompactToolSpawnerRow
            preset={REWINDER_CONFIGURATOR_PRESET}
            icon={<RotateCcwClockIcon className="h-4 w-4 text-amber-500 shrink-0" />}
            hoverTooltip="Spawn the Rewinder Configurator floating window to record, scrub, rewind, and resume free play state history with hotkeys (O / P / [ / ] / G)."
            onHover={(desc) => setHoveredDesc(desc)}
            onLeave={() => setHoveredDesc(null)}
            isLight={isLight}
          />
        </VStack>
      </PanelContent>

      <PanelFooter isLight={isLight}>
        <div className="flex items-center gap-2 w-full text-xs truncate">
          <Info className="h-3.5 w-3.5 text-neutral-400 shrink-0" />
          <span className={`truncate transition-colors duration-150 ${
            hoveredDesc
              ? (isLight ? 'text-neutral-900' : 'text-neutral-100')
              : (isLight ? 'text-neutral-400' : 'text-neutral-500')
          }`}>
            {hoveredDesc || 'Configure free play boost rules, goal barrier, rewinder, and visual collision box overlay.'}
          </span>
        </div>
      </PanelFooter>
    </PanelContainer>
  );
};
