import React, { useState } from 'react';
import { Check, Copy, Pen } from 'lucide-react';
import { SettingActionRow } from '../../../compounds/SettingActionRow';
import { TELESTRATOR_TOOLBAR_PRESET } from '../../../stores/devFloatingPresets';
import { toggleFloatingPreset } from '../../../stores/floatingStore';
import { useTelestratorStore } from '../../../stores/telestratorStore';

export interface TelestratorDeveloperSectionProps {
  isLight?: boolean;
  onHover?: (desc: string) => void;
  onLeave?: () => void;
}

export const TelestratorDeveloperSection: React.FC<TelestratorDeveloperSectionProps> = ({
  isLight = false,
  onHover,
  onLeave,
}) => {
  const overlayActive = useTelestratorStore((s) => s.overlayActive);
  const presets = useTelestratorStore((s) => s.presets);
  const arrowLengthRefPx = useTelestratorStore((s) => s.arrowLengthRefPx);
  const arrowWidthRefPx = useTelestratorStore((s) => s.arrowWidthRefPx);
  const updatePreset = useTelestratorStore((s) => s.updatePreset);
  const setArrowSize = useTelestratorStore((s) => s.setArrowSize);
  const [copiedJson, setCopiedJson] = useState(false);

  const cardClass = isLight
    ? 'bg-neutral-50 border-neutral-200 text-neutral-800'
    : 'bg-neutral-900/50 border-neutral-800 text-neutral-200';
  const labelMuted = isLight ? 'text-neutral-500' : 'text-neutral-400';

  const handleToggleOverlay = () => {
    toggleFloatingPreset(TELESTRATOR_TOOLBAR_PRESET);
  };

  const handleCopyJson = () => {
    const payload = {
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
    <div className="flex flex-col gap-2">
      <SettingActionRow
        icon={Pen}
        iconColor={isLight ? 'text-emerald-600' : 'text-emerald-400'}
        title={overlayActive ? '3D Telestrator Overlay (Active)' : '3D Telestrator Overlay'}
        description="Toggle functional 3D drawing & POV Direction Adjust overlay on top of Replay, Training, or Freeplay"
        hoverDescription="3D Telestrator Overlay: Mode-independent functional override. Opens the vertical Telestrator toolbar on any active mode without replacing physics or match state."
        onAction={handleToggleOverlay}
        onHover={onHover}
        onLeave={onLeave}
        isLight={isLight}
      />

      <div className={`rounded-xl border p-2.5 flex flex-col gap-2 text-xs ${cardClass}`}>
        <div className="flex items-center justify-between">
          <span className="font-semibold">Telestrator Brush Presets (1080p Ref Px)</span>
          <button
            type="button"
            onClick={handleCopyJson}
            className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-400 hover:bg-sky-500/25 cursor-pointer"
          >
            {copiedJson ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copiedJson ? 'Copied JSON' : 'Copy JSON'}
          </button>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className={`w-20 font-medium ${labelMuted}`}>Arrowhead</span>
          <label className="flex items-center gap-1.5 flex-1">
            <span className={`text-[11px] w-16 ${labelMuted}`}>L: {arrowLengthRefPx} px</span>
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
          <label className="flex items-center gap-1.5 flex-1">
            <span className={`text-[11px] w-16 ${labelMuted}`}>W: {arrowWidthRefPx} px</span>
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
        </div>

        {([0, 1, 2] as const).map((idx) => {
          const preset = presets[idx];
          const opacityPct = Math.round(preset.opacity * 100);
          return (
            <div key={preset.id} className="flex items-center justify-between gap-3">
              <span className={`w-20 font-medium ${labelMuted}`}>Preset {idx + 1}</span>
              <label className="flex items-center gap-1.5 flex-1">
                <span className={`text-[11px] w-14 ${labelMuted}`}>{opacityPct}%</span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={opacityPct}
                  onChange={(e) =>
                    updatePreset(idx, { opacity: Number(e.target.value) / 100 })
                  }
                  className="w-full accent-amber-400"
                />
              </label>
              <label className="flex items-center gap-1.5 flex-1">
                <span className={`text-[11px] w-14 ${labelMuted}`}>{preset.widthRefPx} px</span>
                <input
                  type="range"
                  min={3}
                  max={48}
                  step={1}
                  value={preset.widthRefPx}
                  onChange={(e) => updatePreset(idx, { widthRefPx: Number(e.target.value) })}
                  className="w-full accent-emerald-400"
                />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
};
