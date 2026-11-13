import React from 'react';
import { Mic, MicOff, Volume2, VolumeX, ShieldCheck, Radio, Sliders, Users } from 'lucide-react';
import { SettingToggleRow } from '../../../compounds/SettingToggleRow';
import { SettingSliderRow } from '../../../compounds/SettingSliderRow';
import { SettingActionRow } from '../../../compounds/SettingActionRow';
import { SettingSegmentedRow } from '../../../compounds/SettingSegmentedRow';
import { useSettingActionRowStore } from '../../../stores/settingRowStore';
import { useVoiceChatStore } from '../../../stores/voiceChatStore';
import {
  VOICE_VOLUME_MIN_PCT,
  VOICE_VOLUME_MAX_PCT,
  type VoiceChatRoomMode,
} from '../../../config/voiceChatConfig';

export interface VoiceChatSettingsSectionProps {
  bordered?: boolean;
  onHover?: (desc: string) => void;
  onLeave?: () => void;
  isLight?: boolean;
}

const VOICE_ROOM_MODE_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'team_only', label: 'Team Only' },
  { value: 'off', label: 'Off' },
];

export const VoiceChatSettingsSection: React.FC<VoiceChatSettingsSectionProps> = React.memo(
  ({ bordered, onHover, onLeave, isLight = false }) => {
    const {
      enabled,
      micMuted,
      roomVoiceMode,
      isLobbyPhase,
      permissionState,
      permissionError,
      audioStatusMessage,
      echoCancellation,
      noiseSuppression,
      autoGainControl,
      masterVoiceVolumePct,
      outputLimiterEnabled,
      localMicLevel01,
      peers,
      setVoiceEnabled,
      setMicMuted,
      setRoomVoicePolicy,
      updateInputProcessing,
      setMasterVoiceVolumePct,
      setOutputLimiterEnabled,
      setPlayerVolumePct,
      setPlayerMuted,
    } = useVoiceChatStore();

    const { rowGap, borderRadius, paddingX } = useSettingActionRowStore();
    const rowBordered = bordered ?? false;

    const statusDescription =
      permissionState === 'requesting'
        ? 'Requesting microphone permission from browser...'
        : permissionState === 'denied'
          ? `Permission denied: ${permissionError ?? 'Microphone access unavailable'}`
          : audioStatusMessage
            ? audioStatusMessage
            : enabled
              ? 'Active (WebRTC Opus track attached; unified VoiceMasterOutputBus playback)'
              : 'Disabled by default. Enable to request microphone permission and join WebRTC voice.';

    return (
      <div
        data-ui-element="voice-chat-settings-section"
        className="flex flex-col w-full"
        style={{ gap: `${rowGap}px` }}
      >
        <SettingSegmentedRow
          icon={Users}
          title="Room Voice Chat Mode"
          description={
            roomVoiceMode === 'team_only'
              ? isLobbyPhase
                ? 'Team Only (Lobby override: all players can talk during Lobby)'
                : 'Team Only (Restricted to teammates during active match)'
              : roomVoiceMode === 'off'
                ? 'Off (Microphone capture and remote voice playback disabled)'
                : 'Open (All players in room can communicate)'
          }
          value={roomVoiceMode}
          options={VOICE_ROOM_MODE_OPTIONS}
          onChange={(val: string) => setRoomVoicePolicy(val as VoiceChatRoomMode)}
          bordered={rowBordered}
          onHover={(desc) => desc && onHover?.(desc)}
          onLeave={onLeave}
          isLight={isLight}
        />

        <SettingToggleRow
          icon={enabled ? Mic : MicOff}
          title="WebRTC Voice Chat"
          description={statusDescription}
          hoverDescription="WebRTC Voice Chat: Disabled by default. Toggling ON explicitly requests microphone permission and attaches an Opus audio track to active peer connections."
          checked={enabled}
          disabled={roomVoiceMode === 'off'}
          onChange={(next) => {
            void setVoiceEnabled(next);
          }}
          bordered={rowBordered}
          onHover={(desc) => desc && onHover?.(desc)}
          onLeave={onLeave}
          isLight={isLight}
        />

        {enabled && (
          <>
            <SettingToggleRow
              icon={micMuted ? MicOff : Mic}
              title="Mute Local Microphone"
              description={`Input level: ${Math.round(localMicLevel01 * 100)}%`}
              hoverDescription="Mute Local Microphone: Temporarily disables outbound audio track transmission without releasing microphone capture."
              checked={micMuted}
              onChange={setMicMuted}
              bordered={rowBordered}
              onHover={(desc) => desc && onHover?.(desc)}
              onLeave={onLeave}
              isLight={isLight}
            />

            <div
              className={`w-full px-4 py-2 border ${
                isLight
                  ? 'bg-neutral-100/70 border-neutral-200/80'
                  : 'bg-white/[0.03] border-white/10'
              }`}
              style={{
                borderRadius: `${borderRadius}px`,
                paddingLeft: `${paddingX}px`,
                paddingRight: `${paddingX}px`,
              }}
            >
              <div className="flex items-center justify-between text-[11px] mb-1 opacity-80">
                <span>Live Microphone Input Level</span>
                <span>{micMuted ? 'MUTED' : `${Math.round(localMicLevel01 * 100)}%`}</span>
              </div>
              <div
                className={`h-1.5 w-full rounded-full overflow-hidden ${
                  isLight ? 'bg-neutral-300' : 'bg-white/10'
                }`}
              >
                <div
                  className="h-full bg-emerald-400 transition-all duration-75"
                  style={{ width: `${Math.min(100, Math.round(localMicLevel01 * 100))}%` }}
                />
              </div>
            </div>
          </>
        )}

        <SettingToggleRow
          icon={Radio}
          title="Input Noise Suppression (WebRTC NS)"
          description="Browser-native WebRTC input noise suppression"
          hoverDescription="Input Noise Suppression: Enables WebRTC built-in noiseSuppression constraint on microphone capture."
          checked={noiseSuppression}
          onChange={(next) => {
            void updateInputProcessing({ noiseSuppression: next });
          }}
          bordered={rowBordered}
          onHover={(desc) => desc && onHover?.(desc)}
          onLeave={onLeave}
          isLight={isLight}
        />

        <SettingToggleRow
          icon={ShieldCheck}
          title="Echo Cancellation & Auto Gain (AEC / AGC)"
          description="Prevents speaker bleed and normalizes quiet microphones"
          hoverDescription="Echo Cancellation & Auto Gain: Enables WebRTC echoCancellation and autoGainControl constraints."
          checked={echoCancellation && autoGainControl}
          onChange={(next) => {
            void updateInputProcessing({ echoCancellation: next, autoGainControl: next });
          }}
          bordered={rowBordered}
          onHover={(desc) => desc && onHover?.(desc)}
          onLeave={onLeave}
          isLight={isLight}
        />

        <SettingSliderRow
          icon={Volume2}
          title="Voice Output Master Gain"
          description="Supports 0% to 250% boost via Web Audio GainNode"
          hoverDescription="Voice Output Master Gain: Amplifies or attenuates all incoming WebRTC voice channels (0% - 250%)."
          value={masterVoiceVolumePct}
          min={VOICE_VOLUME_MIN_PCT}
          max={VOICE_VOLUME_MAX_PCT}
          step={1}
          unit="%"
          onChange={setMasterVoiceVolumePct}
          bordered={rowBordered}
          onHover={(desc) => desc && onHover?.(desc)}
          onLeave={onLeave}
          isLight={isLight}
        />

        <SettingToggleRow
          icon={Sliders}
          title="Output Safety Limiter"
          description="Prevents clipping when boosting player voice above 100%"
          hoverDescription="Output Safety Limiter: Engages a DynamicsCompressorNode safety ceiling before AudioContext.destination."
          checked={outputLimiterEnabled}
          onChange={setOutputLimiterEnabled}
          bordered={rowBordered}
          onHover={(desc) => desc && onHover?.(desc)}
          onLeave={onLeave}
          isLight={isLight}
        />

        {peers.length === 0 ? (
          <SettingActionRow
            icon={Volume2}
            title="Per-Player Voice Mix"
            description="No connected peers in session. Connected players appear here with 0%-250% individual volume controls."
            hoverDescription="Per-Player Voice Mix: Adjust individual peer voice volumes (0% - 250%). Registered account IDs are persisted and synced to your cloud profile."
            actionLabel="0 Peers"
            showButtonArrow={false}
            bordered={rowBordered}
            onAction={() => {}}
            onHover={(desc) => desc && onHover?.(desc)}
            onLeave={onLeave}
            isLight={isLight}
          />
        ) : (
          peers.map((peer) => {
            const levelPct = Math.min(100, Math.round(peer.audioLevel01 * 100));
            const statusText = peer.gatedByRoomMode
              ? 'Gated by room voice mode'
              : peer.muted
                ? 'Muted locally'
                : peer.hasRemoteAudio
                  ? `Voice active (${levelPct}%)`
                  : 'In room (voice off or awaiting track)';
            const idBadge = peer.isRegistered ? 'Registered' : 'Guest';
            return (
              <div
                key={peer.peerId}
                className="flex flex-col w-full"
                style={{ gap: `${rowGap}px` }}
              >
                <SettingSliderRow
                  icon={peer.muted || peer.gatedByRoomMode ? VolumeX : Volume2}
                  title={`${peer.displayName} (${idBadge}: ${peer.playerId})`}
                  description={`${statusText} · ${
                    peer.isRegistered
                      ? 'Synced to cloud profile by registered Player ID'
                      : 'Session-only mix'
                  }`}
                  value={peer.volumePct}
                  min={VOICE_VOLUME_MIN_PCT}
                  max={VOICE_VOLUME_MAX_PCT}
                  step={1}
                  unit="%"
                  onChange={(val) =>
                    setPlayerVolumePct(peer.peerId, peer.playerId, peer.isRegistered, val)
                  }
                  actionSlot={
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-12 h-1.5 rounded-full overflow-hidden ${
                          isLight ? 'bg-neutral-300' : 'bg-white/10'
                        }`}
                        title={statusText}
                      >
                        <div
                          className={`h-full transition-all duration-75 ${
                            peer.hasRemoteAudio && !peer.muted && !peer.gatedByRoomMode
                              ? 'bg-emerald-400'
                              : 'bg-neutral-500/40'
                          }`}
                          style={{
                            width: `${peer.muted || peer.gatedByRoomMode ? 0 : levelPct}%`,
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setPlayerMuted(peer.peerId, peer.playerId, peer.isRegistered, !peer.muted)
                        }
                        className={`px-2 py-0.5 text-[11px] rounded border cursor-pointer ${
                          peer.muted
                            ? 'border-rose-400/50 text-rose-300 bg-rose-500/15'
                            : isLight
                              ? 'border-neutral-300 text-neutral-700'
                              : 'border-white/15 text-neutral-300'
                        }`}
                      >
                        {peer.muted ? 'Muted' : 'Mute'}
                      </button>
                    </div>
                  }
                  bordered={rowBordered}
                  onHover={(desc) => desc && onHover?.(desc)}
                  onLeave={onLeave}
                  isLight={isLight}
                />
              </div>
            );
          })
        )}
      </div>
    );
  }
);

VoiceChatSettingsSection.displayName = 'VoiceChatSettingsSection';
