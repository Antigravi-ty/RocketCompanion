import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpRight,
  Compass,
  Eye,
  EyeOff,
  Minus,
  MoreHorizontal,
  Pen,
  RotateCcw,
  Settings,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  TELESTRATOR_COLORS,
  type TelestratorPresetIndex,
} from '../../../entities/telestrator/telestratorTypes';
import type { StandardSurfaceProps, SurfaceMeta } from '../../manifest/surfaceMetaTypes';
import { floatingStore } from '../../stores/floatingStore';
import {
  canLocalDrawInTelestrator,
  useTelestratorStore,
} from '../../stores/telestratorStore';
import { TelestratorSettingsFloatingWindow } from './TelestratorSettingsFloatingWindow';

export const SURFACE_META: SurfaceMeta = {
  id: 'telestrator-toolbar',
  title: 'Telestrator Overlay',
  subtitle: '3D Spatial Tactical Drawing & View Adjust',
  description:
    'Mode-independent vertical overlay toolbar for 3D arena telestrator strokes, brush presets, colors, Direction Adjust, Eye visibility, Undo, Clear, and screen-normalized Settings.',
  icon: 'Pen',
  layer: 'floating-dev',
  menuGroup: 'active-tuners',
  hideFooter: true,
  defaultSizing: {
    width: 58,
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
  const [bubblePos, setBubblePos] = useState<{ top: number; left: number; flipLeft: boolean } | null>(
    null
  );
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const baseClass = active
    ? (accentClass ?? 'bg-sky-500/25 border-sky-400 text-sky-300')
    : isLight
      ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-700'
      : 'bg-neutral-900/70 hover:bg-neutral-800 border-neutral-700/70 text-neutral-300';

  const showBubble = () => {
    const el = btnRef.current;
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    const flipLeft = rect.right + 220 > window.innerWidth;
    setBubblePos({
      top: rect.top + rect.height * 0.5,
      left: flipLeft ? rect.left - 8 : rect.right + 8,
      flipLeft,
    });
  };

  const hideBubble = () => setBubblePos(null);

  return (
    <div className="relative flex items-center justify-center">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={onClick}
        onMouseEnter={showBubble}
        onMouseLeave={hideBubble}
        aria-label={label}
        title={label}
        className={`w-9 h-8 rounded-lg border flex items-center justify-center transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed ${baseClass}`}
      >
        {children}
      </button>
      {bubblePos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: bubblePos.top,
              left: bubblePos.left,
              transform: bubblePos.flipLeft ? 'translate(-100%, -50%)' : 'translate(0, -50%)',
              zIndex: 9999,
            }}
            className={`pointer-events-none whitespace-nowrap rounded-md border px-2 py-1 text-[10px] font-medium shadow-lg ${
              isLight
                ? 'bg-white border-neutral-300 text-neutral-800'
                : 'bg-neutral-900 border-neutral-700 text-neutral-100'
            }`}
          >
            {label}
          </div>,
          document.body
        )}
    </div>
  );
};

export const TelestratorToolbarFloatingWindow: React.FC<
  TelestratorToolbarFloatingWindowProps
