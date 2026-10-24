import React, { useState, useEffect } from 'react';
import {
  Sliders,
  Zap,
  Palette,
  ArrowRight,
  Cpu,
  Play,
  CircleDot,
  AlertTriangle,
} from 'lucide-react';
import { VStack } from '../../../layout/VStack';
import { SegmentedSwitch } from '../../../primitives/SegmentedSwitch';
import { useAppStore } from '../../../../stores/appStore';
import {
  getBallVisualConfig,
  updateBallVisualConfig,
  subscribeBallVisualConfig,
} from '../../../../config/ballVisualConfig.js';

export interface DeveloperTabProps {
  isLight?: boolean;
  onNavigateAdvancedAudio?: () => void;
  onNavigateEventAndTriggerer?: () => void;
  onNavigateExpMultiBots?: () => void;
  onNavigateDevSandboxes?: () => void;
  onNavigateDevActiveTuners?: () => void;
  onNavigateDevCalibratedPresets?: () => void;
  onNavigateDevUnderDevelopment?: () => void;
  onHover: (desc: string) => void;
  onLeave: () => void;
}

/**
 * [Layer 2] Developer Settings Tab
 * Streamlined into 4 structured Layer-3 sub-menu categories:
 * 1. Sandboxes & Isolation Labs (Subsystem Isolation & MVP Lab + Experimental Multiple Bots Mode)
 * 2. Active Tuners, Audio & Diagnostics (Vehicle Model & Offset Tuner, Reachability, Kickoff, Audio -> Layer 4, Event Stream OB, Determinism)
 * 3. Calibrated Presets (Atmosphere & FX, Vehicle Global Surfaces & FX, Driftwoods Stadium Tuner & Boost Pad Visual Tuner)
 * 4. Under Development (Unstable / WIP workspace: Three-Wheeler Tricycle mode & Throwback Stadium)
 * Plus Developer Quick Actions (Ball Opacity: 70% / 100% / Custom) and direct Layer-2 access to Event and Triggerer.
 */
