import React, { useState } from 'react';
import { Bug, Check, Copy } from 'lucide-react';
import {
  useTelestratorStore,
} from '../../stores/telestratorStore';

export interface TelestratorSettingsPanelProps {
  isLight: boolean;
}

export const TelestratorSettingsPanel: React.FC<TelestratorSettingsPanelProps> = ({ isLight }) => {
  const activePresetIndex = useTelestratorStore((s) => s.activePresetIndex);
  const presets = useTelestratorStore((s) => s.presets);
  const arrowLengthRefPx = useTelestratorStore((s) => s.arrowLengthRefPx);
  const arrowWidthRefPx = useTelestratorStore((s) => s.arrowWidthRefPx);
  const isHost = useTelestratorStore((s) => s.isHost);
  const allowClientDrawing = useTelestratorStore((s) => s.allowClientDrawing);
  const lastStrokeSummary = useTelestratorStore((s) => s.lastStrokeSummary);

  const updatePreset = useTelestratorStore((s) => s.updatePreset);
  const setArrowSize = useTelestratorStore((s) => s.setArrowSize);
  const setAllowClientDrawing = useTelestratorStore((s) => s.setAllowClientDrawing);
  const triggerDumpLastStroke = useTelestratorStore((s) => s.triggerDumpLastStroke);

  const [copiedJson, setCopiedJson] = useState(false);
  const [dumpedStroke, setDumpedStroke] = useState(false);

  const dividerClass = isLight ? 'border-neutral-200' : 'border-neutral-800';
  const activePreset = presets[activePresetIndex] ?? presets[0];

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

  const handleDumpLastStroke = () => {
    triggerDumpLastStroke();
    setDumpedStroke(true);
    setTimeout(() => setDumpedStroke(false), 1500);
  };

  return (
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
          <span>Line Width (Preset {activePresetIndex + 1})</span>
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
                onChange={(e) => updatePreset(idx, { opacity: Number(e.target.value) / 100 })}
                className="flex-1 accent-amber-400"
              />
            </label>
          );
        })}
      </div>

      {isHost && (
        <div className={`border-t pt-2 flex items-center justify-between ${dividerClass}`}>
          <span className="text-[11px] font-medium">Allow Client Drawing</span>
          <button
            type="button"
            onClick={() => setAllowClientDrawing(!allowClientDrawing)}
            className={`px-2 py-0.5 rounded text-[10px] font-semibold border cursor-pointer ${
              allowClientDrawing
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                : 'bg-neutral-800/70 border-neutral-700 text-neutral-400'
            }`}
          >
            {allowClientDrawing ? 'ON' : 'OFF'}
          </button>
        </div>
      )}

      <div className={`border-t pt-2 flex flex-col gap-1 ${dividerClass}`}>
        <button
          type="button"
          onClick={handleDumpLastStroke}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/15 px-2 py-1 text-[11px] font-medium text-violet-300 hover:bg-violet-500/25 cursor-pointer"
        >
          {dumpedStroke ? <Check className="w-3.5 h-3.5" /> : <Bug className="w-3.5 h-3.5" />}
          {dumpedStroke ? 'Dumped to Clipboard' : 'Dump Last Stroke'}
        </button>
        {lastStrokeSummary && (
          <div className="text-[10px] tabular-nums text-neutral-400 text-center">
            {lastStrokeSummary}
          </div>
        )}
      </div>
    </div>
  );
};