> = ({ isLight = false, active = true }) => {
  const state = useTelestratorStore();
  const {
    drawingEnabled,
    strokesVisible,
    directionAdjustActive,
    isFreeCam,
    directionOffsetYawDeg: yawDeg,
    directionOffsetPitchDeg: pitchDeg,
    activeTool,
    activeColorId,
    activePresetIndex,
    presets,
    strokeCount,
    hasUndoHistory,
    pendingClearPurge,
    settingsOpen,
    isHost,
    isCameraSynced,
    setOverlayActive,
    setDrawingEnabled,
    setStrokesVisible,
    setDirectionAdjustActive,
    setActiveTool,
    setActiveColorId,
    setActivePresetIndex,
    setSettingsOpen,
    triggerUndo,
    triggerClear,
    triggerRestoreDirectionOffset,
  } = state;

  useEffect(() => {
    if (!active) return;
    setOverlayActive(true);
    return () => {
      setOverlayActive(false);
    };
  }, [active, setOverlayActive]);

  useEffect(() => {
    if (!active) return;
    const snap = floatingStore.getSnapshot();
    const win = snap.windows.find((w) => w.id === 'telestrator-toolbar');
    const curHeight = win?.height ?? 540;
    floatingStore.updateSize('telestrator-toolbar', {
      width: settingsOpen ? 316 : 58,
      height: curHeight,
    });
  }, [active, settingsOpen]);

  if (!active) return null;

  const canDraw = canLocalDrawInTelestrator(state);
  const hasAngleOffset = yawDeg !== 0 || pitchDeg !== 0;
  const dividerClass = isLight ? 'border-neutral-200' : 'border-neutral-800';

  const drawLabel = !strokesVisible
    ? 'Strokes Hidden by Host'
    : !isHost && !isCameraSynced
      ? 'Drawing Disabled (Unsynced Camera View)'
      : !canDraw
        ? 'Drawing Disabled by Host'
        : drawingEnabled
          ? 'Draw Mode ON (Click to Pause Drawing)'
          : 'Draw Mode OFF (Click to Activate)';

  const clearLabel = isHost
    ? pendingClearPurge
      ? 'Clear ALL Players Strokes (2nd Click)'
      : 'Clear Own Strokes (1st Click)'
    : 'Clear Own Strokes';

  return (
    <div className="flex flex-row items-start w-full select-none">
      <div className="flex flex-col items-center gap-1 shrink-0">
        <IconButtonWithBubble
          label={drawLabel}
          active={drawingEnabled && !directionAdjustActive && canDraw}
          disabled={!canDraw}
          accentClass="bg-emerald-500/25 border-emerald-400 text-emerald-300"
          isLight={isLight}
          onClick={() => setDrawingEnabled(!drawingEnabled)}
        >
          <Pen className="w-4 h-4" />
        </IconButtonWithBubble>

        {isHost && (
          <IconButtonWithBubble
            label={
              strokesVisible
                ? 'Hide All Strokes (Also Pauses Drawing)'
                : 'Show All Strokes'
            }
            active={!strokesVisible}
            accentClass="bg-amber-500/25 border-amber-400 text-amber-300"
            isLight={isLight}
            onClick={() => setStrokesVisible(!strokesVisible)}
          >
            {strokesVisible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
          </IconButtonWithBubble>
        )}

        <IconButtonWithBubble
          label={
            isFreeCam
              ? 'Direction Adjust (Unavailable in Free Cam)'
              : 'Direction Adjust (Rotate POV Heading)'
          }
          active={directionAdjustActive && !isFreeCam}
          disabled={isFreeCam}
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
          active={hasAngleOffset && !isFreeCam}
          disabled={isFreeCam || !hasAngleOffset}
          accentClass="bg-sky-500/20 border-sky-400 text-sky-300"
          isLight={isLight}
          onClick={triggerRestoreDirectionOffset}
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </IconButtonWithBubble>

        <div className={`w-8 border-t my-0.5 ${dividerClass}`} />

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

        {([0, 1, 2] as const).map((idx: TelestratorPresetIndex) => {
          const preset = presets[idx];
          const pct = Math.round(preset.opacity * 100);
          return (
            <IconButtonWithBubble
              key={preset.id}
              label={`Preset ${idx + 1}: ${pct}% Opacity, ${preset.widthRefPx} px (1080p)`}
              active={activePresetIndex === idx}
              isLight={isLight}
              onClick={() => setActivePresetIndex(idx)}
            >
              <span className="text-[10px] font-bold tabular-nums">{pct}</span>
            </IconButtonWithBubble>
          );
        })}

        <div className={`w-8 border-t my-0.5 ${dividerClass}`} />

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

        <IconButtonWithBubble
          label={`Undo Own Stroke (Ctrl/Cmd+Z) [${strokeCount}]`}
          disabled={!hasUndoHistory}
          isLight={isLight}
          onClick={triggerUndo}
        >
          <Undo2 className="w-3.5 h-3.5" />
        </IconButtonWithBubble>

        <IconButtonWithBubble
          label={clearLabel}
          active={isHost && pendingClearPurge}
          accentClass="bg-rose-500/25 border-rose-400 text-rose-300"
          disabled={strokeCount === 0 && !pendingClearPurge}
          isLight={isLight}
          onClick={triggerClear}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </IconButtonWithBubble>

        <IconButtonWithBubble
          label="Telestrator Settings & Dump Last Stroke"
          active={settingsOpen}
          isLight={isLight}
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <Settings className="w-3.5 h-3.5" />
        </IconButtonWithBubble>
      </div>

      {settingsOpen && <TelestratorSettingsFloatingWindow isLight={isLight} />}

      <div className="flex-1 min-w-0" />
    </div>
  );
};
