import React, { useState } from 'react';
import { Pen, ShieldCheck, UserPlus, X } from 'lucide-react';
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
  const isHost = useTelestratorStore((s) => s.isHost);
  const allowClientDrawing = useTelestratorStore((s) => s.allowClientDrawing);
  const allowedClientIds = useTelestratorStore((s) => s.allowedClientIds);
  const setAllowClientDrawing = useTelestratorStore((s) => s.setAllowClientDrawing);
  const setClientDrawPermission = useTelestratorStore((s) => s.setClientDrawPermission);

  const [playerIdInput, setPlayerIdInput] = useState('');

  const cardClass = isLight
    ? 'bg-neutral-50 border-neutral-200 text-neutral-800'
    : 'bg-neutral-900/50 border-neutral-800 text-neutral-200';
  const inputClass = isLight
    ? 'bg-white border-neutral-300 text-neutral-800'
    : 'bg-neutral-950 border-neutral-700 text-neutral-100';

  const handleToggleOverlay = () => {
    toggleFloatingPreset(TELESTRATOR_TOOLBAR_PRESET);
  };

  const handleGrantPlayer = () => {
    const trimmed = playerIdInput.trim();
    if (!trimmed) return;
    setClientDrawPermission(trimmed, true);
    setPlayerIdInput('');
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

      {isHost && (
        <div className={`rounded-xl border p-2.5 flex flex-col gap-2 text-xs ${cardClass}`}>
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
              Client Drawing Permissions (Host)
            </span>
            <button
              type="button"
              onClick={() => setAllowClientDrawing(!allowClientDrawing)}
              className={`px-2 py-0.5 rounded text-[11px] font-semibold border cursor-pointer ${
                allowClientDrawing
                  ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                  : 'bg-neutral-800/70 border-neutral-700 text-neutral-400'
              }`}
            >
              {allowClientDrawing ? 'All Clients: ON' : 'All Clients: OFF'}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={playerIdInput}
              onChange={(e) => setPlayerIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGrantPlayer();
              }}
              placeholder="Grant Player ID..."
              className={`flex-1 rounded-md border px-2 py-1 text-[11px] outline-none ${inputClass}`}
            />
            <button
              type="button"
              onClick={handleGrantPlayer}
              className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-[11px] font-medium text-sky-400 hover:bg-sky-500/25 cursor-pointer"
            >
              <UserPlus className="w-3 h-3" />
              Grant
            </button>
          </div>

          {allowedClientIds.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {allowedClientIds.map((pid) => (
                <span
                  key={pid}
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300"
                >
                  {pid}
                  <button
                    type="button"
                    onClick={() => setClientDrawPermission(pid, false)}
                    aria-label={`Revoke ${pid}`}
                    className="hover:text-rose-300 cursor-pointer"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