export const DeveloperTab: React.FC<DeveloperTabProps> = ({
  isLight = false,
  onNavigateEventAndTriggerer,
  onNavigateDevSandboxes,
  onNavigateDevActiveTuners,
  onNavigateDevCalibratedPresets,
  onNavigateDevUnderDevelopment,
  onHover,
  onLeave,
}) => {
  const [ballOpacity, setBallOpacity] = useState<number>(() => {
    const cfg = getBallVisualConfig();
    return typeof cfg.opacity === 'number' ? cfg.opacity : 1.0;
  });

  useEffect(() => {
    return subscribeBallVisualConfig((next: any) => {
      if (typeof next?.opacity === 'number') {
        setBallOpacity(next.opacity);
      }
    });
  }, []);

  const ballOpacityMode: '70' | '100' | 'custom' =
    Math.abs(ballOpacity - 0.7) < 0.005
      ? '70'
      : Math.abs(ballOpacity - 1.0) < 0.005
      ? '100'
      : 'custom';

  const handleBallOpacitySwitch = (mode: string) => {
    if (mode === '70') {
      const next = updateBallVisualConfig({ opacity: 0.7 });
      setBallOpacity(next.opacity);
      useAppStore.getState().bridge.onBallVisualConfigChange?.(next);
    } else if (mode === '100') {
      const next = updateBallVisualConfig({ opacity: 1.0 });
      setBallOpacity(next.opacity);
      useAppStore.getState().bridge.onBallVisualConfigChange?.(next);
    }
  };

  const nav = (route: any, cb?: () => void) => {
    if (cb) {
      cb();
    } else {
      useAppStore.getState().navigate(route);
    }
  };

  return (
    <VStack gap="md" isLight={isLight}>
      {/* Group 1: Sandboxes & Isolation Labs (Layer 3 Configure + Quick Enter Lab) */}
      <div
        className={`flex items-center justify-between w-full p-3 rounded-xl border transition-colors select-none ${
          isLight
            ? 'bg-amber-500/10 border-amber-500/30 text-neutral-900'
            : 'bg-amber-500/10 border-amber-500/30 text-neutral-100'
        }`}
        onMouseEnter={() =>
          onHover(
            'Open Layer 3 Sandboxes & Isolation Labs: Enter Subsystem Isolation & MVP Lab, spawn its 70% controller, or configure Experimental Multiple Bots Mode.'
          )
        }
        onMouseLeave={onLeave}
      >
        <div className="flex items-start gap-3 min-w-0 pr-2">
          <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 bg-amber-500/20 text-amber-400">
            <Cpu className="h-5 w-5" />
          </div>
          <div className="flex flex-col text-left leading-tight min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold truncate">1. Sandboxes & Isolation Labs</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider font-semibold bg-amber-500/20 border-amber-500/40 text-amber-400">
                MVP & Multi-Bots
              </span>
            </div>
            <span className={`text-[11px] mt-0.5 truncate ${isLight ? 'text-neutral-600' : 'text-neutral-300'}`}>
              Subsystem Isolation & MVP Lab · Experimental Multiple Bots Mode (3v3)
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => nav('dev-subsystem-isolation')}
            className={`py-1.5 px-2.5 rounded-lg text-xs font-bold border transition-all cursor-pointer flex items-center gap-1 active:scale-95 ${
              isLight
                ? 'bg-amber-500 hover:bg-amber-600 border-amber-600 text-white'
                : 'bg-amber-400 hover:bg-amber-300 border-amber-300 text-neutral-950'
            }`}
            title="Select which of the 6 isolated subsystems to test"
          >
            <Play className="h-3 w-3 fill-current" />
            <span>Enter Lab</span>
          </button>
          <button
            type="button"
            onClick={() => nav('dev-sandboxes', onNavigateDevSandboxes)}
            className={`py-1.5 px-3 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 active:scale-95 ${
              isLight
                ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-800 text-white'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
            }`}
          >
            <span>Configure</span>
            <ArrowRight className="h-3.5 w-3.5 opacity-75" />
          </button>
        </div>
      </div>

      {/* Group 2: Active Tuners, Audio & Diagnostics */}
      <div
        className={`flex items-center justify-between w-full p-3 rounded-xl border transition-colors select-none ${
          isLight
            ? 'bg-sky-500/10 border-sky-500/30 text-neutral-900'
            : 'bg-sky-500/10 border-sky-500/30 text-neutral-100'
        }`}
        onMouseEnter={() =>
          onHover(
            'Open Layer 3 Active Tuners & Diagnostics: Multiplayer Name Tag Active Tuner, Vehicle Model & Offset Tuner, Reachability & Intercept Tuner, Kickoff Training (PPO), Audio Settings (Layer 4), Event Stream OB & Determinism Harness.'
          )
        }
        onMouseLeave={onLeave}
      >
        <div className="flex items-start gap-3 min-w-0 pr-2">
          <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 bg-sky-500/20 text-sky-400">
            <Sliders className="h-5 w-5" />
          </div>
          <div className="flex flex-col text-left leading-tight min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold truncate">2. Active Tuners, Audio & Diagnostics</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider font-semibold bg-sky-500/20 border-sky-500/40 text-sky-400">
                In Calibration
              </span>
            </div>
            <span className={`text-[11px] mt-0.5 truncate ${isLight ? 'text-neutral-600' : 'text-neutral-300'}`}>
              Multiplayer Name Tag · Vehicle Offsets · Reachability · Kickoff PPO · Audio (L4)
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => nav('dev-active-tuners', onNavigateDevActiveTuners)}
          className={`py-1.5 px-3 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 shrink-0 active:scale-95 ${
            isLight
              ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-800 text-white'
              : 'bg-sky-400 hover:bg-sky-300 border-sky-300 text-neutral-950 font-bold'
          }`}
        >
          <span>Configure</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Group 3: Calibrated Presets */}
      <div
        className={`flex items-center justify-between w-full p-3 rounded-xl border transition-colors select-none ${
          isLight
            ? 'bg-emerald-500/10 border-emerald-500/30 text-neutral-900'
            : 'bg-emerald-500/10 border-emerald-500/30 text-neutral-100'
        }`}
        onMouseEnter={() =>
          onHover(
            'Open Layer 3 Calibrated Presets: Atmosphere & FX Tuner, Vehicle Global Surfaces & FX Tuner, Driftwoods Stadium Tuner & Boost Pad Visual Tuner.'
          )
        }
        onMouseLeave={onLeave}
      >
        <div className="flex items-start gap-3 min-w-0 pr-2">
          <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 bg-emerald-500/20 text-emerald-400">
            <Palette className="h-5 w-5" />
          </div>
          <div className="flex flex-col text-left leading-tight min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold truncate">3. Calibrated Presets</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider font-semibold bg-emerald-500/20 border-emerald-500/40 text-emerald-400">
                4 Presets
              </span>
            </div>
            <span className={`text-[11px] mt-0.5 truncate ${isLight ? 'text-neutral-600' : 'text-neutral-300'}`}>
              Atmosphere & FX · Vehicle Global Surfaces & FX · Driftwoods Stadium · Boost Pad
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => nav('dev-calibrated-presets', onNavigateDevCalibratedPresets)}
          className={`py-1.5 px-3 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 shrink-0 active:scale-95 ${
            isLight
              ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800'
              : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
          }`}
        >
          <span>Configure</span>
          <ArrowRight className="h-3.5 w-3.5 opacity-75" />
        </button>
      </div>

      {/* Group 4: Under Development (Unstable / WIP) */}
      <div
        className={`flex items-center justify-between w-full p-3 rounded-xl border transition-colors select-none ${
          isLight
            ? 'bg-rose-500/10 border-rose-500/30 text-neutral-900'
            : 'bg-rose-500/10 border-rose-500/30 text-neutral-100'
        }`}
        onMouseEnter={() =>
          onHover(
            'Open Layer 3 Under Development (Unstable / WIP): Purely in-development staging area for Three-Wheeler (Tricycle / Psyclops) physics and Throwback Stadium (.cmf & .glb assets).'
          )
        }
        onMouseLeave={onLeave}
      >
        <div className="flex items-start gap-3 min-w-0 pr-2">
          <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 bg-rose-500/20 text-rose-400">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="flex flex-col text-left leading-tight min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold truncate">4. Under Development</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider font-semibold bg-rose-500/20 border-rose-500/40 text-rose-400">
                Unstable · In Dev
              </span>
            </div>
            <span className={`text-[11px] mt-0.5 truncate ${isLight ? 'text-neutral-600' : 'text-neutral-300'}`}>
              Three-Wheeler (Tricycle / Psyclops) · Throwback Stadium (36 CMF & GLB)
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => nav('dev-under-development', onNavigateDevUnderDevelopment)}
          className={`py-1.5 px-3 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 shrink-0 active:scale-95 ${
            isLight
              ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800'
              : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
          }`}
        >
          <span>Inspect</span>
          <ArrowRight className="h-3.5 w-3.5 opacity-75" />
        </button>
      </div>

      {/* Developer Quick Actions */}
      <div
        className={`flex flex-col gap-2 w-full py-2.5 px-3.5 rounded-xl border transition-colors select-none ${
          isLight ? 'bg-neutral-50/80 border-neutral-200' : 'bg-neutral-850/80 border-neutral-700/80'
        }`}
        onMouseEnter={() =>
          onHover(
            'Developer Quick Actions: Quickly toggle Ball Opacity between 70% and 100% default (automatically indicates Custom when opacity differs from 0.7 and 1.0).'
          )
        }
        onMouseLeave={onLeave}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <CircleDot className="h-4 w-4 text-sky-400 shrink-0" />
            <div className="flex flex-col text-left leading-tight min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className={`text-xs font-semibold truncate ${
                    isLight ? 'text-neutral-800' : 'text-neutral-200'
                  }`}
                >
                  Ball Opacity
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider font-semibold bg-sky-500/15 border-sky-500/30 text-sky-400">
                  Developer Quick Actions
                </span>
              </div>
              <span
                className={`text-[11px] mt-0.5 truncate ${
                  isLight ? 'text-neutral-500' : 'text-neutral-400'
                }`}
              >
                70% translucent · 100% opaque (default) · Custom ({Math.round(ballOpacity * 100)}%)
              </span>
            </div>
          </div>

          <div className="w-48 shrink-0">
            <SegmentedSwitch
              value={ballOpacityMode}
              onValueChange={handleBallOpacitySwitch}
              options={[
                { value: '70', label: '70%' },
                { value: '100', label: '100%' },
                { value: 'custom', label: 'Custom' },
              ]}
              size="sm"
              fullWidth
              isLight={isLight}
            />
          </div>
        </div>
      </div>

      {/* High-Frequency Direct Entry on Layer 2: Event and Triggerer */}
      <div
        className={`flex items-center justify-between w-full py-2.5 px-3.5 rounded-xl border transition-colors select-none ${
          isLight ? 'bg-neutral-50/80 border-neutral-200' : 'bg-neutral-850/80 border-neutral-700/80'
        }`}
        onMouseEnter={() =>
          onHover('High-frequency tool: Calibrate physical collision debounce timers, impulse thresholds, and console stream filters.')
        }
        onMouseLeave={onLeave}
      >
        <div className="flex items-center gap-2.5 min-w-0 pr-2">
          <Zap className="h-4 w-4 text-amber-500 shrink-0" />
          <div className="flex flex-col text-left leading-tight min-w-0">
            <span
              className={`text-xs font-semibold truncate ${
                isLight ? 'text-neutral-800' : 'text-neutral-200'
              }`}
            >
              Event and Triggerer (Direct Layer-3 Access)
            </span>
            <span
              className={`text-[11px] mt-0.5 truncate ${
                isLight ? 'text-neutral-500' : 'text-neutral-400'
              }`}
            >
              Audio debounce windows, impulse thresholds & console filters
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => nav('event-and-triggerer', onNavigateEventAndTriggerer)}
          className={`py-1.5 px-3 rounded-lg text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 shrink-0 ${
            isLight
              ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800'
              : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
          }`}
        >
          <span>Configure</span>
          <ArrowRight className="h-3.5 w-3.5 opacity-75" />
        </button>
      </div>
    </VStack>
  );
};
