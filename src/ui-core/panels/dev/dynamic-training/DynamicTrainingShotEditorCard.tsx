import React from 'react';
import { Play, RotateCcw, Square } from 'lucide-react';
import type {
  DynamicCarTakeoverMode,
  DynamicTrainingPackRecord,
  DynamicTrainingShotRef,
  DynamicTrainingShotStats,
  DynamicTrainingStateSessionSummary,
} from '../../../config/dynamicTrainingPackTypes';
import { DropdownMenu } from '../../../compounds/DropdownMenu';
import { SegmentedSwitch } from '../../../primitives/SegmentedSwitch';
import { Checkbox } from '../../../primitives/Checkbox';

export interface DynamicTrainingShotEditorCardProps {
  isLight: boolean;
  pack: DynamicTrainingPackRecord;
  shot: DynamicTrainingShotRef;
  sessionSummary: DynamicTrainingStateSessionSummary | null;
  stats: DynamicTrainingShotStats | undefined;
  playPhase: 'idle' | 'preroll-countdown' | 'intervening' | 'result';
  countdownRemainingSec: number;
  remainingTimeoutSec: number;
  lastResult: 'goal' | 'timeout' | null;
  onUpdateShot: (patch: Partial<DynamicTrainingShotRef>) => void;
  onUpdatePerCar: (slotIndex: number, mode: DynamicCarTakeoverMode, modelId?: string) => void;
  onPlayShot: () => void;
  onRestartShot: () => void;
  onStopSession: () => void;
}

const TAKEOVER_MODES: Array<{ value: DynamicCarTakeoverMode; label: string }> = [
  { value: 'player', label: 'Player' },
  { value: 'as-previous', label: 'As Previous' },
  { value: 'disappear', label: 'Disappear' },
  { value: 'model', label: 'AI Model' },
  { value: 'no-input', label: 'No Input' },
];

const MODEL_IDS = ['nexto', 'necto', 'kickoff-ppo', 'speedflip'];

