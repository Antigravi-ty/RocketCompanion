import React, { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Compass,
  Copy,
  Minus,
  MoreHorizontal,
  Pen,
  RotateCcw,
  Settings,
  Trash2,
  Undo2,
} from 'lucide-react';
import { TELESTRATOR_COLORS } from '../../../entities/telestrator/telestratorTypes';
import type { StandardSurfaceProps, SurfaceMeta } from '../../manifest/surfaceMetaTypes';
import { floatingStore } from '../../stores/floatingStore';
import {
  useTelestratorStore,
  type TelestratorPresetIndex,
} from '../../stores/telestratorStore';

export const SURFACE_META: SurfaceMeta = {
  id: 'telestrator-toolbar',
  title: 'Telestrator Overlay',
  subtitle: '3D Spatial Tactical Drawing & View Adjust',
  description:
    'Mode-independent vertical overlay toolbar for 3D arena telestrator strokes, brush presets, colors, Direction Adjust, Undo, Clear, and normalized screen-space Settings.',
  icon: 'Pen',
  layer: 'floating-dev',
  menuGroup: 'active-tuners',
  hideFooter: true,
  defaultSizing: {
    width: 56,
    height: 500,
    minHeight: 340,
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
  const isFreeCam = useTelestratorStore((s) => s.isFreeCam);
  const yawDeg = useTelestratorStore((s) => s.directionOffsetYawDeg);
  const pitchDeg = useTelestratorStore((s) => s.directionOffsetPitchDeg);
  const activeTool = useTelestratorStore((s) => s.activeTool);
  const activeColorId = useTelestratorStore((s) => s.activeColorId);
  const activePresetIndex = useTelestratorStore((s) => s.activePresetIndex);
  const presets = useTelestratorStore((s) => s.presets);
  const arrowLengthRefPx = useTelestratorStore((s) => s.arrowLengthRefPx);
  const arrowWidthRefPx = useTelestratorStore((s) => s.arrowWidthRefPx);
  const strokeCount = useTelestratorStore((s) => s.strokeCount);
  const hasUndoHistory = useTelestratorStore((s) => s.hasUndoHistory);
  const pendingClearPurge = useTelestratorStore((s) => s.pendingClearPurge);
  const settingsOpen = useTelestratorStore((s) => s.settingsOpen);

  const setOverlayActive = useTelestratorStore((s) => s.setOverlayActive);
  const setDrawingEnabled = useTelestratorStore((s) => s.setDrawingEnabled);
  const setDirectionAdjustActive = useTelestratorStore((s) => s.setDirectionAdjustActive);
  const setActiveTool = useTelestratorStore((s) => s.setActiveTool);
  const setActiveColorId = useTelestratorStore((s) => s.setActiveColorId);
  const setActivePresetIndex = useTelestratorStore((s) => s.setActivePresetIndex);
  const updatePreset = useTelestratorStore((s) => s.updatePreset);
  const setArrowSize = useTelestratorStore((s) => s.setArrowSize);
  const setSettingsOpen = useTelestratorStore((s) => s.setSettingsOpen);
  const triggerUndo = useTelestratorStore((s) => s.triggerUndo);
  const triggerClear = useTelestratorStore((s) => s.triggerClear);
  const triggerRestoreDirectionOffset = useTelestratorStore(
    (s) => s.triggerRestoreDirectionOffset
  );

  const [copiedJson, setCopiedJson] = useState(false);

  useEffect(() => {
    if (!active) return;
    setOverlayActive(true);
    return () => {
      setOverlayActive(false);
    };
  }, [active, setOverlayActive]);

  if (!active) return null;

  const hasAngleOffset = yawDeg !== 0 || pitchDeg !== 0;
  const dividerClass = isLight ? 'border-neutral-200' : 'border-neutral-800';
  const activePreset = presets[activePresetIndex] ?? presets[0];

  const handleToggleSettings = () => {
    const nextOpen = !settingsOpen;
    setSettingsOpen(nextOpen);
    const snap = floatingStore.getSnapshot();
    const win = snap.windows.find((w) => w.id === 'telestrator-toolbar');
    const curHeight = win?.height ?? 500;
    floatingStore.updateSize('telestrator-toolbar', {
      width: nextOpen ? 310 : 56,
      height: curHeight,
    });
  };

  const handleCopyJson = () => {
    const payload = {
      widthRefPx: activePreset.widthRefPx,
      arrowLengthRefPx,
      arrowWidthRefPx,
      presets: presets.map((p) => ({
        id: p.id,
        opacity: Number(p.opacity.toFixed(2)),
        widthRefPx: p.widthRefPx,
      })),
    };
    const json = JSON.stringify(payload, null, 2);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(json);
    }
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 1500);
  };

  return (
    <div className="flex flex-row items-start w-full select-none">
      <div className="flex flex-col items-center gap-1 shrink-0">
      <IconButtonWithBubble
        label={drawingEnabled ? 'Draw Mode ON (Click to Pause Drawing)' : 'Draw Mode OFF (Click to Draw)'}
        active={drawingEnabled && !directionAdjustActive}
        accentClass="bg-emerald-500/25 border-emerald-400 text-emerald-300"
        isLight={isLight}
        onClick={() => setDrawingEnabled(!drawingEnabled)}
      >
        <Pen className="w-4 h-4" />
      </IconButtonWithBubble>

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
        label={`Undo (Ctrl/Cmd+Z) [${strokeCount}]`}
        disabled={!hasUndoHistory}
        isLight={isLight}
        onClick={triggerUndo}
      >
        <Undo2 className="w-3.5 h-3.5" />
      </IconButtonWithBubble>

      <IconButtonWithBubble
        label={
          pendingClearPurge
            ? 'Purge Undo History (2nd Click)'
            : 'Clear Strokes (1st Click: Undoable)'
        }
        active={pendingClearPurge}
        accentClass="bg-rose-500/25 border-rose-400 text-rose-300"
        disabled={strokeCount === 0 && !pendingClearPurge}
        isLight={isLight}
        onClick={triggerClear}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </IconButtonWithBubble>

      <IconButtonWithBubble
        label="Telestrator Settings (Screen-Space Ref Px & Presets)"
        active={settingsOpen}
        isLight={isLight}
        onClick={handleToggleSettings}
      >
        <Settings className="w-3.5 h-3.5" />
      </IconButtonWithBubble>
      </div>

      {settingsOpen && (
        <div
          className={`ml-2 w-[236px] shrink-0 rounded-xl border p-2.5 flex flex-col gap-2 text-xs ${
            isLight
              ? 'bg-white/95 border-neutral-300 text-neutral-800'
              : 'bg-neutral-950/90 border-neutral-700 text-neutral-100'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold">Brush Size (1080p Ref)</span>
            <button
              type="button"
              onClick={handleCopyJson}
              className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300 hover:bg-sky-500/25 cursor-pointer"
            >
              {copiedJson ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copiedJson ? 'Copied' : 'Copy JSON'}
            </button>
          </div>

          <label className="flex flex-col gap-1">
            <div className="flex justify-between text-[11px]">
              <span>Line Width (Active Preset)</span>
              <span className="tabular-nums font-semibold">{activePreset.widthRefPx} px</span>
            </div>
            <input
              type="range"
              min={3}
              max={48}
              step={1}
              value={activePreset.widthRefPx}
              onChange={(e) =>
                updatePreset(activePresetIndex, { widthRefPx: Number(e.target.value) })
              }
              className="w-full accent-emerald-400"
            />
          </label>

          <label className="flex flex-col gap-1">
            <div className="flex justify-between text-[11px]">
              <span>Arrowhead Length</span>
              <span className="tabular-nums font-semibold">{arrowLengthRefPx} px</span>
            </div>
            <input
              type="range"
              min={12}
              max={120}
              step={2}
              value={arrowLengthRefPx}
              onChange={(e) => setArrowSize(Number(e.target.value), arrowWidthRefPx)}
              className="w-full accent-sky-400"
            />
          </label>

          <label className="flex flex-col gap-1">
            <div className="flex justify-between text-[11px]">
              <span>Arrowhead Width</span>
              <span className="tabular-nums font-semibold">{arrowWidthRefPx} px</span>
            </div>
            <input
              type="range"
              min={10}
              max={100}
              step={2}
              value={arrowWidthRefPx}
              onChange={(e) => setArrowSize(arrowLengthRefPx, Number(e.target.value))}
              className="w-full accent-sky-400"
            />
          </label>

          <div className={`border-t pt-2 flex flex-col gap-1.5 ${dividerClass}`}>
            <span className="text-[11px] font-semibold">Opacity Presets</span>
            {([0, 1, 2] as const).map((idx) => {
              const p = presets[idx];
              const pct = Math.round(p.opacity * 100);
              return (
                <label key={p.id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-8 tabular-nums">{pct}%</span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={pct}
                    onChange={(e) =>
                      updatePreset(idx, { opacity: Number(e.target.value) / 100 })
                    }
                    className="flex-1 accent-amber-400"
                  />
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0" />
    </div>
  );
};
