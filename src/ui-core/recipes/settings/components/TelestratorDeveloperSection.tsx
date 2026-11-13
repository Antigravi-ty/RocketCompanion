import React from 'react';
import { Pen } from 'lucide-react';
import { SettingActionRow } from '../../../compounds/SettingActionRow';
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
  const presets = useTelestratorStore((s) => s.presets);
  const updatePreset = useTelestratorStore((s) => s.updatePreset);
  const startSandbox = useTelestratorStore((s) => s.runtimeHandlers.onStartDrawingSandbox);

  const cardClass = isLight
    ? 'bg-neutral-50 border-neutral-200 text-neutral-800'
    : 'bg-neutral-900/50 border-neutral-800 text-neutral-200';
  const labelMuted = isLight ? 'text-neutral-500' : 'text-neutral-400';

  return (
    <div className="flex flex-col gap-2">
      <SettingActionRow
        icon={Pen}
        iconColor={isLight ? 'text-emerald-600' : 'text-emerald-400'}
        title="Drawing Sandbox (3D Telestrator)"
        description="Spawn 6-car kickoff arena, open vertical telestrator toolbar & camera POV/Direction Adjust"
        hoverDescription="Drawing Sandbox: Spawns 6 cars (Keys 1-6 POV, Key 7 Free Cam, Key C Cycle), opens the vertical Telestrator toolbar, and enables surface-hugging 3D drawing."
        onAction={() => startSandbox?.()}
        onHover={onHover}
        onLeave={onLeave}
        isLight={isLight}
      />

      <div className={`rounded-xl border p-2.5 flex flex-col gap-2 text-xs ${cardClass}`}>
        <div className="font-semibold">Telestrator Brush Presets (Opacity &amp; Screen Width)</div>
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
                  className="w-full accent-sky-400"
                />
              </label>
              <label className="flex items-center gap-1.5 flex-1">
                <span className={`text-[11px] w-12 ${labelMuted}`}>{preset.widthPx}px</span>
                <input
                  type="range"
                  min={2}
                  max={32}
                  step={1}
                  value={preset.widthPx}
                  onChange={(e) => updatePreset(idx, { widthPx: Number(e.target.value) })}
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
