import React from 'react';
import { Dumbbell, Mic, PenTool } from 'lucide-react';
import { SettingActionRow } from '../../../compounds/SettingActionRow';
import { SettingToggleRow } from '../../../compounds/SettingToggleRow';
import { telestratorStore, useTelestratorStore } from '../../../stores/telestratorStore';
import { voiceChannelStore, useVoiceChannelStore } from '../../../stores/voiceChannelStore';
import { floatingStore } from '../../../stores/floatingStore';

export interface DeveloperWave1SectionProps {
  isLight?: boolean;
  onHover?: (desc: string) => void;
  onLeave?: () => void;
}

export const DeveloperWave1Section: React.FC<DeveloperWave1SectionProps> = ({
  isLight = false,
  onHover,
  onLeave,
}) => {
  const presets = useTelestratorStore((s) => s.presets);
  const voiceEnabled = useVoiceChannelStore((s) => s.enabled);
  const noiseSuppression = useVoiceChannelStore((s) => s.noiseSuppression);
  const micPermission = useVoiceChannelStore((s) => s.micPermission);
  const activePeerIds = useVoiceChannelStore((s) => s.activePeerIds);
  const peerVolumes = useVoiceChannelStore((s) => s.peerVolumes);

  const openDynamicTrainingEditor = () => {
    const snap = floatingStore.getSnapshot();
    const exists = snap.windows.some((w) => w.id === 'dynamic-training-editor');
    if (!exists) {
      floatingStore.spawnWindow({
        id: 'dynamic-training-editor',
        title: 'Dynamic Training Pack (RCDPack)',
        category: 'DynamicTraining',
        width: 480,
        height: 540,
        startMinimized: false,
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SettingActionRow
        icon={PenTool}
        iconName="pen-tool"
        iconColor="text-amber-400"
        title="Drawing Sandbox (3D Telestrator)"
        description="Spawn 6-car arena, 3D surface ribbon drawing, camera 1-6/7 & POV Direction Adjust"
        actionLabel="Launch"
        onAction={() => telestratorStore.getState().enterDrawingSandbox()}
        hoverDescription="Drawing Sandbox: Enters 6-car arena with vertical Telestrator toolbar, analytical surface drawing, and POV angular offset adjustment."
        onHover={onHover}
        onLeave={onLeave}
        isLight={isLight}
      />

      <div className="px-3 py-2 rounded-lg border border-white/10 bg-zinc-900/40 flex flex-wrap items-center gap-4 text-xs">
        <span className="text-zinc-400 font-medium">Telestrator Preset Widths:</span>
        {presets.map((p) => (
          <label key={p.id} className="flex items-center gap-1.5 text-zinc-300">
            <span>{p.label}</span>
            <input
              type="range"
              min={2}
              max={24}
              value={p.widthPx}
              onChange={(e) =>
                telestratorStore.getState().updatePresetWidth(p.id, Number(e.target.value))
              }
              className="w-16 accent-amber-400 cursor-pointer"
            />
            <span className="w-6 text-right font-mono text-[11px]">{p.widthPx}px</span>
          </label>
        ))}
      </div>

      <SettingToggleRow
        icon={Mic}
        iconName="mic"
        title="WebRTC Voice Channel (Default OFF)"
        description={`Opus + AEC/NS/AGC · Requests mic permission on every enable (Status: ${micPermission})`}
        checked={voiceEnabled}
        onChange={(checked) => voiceChannelStore.getState().setEnabled(checked)}
        hoverDescription="WebRTC Voice Channel: Native RTCPeerConnection audio track with per-PlayerId 0%-250% gain and compressor. Default OFF."
        onHover={(desc) => desc && onHover?.(desc)}
        onLeave={onLeave}
        isLight={isLight}
      />

      {voiceEnabled && (
        <div className="px-3 py-2 rounded-lg border border-white/10 bg-zinc-900/40 flex flex-col gap-2 text-xs">
          <label className="flex items-center justify-between text-zinc-300 cursor-pointer">
            <span>Browser Noise Suppression</span>
            <input
              type="checkbox"
              checked={noiseSuppression}
              onChange={(e) => voiceChannelStore.getState().setNoiseSuppression(e.target.checked)}
              className="accent-sky-400"
            />
          </label>
          {activePeerIds.map((pid) => {
            const vol = peerVolumes[pid] ?? 100;
            return (
              <label key={pid} className="flex items-center justify-between gap-2 text-zinc-300">
                <span className="truncate">Peer {pid}</span>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={250}
                    value={vol}
                    onChange={(e) =>
                      voiceChannelStore.getState().setPeerVolume(pid, Number(e.target.value))
                    }
                    className="w-24 accent-sky-400"
                  />
                  <span className="w-10 text-right font-mono">{vol}%</span>
                </div>
              </label>
            );
          })}
        </div>
      )}

      <SettingActionRow
        icon={Dumbbell}
        iconName="dumbbell"
        iconColor="text-emerald-400"
        title="Dynamic Training Pack (RCDPack)"
        description="4s Replay StateSession capture, Goal/Timeout judge & per-car takeover modes"
        actionLabel="Open Editor"
        onAction={openDynamicTrainingEditor}
        hoverDescription="Dynamic Training Pack: Create RCDPacks, capture 4s StateSessions from replay, duplicate/move/delete sessions, and configure takeover modes."
        onHover={onHover}
        onLeave={onLeave}
        isLight={isLight}
      />
    </div>
  );
};