export const DynamicTrainingShotEditorCard: React.FC<DynamicTrainingShotEditorCardProps> =
  React.memo(
    ({
      isLight,
      shot,
      sessionSummary,
      stats,
      playPhase,
      countdownRemainingSec,
      remainingTimeoutSec,
      lastResult,
      onUpdateShot,
      onUpdatePerCar,
      onPlayShot,
      onRestartShot,
      onStopSession,
    }) => {
      const cardCls = isLight
        ? 'bg-neutral-50 border-neutral-200 text-neutral-900'
        : 'bg-neutral-900/70 border-neutral-800 text-neutral-100';
      const inputCls = isLight
        ? 'bg-white border-neutral-300 text-neutral-900'
        : 'bg-neutral-950 border-neutral-700 text-neutral-100';
      const mutedCls = isLight ? 'text-neutral-500' : 'text-neutral-400';

      const slotKeys = Object.keys(shot.perCarTakeover)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);

      return (
        <div className={`rounded-lg border p-2.5 flex flex-col gap-2 ${cardCls}`}>
          <div className="flex items-center justify-between gap-2">
            <input
              type="text"
              value={shot.name}
              onChange={(e) => onUpdateShot({ name: e.target.value })}
              className={`flex-1 min-w-0 px-2 py-1 rounded border text-xs font-semibold ${inputCls}`}
              placeholder="Shot name"
            />
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onPlayShot}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold cursor-pointer"
              >
                <Play className="h-3 w-3" />
                Play
              </button>
              <button
                type="button"
                onClick={onRestartShot}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-semibold cursor-pointer"
                title="Restart Shot"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={onStopSession}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-neutral-600 hover:bg-neutral-500 text-white text-[11px] font-semibold cursor-pointer"
                title="Stop"
              >
                <Square className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className={`flex flex-wrap items-center gap-3 text-[11px] ${mutedCls}`}>
            <span>
              Session: {sessionSummary ? `${sessionSummary.durationSeconds}s (${sessionSummary.frameCount}f)` : shot.sessionId.slice(0, 8)}
            </span>
            <span>Attempts: {stats?.attempts ?? 0}</span>
            <span>Goals: {stats?.goals ?? 0}</span>
            <span>Timeouts: {stats?.timeouts ?? 0}</span>
            {playPhase !== 'idle' && (
              <span className="font-semibold text-amber-400">
                {playPhase === 'preroll-countdown'
                  ? `Countdown: ${countdownRemainingSec}s`
                  : playPhase === 'intervening'
                    ? `Active: ${remainingTimeoutSec.toFixed(1)}s`
                    : `Result: ${lastResult ?? 'done'}`}
              </span>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <label className="flex flex-col gap-0.5">
              <span className={mutedCls}>Timeout (s)</span>
              <input
                type="number"
                min={1}
                max={60}
                value={shot.timeoutSeconds}
                onChange={(e) =>
                  onUpdateShot({
                    timeoutSeconds: Math.max(1, Math.min(60, Number(e.target.value) || 10)),
                  })
                }
                className={`px-1.5 py-1 rounded border ${inputCls}`}
              />
            </label>
            <div className="flex flex-col gap-0.5">
              <span className={mutedCls}>Countdown (s)</span>
              <SegmentedSwitch
                isLight={isLight}
                size="sm"
                fullWidth
                value={String(shot.downCounterSeconds)}
                options={[
                  { value: '0', label: '0s' },
                  { value: '1', label: '1s' },
                  { value: '2', label: '2s' },
                  { value: '3', label: '3s' },
                ]}
                onValueChange={(val) =>
                  onUpdateShot({
                    downCounterSeconds: (Number(val) || 0) as 0 | 1 | 2 | 3,
                  })
                }
              />
            </div>
            <label className="flex flex-col gap-0.5">
              <span className={mutedCls}>Intervene Offset (f)</span>
              <input
                type="number"
                min={-360}
                max={0}
                step={12}
                value={shot.interveneOffsetFrames}
                onChange={(e) =>
                  onUpdateShot({
                    interveneOffsetFrames: Math.max(
                      -360,
                      Math.min(0, Number(e.target.value) || 0)
                    ),
                  })
                }
                className={`px-1.5 py-1 rounded border ${inputCls}`}
              />
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <span className={`text-[11px] font-semibold ${mutedCls}`}>
              Per-Car Takeover Rules (applied at intervene start)
            </span>
            <div className="flex flex-col gap-1">
              {slotKeys.map((slot) => {
                const rule = shot.perCarTakeover[slot] ?? { mode: 'as-previous' };
                const modeLabel =
                  TAKEOVER_MODES.find((m) => m.value === rule.mode)?.label ?? rule.mode;
                return (
                  <div key={slot} className="flex items-center gap-1.5 text-[11px]">
                    <span className="w-14 font-mono shrink-0">Slot {slot}</span>
                    <DropdownMenu
                      isLight={isLight}
                      size="sm"
                      className="flex-1 min-w-0"
                      menuWidthClass="w-44"
                      value={rule.mode}
                      label={modeLabel}
                      options={TAKEOVER_MODES}
                      onChange={(val) =>
                        onUpdatePerCar(slot, val, rule.modelId ?? 'nexto')
                      }
                    />
                    {rule.mode === 'model' && (
                      <DropdownMenu
                        isLight={isLight}
                        size="sm"
                        className="w-28 shrink-0"
                        menuWidthClass="w-36"
                        align="right"
                        value={rule.modelId ?? 'nexto'}
                        label={rule.modelId ?? 'nexto'}
                        options={MODEL_IDS.map((id) => ({ value: id, label: id }))}
                        onChange={(val) => onUpdatePerCar(slot, 'model', val)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pt-1.5 border-t border-neutral-500/20 opacity-60">
            <Checkbox
              isLight={isLight}
              size="sm"
              checked={false}
              disabled
              label="Optional POV Car Spawn Variation (under evaluation)"
              description="Disabled while boost-collection interaction under position jitter is evaluated."
            />
          </div>
        </div>
      );
    }
  );
DynamicTrainingShotEditorCard.displayName = 'DynamicTrainingShotEditorCard';
