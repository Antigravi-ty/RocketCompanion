import React, { useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Compass,
  Minus,
  MoreHorizontal,
  Pen,
  RotateCcw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { TELESTRATOR_COLORS } from '../../../entities/telestrator/telestratorTypes';
import type { StandardSurfaceProps, SurfaceMeta } from '../../manifest/surfaceMetaTypes';
import {
  useTelestratorStore,
  type TelestratorPresetIndex,
} from '../../stores/telestratorStore';

export const SURFACE_META: SurfaceMeta = {
  id: 'telestrator-toolbar',
  title: 'Telestrator',
  subtitle: '3D Spatial Tactical Drawing & View Adjust',
  description:
    'Compact vertical toolbar for 3D arena telestrator strokes, brush presets, colors, Direction Adjust, Undo, and Clear.',
  icon: 'Pen',
  layer: 'floating-dev',
  menuGroup: 'sandboxes',
  hideFooter: true,
  defaultSizing: {
    width: 72,
    height: 540,
    minHeight: 360,
    mode: 'adaptive',
  },
};

export interface TelestratorToolbarFloatingWindowProps extends StandardSurfaceProps {
  active?: boolean;
}

interface IconButtonWithBubbleProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  accentClass?: string;
  isLight: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

const IconButtonWithBubble: React.FC<IconButtonWithBubbleProps> = ({
  label,
  active = false,
  disabled = false,
  accentClass,
  isLight,
  onClick,
  children,
}) => {
  const [hovered, setHovered] = useState(false);

  const baseClass = active
    ? (accentClass ?? 'bg-sky-500/25 border-sky-400 text-sky-300')
    : isLight
      ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-700'
      : 'bg-neutral-900/70 hover:bg-neutral-800 border-neutral-700/70 text-neutral-300';

  return (
    <div
      className="relative flex items-center justify-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
        title={label}
        className={`w-9 h-8 rounded-lg border flex items-center justify-center transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed ${baseClass}`}
      >
        {children}
      </button>
      {hovered && (
        <div
          className={`pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-md border px-2 py-1 text-[10px] font-medium shadow-lg ${
            isLight
              ? 'bg-white border-neutral-300 text-neutral-800'
              : 'bg-neutral-900 border-neutral-700 text-neutral-100'
          }`}
        >
          {label}
        </div>
      )}
    </div>
  );
};

export const TelestratorToolbarFloatingWindow: React.FC<
  TelestratorToolbarFloatingWindowProps
> = ({ isLight = false, active = true }) => {
  const drawingEnabled = useTelestratorStore((s) => s.drawingEnabled);
  const directionAdjustActive = useTelestratorStore((s) => s.directionAdjustActive);
  const yawDeg = useTelestratorStore((s) => s.directionOffsetYawDeg);
  const pitchDeg = useTelestratorStore((s) => s.directionOffsetPitchDeg);
  const activeTool = useTelestratorStore((s) => s.activeTool);
  const activeColorId = useTelestratorStore((s) => s.activeColorId);
  const activePresetIndex = useTelestratorStore((s) => s.activePresetIndex);
  const presets = useTelestratorStore((s) => s.presets);
  const dropStemsEnabled = useTelestratorStore((s) => s.dropStemsEnabled);
  const strokeCount = useTelestratorStore((s) => s.strokeCount);

  const setDrawingEnabled = useTelestratorStore((s) => s.setDrawingEnabled);
  const setDirectionAdjustActive = useTelestratorStore((s) => s.setDirectionAdjustActive);
  const setActiveTool = useTelestratorStore((s) => s.setActiveTool);
  const setActiveColorId = useTelestratorStore((s) => s.setActiveColorId);
  const setActivePresetIndex = useTelestratorStore((s) => s.setActivePresetIndex);
  const setDropStemsEnabled = useTelestratorStore((s) => s.setDropStemsEnabled);
  const triggerUndo = useTelestratorStore((s) => s.triggerUndo);
  const triggerClear = useTelestratorStore((s) => s.triggerClear);
  const triggerRestoreDirectionOffset = useTelestratorStore(
    (s) => s.triggerRestoreDirectionOffset
  );

  if (!active) return null;

  const hasAngleOffset = yawDeg !== 0 || pitchDeg !== 0;
  const dividerClass = isLight ? 'border-neutral-200' : 'border-neutral-800';

  return (
    <div className="flex flex-col items-center gap-1.5 py-1 select-none">
      {/* Interaction Mode: Draw vs Direction Adjust */}
      <IconButtonWithBubble
        label="Draw Mode (Disables View Drag)"
        active={drawingEnabled && !directionAdjustActive}
        accentClass="bg-emerald-500/25 border-emerald-400 text-emerald-300"
        isLight={isLight}
        onClick={() => setDrawingEnabled(true)}
      >
        <Pen className="w-4 h-4" />
      </IconButtonWithBubble>

      <IconButtonWithBubble
        label="Direction Adjust (Rotate View Heading, Disables Draw)"
        active={directionAdjustActive}
        accentClass="bg-amber-500/25 border-amber-400 text-amber-300"
        isLight={isLight}
        onClick={() => setDirectionAdjustActive(!directionAdjustActive)}
      >
        <Compass className="w-4 h-4" />
      </IconButtonWithBubble>

      <IconButtonWithBubble
        label={
          hasAngleOffset
            ? `Restore POV (Offset ${yawDeg}deg / ${pitchDeg}deg)`
            : 'Restore POV (Angle 0deg)'
        }
        active={hasAngleOffset}
        disabled={!hasAngleOffset}
        accentClass="bg-sky-500/20 border-sky-400 text-sky-300"
        isLight={isLight}
        onClick={triggerRestoreDirectionOffset}
      >
        <RotateCcw className="w-3.5 h-3.5" />
      </IconButtonWithBubble>

      <div className={`w-8 border-t my-0.5 ${dividerClass}`} />

      {/* Brush Types */}
      <IconButtonWithBubble
        label="Solid Line"
        active={activeTool === 'solid'}
        isLight={isLight}
        onClick={() => setActiveTool('solid')}
      >
        <Minus className="w-4 h-4" />
      </IconButtonWithBubble>

      <IconButtonWithBubble
        label="Dashed Line"
        active={activeTool === 'dashed'}
        isLight={isLight}
        onClick={() => setActiveTool('dashed')}
      >
        <MoreHorizontal className="w-4 h-4" />
      </IconButtonWithBubble>

      <IconButtonWithBubble
        label="Tactical Arrow"
        active={activeTool === 'arrow'}
        isLight={isLight}
        onClick={() => setActiveTool('arrow')}
      >
        <ArrowUpRight className="w-4 h-4" />
      </IconButtonWithBubble>

      <div className={`w-8 border-t my-0.5 ${dividerClass}`} />

      {/* 3 Opacity / Thickness Presets */}
      {([0, 1, 2] as const).map((idx: TelestratorPresetIndex) => {
        const preset = presets[idx];
        const pct = Math.round(preset.opacity * 100);
        return (
          <IconButtonWithBubble
            key={preset.id}
            label={`Preset ${idx + 1}: ${pct}% Opacity, ${preset.widthPx}px`}
            active={activePresetIndex === idx}
            isLight={isLight}
            onClick={() => setActivePresetIndex(idx)}
          >
            <span className="text-[10px] font-bold tabular-nums">{pct}</span>
          </IconButtonWithBubble>
        );
      })}

      <div className={`w-8 border-t my-0.5 ${dividerClass}`} />

      {/* 6 Color Swatches */}
      <div className="grid grid-cols-2 gap-1">
        {TELESTRATOR_COLORS.map((c) => {
          const selected = activeColorId === c.id;
          return (
            <button
              key={c.id}
              type="button"
              title={c.label}
              aria-label={c.label}
              onClick={() => setActiveColorId(c.id)}
              className={`w-4 h-4 rounded-full border transition-transform cursor-pointer ${
                selected
                  ? 'scale-110 ring-2 ring-sky-400 border-white'
                  : 'border-neutral-600 hover:scale-105'
              }`}
              style={{ backgroundColor: c.hex }}
            />
          );
        })}
      </div>

      <div className={`w-8 border-t my-0.5 ${dividerClass}`} />

      {/* Drop Stems, Undo, Clear */}
      <IconButtonWithBubble
        label="Toggle Aerial Drop Stems"
        active={dropStemsEnabled}
        isLight={isLight}
        onClick={() => setDropStemsEnabled(!dropStemsEnabled)}
      >
        <ArrowDownToLine className="w-3.5 h-3.5" />
      </IconButtonWithBubble>

      <IconButtonWithBubble
        label={`Undo Stroke (Ctrl/Cmd+Z) [${strokeCount}]`}
        disabled={strokeCount === 0}
        isLight={isLight}
        onClick={triggerUndo}
      >
        <Undo2 className="w-3.5 h-3.5" />
      </IconButtonWithBubble>

      <IconButtonWithBubble
        label="Clear All Strokes"
        disabled={strokeCount === 0}
        isLight={isLight}
        onClick={triggerClear}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </IconButtonWithBubble>
    </div>
  );
};
