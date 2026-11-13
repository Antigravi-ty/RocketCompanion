import React from 'react';
import { Mic } from 'lucide-react';
import { SettingToggleRow } from '../../../compounds/SettingToggleRow';
import { voiceChannelStore, useVoiceChannelStore } from '../../../stores/voiceChannelStore';

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
  const voiceEnabled = useVoiceChannelStore((s) => s.enabled);
  const noiseSuppression = useVoiceChannelStore((s) => s.noiseSuppression);
  const micPermission = useVoiceChannelStore((s) => s.micPermission);
  const activePeerIds = useVoiceChannelStore((s) => s.activePeerIds);
  const peerVolumes = useVoiceChannelStore((s) => s.peerVolumes);

  return (
    <div className="flex flex-col gap-2">
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
    </div>
  );
};
