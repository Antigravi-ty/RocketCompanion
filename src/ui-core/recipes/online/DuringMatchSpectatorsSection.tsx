import React from 'react';
import { Eye, Radio, UserRoundX } from 'lucide-react';
import {
  useSpectateWorkspaceStore,
  type SpectateMode,
  type TelestratorDrawPermission,
} from '../../stores/spectateWorkspaceStore';

export interface SpectatorRouteEntry {
  id: string;
  name: string;
  pingMs: number;
  pairId: string;
  /** Which player this spectator is connected through ('Host (Direct P2P)' or a client player name via Daisy Chain) */
  fromPlayer: string;
  isDirectHost?: boolean;
  isViaLocalClient?: boolean;
}
export interface DuringMatchSpectatorsSectionProps {
  isHost: boolean;
  visibleSpectators: SpectatorRouteEntry[];
  onRemoveSpectator: (id: string) => void;
  onHoverDesc?: (desc: string | null) => void;
  isLight?: boolean;
}

export const DuringMatchSpectatorsSection: React.FC<DuringMatchSpectatorsSectionProps> = ({
  isHost,
  visibleSpectators,
  onRemoveSpectator,
  onHoverDesc,
  isLight = false,
}) => {
  const {
    spectateMode,
    isReadOnlyLocked,
    telestratorPermission,
    setSpectateMode,
    setTelestratorPermission,
  } = useSpectateWorkspaceStore();

  return (
    <div
      data-ui-element="during-match-spectating"
      className="flex flex-col gap-1.5"
      onMouseEnter={() =>
        onHoverDesc?.(
          isHost
            ? 'Spectating (Host Diagnostics): Shows total spectators, upstream routes, and Telestrator drawing permission.'
            : 'Spectating Mode: Choose State Only (main view) or Mirror Workspace (syncs host menus & floating windows with local window positions).'
        )
      }
      onMouseLeave={() => onHoverDesc?.(null)}
    >
      <div className="flex items-center justify-between text-xs font-mono font-semibold text-neutral-400">
        <span className="flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5 text-emerald-400" />
          <span>
            {isHost
              ? `SPECTATING (${visibleSpectators.length} Watching)`
              : `SPECTATING VIA YOU (${visibleSpectators.length} Watching)`}
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          {isHost ? (
            <button
              type="button"
              onClick={() => {
                const next: TelestratorDrawPermission =
                  telestratorPermission === 'host_only' ? 'everyone' : 'host_only';
                setTelestratorPermission(next);
              }}
              className="px-2 py-0.5 rounded text-[10px] font-semibold border border-sky-500/35 bg-sky-500/15 text-sky-400 cursor-pointer"
              title="Toggle Telestrator drawing permission for spectators/clients"
            >
              Draw: {telestratorPermission === 'host_only' ? 'Host Only' : 'Everyone'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const next: SpectateMode =
                  spectateMode === 'spectate_state_only'
                    ? 'spectate_mirror'
                    : 'spectate_state_only';
                setSpectateMode(next);
              }}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold border cursor-pointer ${
                spectateMode === 'spectate_mirror'
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-400'
                  : 'border-emerald-500/35 bg-emerald-500/15 text-emerald-400'
              }`}
              title="Switch between State Only and Mirror Workspace spectating"
            >
              {spectateMode === 'spectate_mirror'
                ? isReadOnlyLocked
                  ? 'Mirror Workspace (Locked)'
                  : 'Mirror Workspace'
                : 'State Only'}
            </button>
          )}
        </div>
      </div>

      <div
        className={`rounded-xl border p-2 flex flex-col gap-1.5 ${
          isLight
            ? 'bg-neutral-50 border-neutral-200/90'
            : 'bg-neutral-900/60 border-neutral-800'
        }`}
      >
        {visibleSpectators.length > 0 ? (
          visibleSpectators.map((spec) => (
            <div
              key={spec.id}
              className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border text-xs font-mono ${
                isLight
                  ? 'bg-white border-neutral-200/90'
                  : 'bg-neutral-950/65 border-neutral-800/90'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Radio
                  className={`h-3.5 w-3.5 shrink-0 ${
                    spec.isDirectHost ? 'text-amber-500' : 'text-emerald-400'
                  }`}
                />
                <span
                  className={`truncate font-semibold ${
                    isLight ? 'text-neutral-800' : 'text-neutral-200'
                  }`}
                >
                  {spec.name}
                </span>
                <span className="text-[10px] text-neutral-400 shrink-0">
                  #{spec.pairId}
                </span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {isHost ? (
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                      spec.isDirectHost
                        ? 'bg-amber-500/15 border-amber-500/40 text-amber-400'
                        : 'bg-sky-500/15 border-sky-500/35 text-sky-400'
                    }`}
                    title={
                      spec.isDirectHost
                        ? 'Direct P2P connection to Host (consumes Host upload bandwidth)'
                        : `Daisy-chained via ${spec.fromPlayer} (zero Host upload overhead)`
                    }
                  >
                    from: {spec.fromPlayer}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
                    via You ({spec.pingMs}ms)
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => onRemoveSpectator(spec.id)}
                  className="inline-flex items-center justify-center p-1 rounded-md border border-rose-500/35 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 cursor-pointer transition-colors"
                  title="Remove spectator"
                  aria-label={`Remove spectator ${spec.name}`}
                >
                  <UserRoundX className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="py-2 text-center text-[11px] font-mono text-neutral-500">
            {isHost
              ? 'No active spectators watching this match.'
              : 'No spectators currently daisy-chained through your client.'}
          </div>
        )}
      </div>
    </div>
  );
};
