import React, { useState, useEffect } from 'react';
import { Camera, Eye, Download, Copy, Check, RotateCcw, ArrowLeftRight } from 'lucide-react';
import {
  useStaticTrainingBallCamTunerStore,
  DEFAULT_STATIC_TRAINING_BALL_CAM_TUNER_CONFIG,
} from '../../stores/staticTrainingBallCamTunerStore';
import { useStaticTrainingPackStore } from '../../stores/staticTrainingPackStore';
import {
  ballVisualRuntimeConfig,
  setTemporaryBallOpacityOverride,
} from '../../config/ballVisualConfig.js';

export interface StaticTrainingBallCamTunerFloatingWindowProps {
  isLight?: boolean;
  active?: boolean;
}

interface SliderWithTextInputRowProps {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  disabled?: boolean;
  isLight?: boolean;
  extraAction?: React.ReactNode;
  onChange: (nextValue: number) => void;
}

const SliderWithTextInputRow: React.FC<SliderWithTextInputRowProps> = ({
  label,
  unit,
  value,
  min,
  max,
  step,
  decimals = 0,
  disabled = false,
  isLight = false,
  extraAction,
  onChange,
}) => {
  const formatVal = (v: number) => {
    if (!Number.isFinite(v)) return String(v);
    return String(v);
  };

  const [draftText, setDraftText] = useState<string>(() => formatVal(value));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setDraftText(formatVal(value));
    }
  }, [value, isFocused]);

  const commitDraft = () => {
    const raw = draftText.trim();
    const parsed = Number(raw);
    if (raw === '' || Number.isNaN(parsed)) {
      console.error(
        new TypeError(
          `[TrainingBallCamTuner] Invalid numeric input for "${label}": "${draftText}"`
        )
      );
      onChange(parsed);
      return;
    }
    onChange(parsed);
    setDraftText(String(parsed));
  };

  const sliderVal = Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : min;
  const pct = Math.max(0, Math.min(100, ((sliderVal - min) / (max - min)) * 100));

  return (
    <div
      className={`flex flex-col gap-1.5 p-2 rounded-lg border transition-opacity ${
        disabled ? 'opacity-45 pointer-events-none' : ''
      } ${
        isLight
          ? 'bg-white/80 border-neutral-200/80'
          : 'bg-neutral-900/60 border-neutral-800/80'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`text-[11px] font-medium truncate ${
              isLight ? 'text-neutral-700' : 'text-neutral-200'
            }`}
          >
            {label}
          </span>
          {extraAction}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <input
            type="text"
            value={draftText}
            disabled={disabled}
            onFocus={() => setIsFocused(true)}
            onBlur={() => {
              setIsFocused(false);
              commitDraft();
            }}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraftText(formatVal(value));
                (e.target as HTMLInputElement).blur();
              }
            }}
            title="Type any value and press Enter to confirm (unbounded)"
            className={`w-20 px-1.5 py-0.5 rounded text-right font-mono text-[11px] font-semibold border outline-none transition-colors ${
              isLight
                ? 'bg-neutral-100 border-neutral-300 text-neutral-800 focus:border-amber-500 focus:bg-white'
                : 'bg-neutral-950 border-neutral-700 text-amber-400 focus:border-amber-500'
            }`}
          />
          <span className="text-[10px] font-mono text-neutral-400 w-7 text-left">
            {unit}
          </span>
        </div>
      </div>

      <div className="relative w-full h-4 flex items-center">
        <div
          className={`w-full h-1.5 rounded-full overflow-hidden ${
            isLight ? 'bg-neutral-200' : 'bg-neutral-800'
          }`}
        >
          <div
            className="h-full bg-amber-500 rounded-full"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={sliderVal}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) {
              const next =
                decimals > 0 ? Number(v.toFixed(decimals)) : Math.round(v);
              onChange(next);
            }
          }}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>
    </div>
  );
};

export const StaticTrainingBallCamTunerFloatingWindow: React.FC<
  StaticTrainingBallCamTunerFloatingWindowProps
> = ({ isLight = false, active = true }) => {
  const {
    distance,
    height,
    angle,
    lateralOffset,
    editBallOpacity,
    enableEditOpacityOverride,
    updateConfig,
    switchLateralSide,
    resetDefaults,
  } = useStaticTrainingBallCamTunerStore();

  const sessionMode = useStaticTrainingPackStore((s) => s.sessionMode);
  const isTestingSingleShot = useStaticTrainingPackStore((s) => s.isTestingSingleShot);
  const editSubMode = useStaticTrainingPackStore((s) => s.editSubMode);
  const setEditSubMode = useStaticTrainingPackStore((s) => s.setEditSubMode);

  const [copied, setCopied] = useState(false);

  const isInEditModeUntested = sessionMode === 'edit' && !isTestingSingleShot;
  const globalOpacity = Number(ballVisualRuntimeConfig.opacity ?? 0.7);
  const globalModeLabel =
    Math.abs(globalOpacity - 0.7) < 0.005
      ? '70%'
      : Math.abs(globalOpacity - 1.0) < 0.005
        ? '100%'
        : `Custom (${Math.round(globalOpacity * 100)}%)`;

  useEffect(() => {
    if (isInEditModeUntested) {
      setTemporaryBallOpacityOverride(
        enableEditOpacityOverride ? editBallOpacity : null
      );
    } else {
      setTemporaryBallOpacityOverride(null);
    }
  }, [isInEditModeUntested, enableEditOpacityOverride, editBallOpacity]);

  if (!active) return null;

  const buildExportPayload = () => ({
    relativeBallCamera: {
      distance,
      height,
      angle,
      lateralOffset,
    },
    editModeBallOpacity: {
      defaultOpacity: editBallOpacity,
      temporaryOverrideEnabled: enableEditOpacityOverride,
    },
  });

  const handleCopyJson = () => {
    const json = JSON.stringify(buildExportPayload(), null, 2);
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(json).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownloadJson = () => {
    const json = JSON.stringify(buildExportPayload(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'static-training-ball-cam-config.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      data-ui-interactive="true"
      className="flex flex-col gap-3 text-xs select-none"
    >
      {/* Header Status Bar */}
      <div
        className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl border ${
          isLight
            ? 'bg-neutral-100/90 border-neutral-200 text-neutral-700'
            : 'bg-neutral-900/80 border-neutral-800 text-neutral-300'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Camera className="w-4 h-4 text-sky-400 shrink-0" />
          <div className="flex flex-col leading-tight truncate">
            <span className="font-semibold text-[11px] truncate">
              Relative Ball Camera (Ball Speed Sub-Mode)
            </span>
            <span className="text-[10px] text-neutral-400 truncate">
              Unbounded text input + Enter · [F] Switch Side
            </span>
          </div>
        </div>

        {sessionMode === 'edit' && editSubMode !== 'ball-speed' && (
          <button
            type="button"
            onClick={() => setEditSubMode('ball-speed')}
            className="px-2 py-1 rounded-md text-[10px] font-semibold bg-sky-500/20 border border-sky-500/40 text-sky-300 hover:bg-sky-500/30 transition-colors shrink-0"
          >
            Focus Ball Cam
          </button>
        )}
      </div>

      {/* Relative Ball Camera Sliders + Text Inputs */}
      <div className="grid grid-cols-1 gap-2">
        <SliderWithTextInputRow
          label="Distance"
          unit="UU"
          value={distance}
          min={50}
          max={1200}
          step={5}
          decimals={0}
          isLight={isLight}
          onChange={(v) => updateConfig({ distance: v })}
        />

        <SliderWithTextInputRow
          label="Height Offset"
          unit="UU"
          value={height}
          min={-200}
          max={800}
          step={5}
          decimals={0}
          isLight={isLight}
          onChange={(v) => updateConfig({ height: v })}
        />

        <SliderWithTextInputRow
          label="Pitch Angle Offset"
          unit="deg"
          value={angle}
          min={-90}
          max={90}
          step={0.5}
          decimals={1}
          isLight={isLight}
          onChange={(v) => updateConfig({ angle: v })}
        />

        <SliderWithTextInputRow
          label="Lateral Offset"
          unit="UU"
          value={lateralOffset}
          min={-400}
          max={400}
          step={5}
          decimals={0}
          isLight={isLight}
          extraAction={
            <button
              type="button"
              onClick={switchLateralSide}
              title="Switch lateral offset side (Hotkey: F)"
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold border transition-colors ${
                isLight
                  ? 'bg-neutral-100 border-neutral-300 text-neutral-700 hover:bg-neutral-200'
                  : 'bg-neutral-800 border-neutral-700 text-sky-300 hover:bg-neutral-700'
              }`}
            >
              <ArrowLeftRight className="w-2.5 h-2.5" />
              <span>[F] Switch Side</span>
            </button>
          }
          onChange={(v) => updateConfig({ lateralOffset: v })}
        />
      </div>

      {/* Edit Mode Ball Opacity Temporary Override Section */}
      <div
        className={`flex flex-col gap-2 p-2.5 rounded-xl border ${
          isLight
            ? 'bg-neutral-100/80 border-neutral-200'
            : 'bg-neutral-900/70 border-neutral-800'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Eye className="w-4 h-4 text-amber-400 shrink-0" />
            <div className="flex flex-col leading-tight">
              <span
                className={`text-[11px] font-semibold ${
                  isLight ? 'text-neutral-800' : 'text-neutral-100'
                }`}
              >
                Edit-Mode Ball Opacity (Temporary Override)
              </span>
              <span className="text-[10px] text-neutral-400">
                Reverts to Follow Global ({globalModeLabel}) when testing [G] or playing
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() =>
              updateConfig({
                enableEditOpacityOverride: !enableEditOpacityOverride,
              })
            }
            className={`px-2 py-1 rounded-md text-[10px] font-mono font-semibold border transition-colors shrink-0 ${
              enableEditOpacityOverride
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400'
            }`}
          >
            {enableEditOpacityOverride ? 'Override ON' : 'Follow Global'}
          </button>
        </div>

        <SliderWithTextInputRow
          label="Edit Mode Ball Opacity"
          unit=""
          value={editBallOpacity}
          min={0.05}
          max={1.0}
          step={0.05}
          decimals={2}
          disabled={!enableEditOpacityOverride}
          isLight={isLight}
          onChange={(v) => updateConfig({ editBallOpacity: v })}
        />

        <div className="flex items-center justify-between text-[10px] font-mono px-1 text-neutral-400">
          <span>
            Status:{' '}
            <strong
              className={
                isInEditModeUntested && enableEditOpacityOverride
                  ? 'text-amber-400'
                  : 'text-emerald-400'
              }
            >
              {isInEditModeUntested && enableEditOpacityOverride
                ? `Edit Override (${Math.round(editBallOpacity * 100)}%)`
                : `Following Global (${globalModeLabel})`}
            </strong>
          </span>
          <span>
            Default: {DEFAULT_STATIC_TRAINING_BALL_CAM_TUNER_CONFIG.editBallOpacity.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Export / Copy / Reset Footer */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleDownloadJson}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
              isLight
                ? 'bg-sky-50 border-sky-200 text-sky-700 hover:bg-sky-100'
                : 'bg-sky-500/15 border-sky-500/35 text-sky-300 hover:bg-sky-500/25'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export JSON</span>
          </button>

          <button
            type="button"
            onClick={handleCopyJson}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
              isLight
                ? 'bg-neutral-100 border-neutral-300 text-neutral-700 hover:bg-neutral-200'
                : 'bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-700'
            }`}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy JSON</span>
              </>
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={resetDefaults}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
            isLight
              ? 'bg-neutral-100 border-neutral-300 text-neutral-600 hover:bg-neutral-200'
              : 'bg-neutral-900 border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600'
          }`}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reset</span>
        </button>
      </div>
    </div>
  );
};
