import React, { useState } from 'react';
import {
  ArrowUpRight,
  Compass,
  Minus,
  MoreHorizontal,
  Pen,
  RotateCcw,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { SurfaceMeta, StandardSurfaceProps } from '../../manifest/surfaceMetaTypes';
import {
  TELESTRATOR_COLORS,
  telestratorStore,
  useTelestratorStore,
  type TelestratorBrushKind,
  type TelestratorOpacityLevel,
} from '../../stores/telestratorStore';

export const SURFACE_META: SurfaceMeta = {
  id: 'telestrator-toolbar',
  title: 'Telestrator',
  layer: 'floating-dev',
  menuGroup: 'sandboxes',
  hideFooter: true,
  defaultSizing: {
    width: 112,
    height: 460,
    minWidth: 96,
    minHeight: 380,
  },
  description: 'Vertical 3D tactical drawing toolbar & POV direction adjust',
};

const BRUSH_OPTIONS: readonly {
  readonly id: TelestratorBrushKind;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'solid', label: 'Solid Line', icon: Minus },
  { id: 'dashed', label: 'Dashed Line', icon: MoreHorizontal },
  { id: 'arrow', label: 'Arrow Line', icon: ArrowUpRight },
];

const OPACITY_OPTIONS: readonly TelestratorOpacityLevel[] = [1.0, 0.7, 0.5];

export const TelestratorToolbarFloatingWindow: React.FC<StandardSurfaceProps> = () => {
  const drawingActive = useTelestratorStore((s) => s.drawingActive);
  const directionAdjustActive = useTelestratorStore((s) => s.directionAdjustActive);
  const brushType = useTelestratorStore((s) => s.brushType);
  const colorId = useTelestratorStore((s) => s.colorId);
  const opacity = useTelestratorStore((s) => s.opacity);
  const activePresetId = useTelestratorStore((s) => s.activePresetId);
  const strokeCount = useTelestratorStore((s) => s.strokes.length);
  const [hoverTip, setHoverTip] = useState<string | null>(null);

  const st = telestratorStore.getState();

  return (
    <div className="relative flex flex-col items-center gap-2 p-2 select-none text-zinc-200">
      {hoverTip && (
        <div className="px-2 py-1 rounded bg-zinc-950/90 border border-white/15 text-[10px] text-amber-300 text-center leading-tight">
          {hoverTip}
        </div>
      )}

      <div className="flex items-center gap-1 w-full justify-center">
        <button
          type="button"
          onClick={() => st.setDrawingActive(!drawingActive)}
          onMouseEnter={() => setHoverTip('Draw on Arena (Locks Camera)')}
          onMouseLeave={() => setHoverTip(null)}
          className={`p-1.5 rounded border transition-colors cursor-pointer ${
            drawingActive
              ? 'bg-amber-500/25 border-amber-400 text-amber-300'
              : 'bg-zinc-900/60 border-white/10 text-zinc-400 hover:text-white'
          }`}
          title="Draw Mode"
        >
          <Pen className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => st.setDirectionAdjustActive(!directionAdjustActive)}
          onMouseEnter={() => setHoverTip('Direction Adjust (Pan POV)')}
          onMouseLeave={() => setHoverTip(null)}
          className={`p-1.5 rounded border transition-colors cursor-pointer ${
            directionAdjustActive
              ? 'bg-sky-500/25 border-sky-400 text-sky-300'
              : 'bg-zinc-900/60 border-white/10 text-zinc-400 hover:text-white'
          }`}
          title="Direction Adjust"
        >
          <Compass className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => st.triggerRestorePov()}
          onMouseEnter={() => setHoverTip('Restore POV Angle')}
          onMouseLeave={() => setHoverTip(null)}
          className="p-1.5 rounded border bg-zinc-900/60 border-white/10 text-zinc-400 hover:text-white cursor-pointer"
          title="Restore POV"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="w-full h-px bg-white/10" />

      <div className="flex items-center gap-1 w-full justify-center">
        {([1, 2, 3] as const).map((pid) => (
          <button
            key={pid}
            type="button"
            onClick={() => st.selectPreset(pid)}
            onMouseEnter={() => setHoverTip(`Brush Preset ${pid}`)}
            onMouseLeave={() => setHoverTip(null)}
            className={`px-1.5 py-0.5 text-[10px] font-bold rounded border cursor-pointer ${
              activePresetId === pid
                ? 'bg-emerald-500/25 border-emerald-400 text-emerald-300'
                : 'bg-zinc-900/60 border-white/10 text-zinc-400'
            }`}
          >
            P{pid}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1 w-full justify-center">
        {BRUSH_OPTIONS.map((b) => {
          const Icon = b.icon;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => st.setBrushType(b.id)}
              onMouseEnter={() => setHoverTip(b.label)}
              onMouseLeave={() => setHoverTip(null)}
              className={`p-1.5 rounded border cursor-pointer ${
                brushType === b.id
                  ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                  : 'bg-zinc-900/60 border-white/10 text-zinc-400 hover:text-white'
              }`}
              title={b.label}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-1.5 py-1">
        {TELESTRATOR_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => st.setColorId(c.id)}
            onMouseEnter={() => setHoverTip(c.label)}
            onMouseLeave={() => setHoverTip(null)}
            style={{ backgroundColor: c.hex }}
            className={`w-5 h-5 rounded-full border-2 cursor-pointer transition-transform ${
              colorId === c.id ? 'border-white scale-110' : 'border-black/40 opacity-80'
            }`}
            title={c.label}
          />
        ))}
      </div>

      <div className="flex items-center gap-1 w-full justify-center">
        {OPACITY_OPTIONS.map((op) => (
          <button
            key={op}
            type="button"
            onClick={() => st.setOpacity(op)}
            onMouseEnter={() => setHoverTip(`Opacity ${Math.round(op * 100)}%`)}
            onMouseLeave={() => setHoverTip(null)}
            className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border cursor-pointer ${
              opacity === op
                ? 'bg-sky-500/25 border-sky-400 text-sky-300'
                : 'bg-zinc-900/60 border-white/10 text-zinc-400'
            }`}
          >
            {Math.round(op * 100)}%
          </button>
        ))}
      </div>

      <div className="w-full h-px bg-white/10" />

      <div className="flex items-center gap-1.5 w-full justify-center">
        <button
          type="button"
          onClick={() => st.undoStroke()}
          disabled={strokeCount === 0}
          onMouseEnter={() => setHoverTip('Undo (Ctrl/Cmd+Z)')}
          onMouseLeave={() => setHoverTip(null)}
          className="p-1.5 rounded border bg-zinc-900/60 border-white/10 text-zinc-300 hover:text-white disabled:opacity-35 cursor-pointer"
          title="Undo"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => st.clearStrokes()}
          disabled={strokeCount === 0}
          onMouseEnter={() => setHoverTip('Clear All Strokes')}
          onMouseLeave={() => setHoverTip(null)}
          className="p-1.5 rounded border bg-rose-500/15 border-rose-500/30 text-rose-300 hover:bg-rose-500/25 disabled:opacity-35 cursor-pointer"
          title="Clear All"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default TelestratorToolbarFloatingWindow;
