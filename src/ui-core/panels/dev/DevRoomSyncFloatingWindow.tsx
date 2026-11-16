import React from 'react';
import { Copy, Check, Radio, ShieldCheck, ShieldOff, RefreshCw, LogOut } from 'lucide-react';
import type { StandardSurfaceProps, SurfaceMeta } from '../../manifest/surfaceMetaTypes';
import { useAppStore } from '../../stores/appStore';
import { useSpectateWorkspaceStore } from '../../stores/spectateWorkspaceStore';
import { ToggleSwitch } from '../../primitives/ToggleSwitch';

export const SURFACE_META: SurfaceMeta = {
  id: 'dev-room-sync',
  title: 'Developer Sync Room',
  subtitle: 'Pure CSR Sync All',
  description:
    'Pure CSR Sync All host control panel: room status, workspace mirroring, client input gating, telestrator permissions, and arena preset sync.',
  icon: 'users-round-collaboration',
  iconColor: 'text-emerald-500 dark:text-emerald-400',
  layer: 'floating-dev',
  menuGroup: 'sandboxes',
  hideFooter: false,
  defaultSizing: {
    width: 440,
    minWidth: 360,
    height: 480,
    minHeight: 280,
    mode: 'adaptive',
  },
};

export interface DevRoomSyncFloatingWindowProps extends StandardSurfaceProps {
  active?: boolean;
}

export const DevRoomSyncFloatingWindow: React.FC<DevRoomSyncFloatingWindowProps> = ({
  isLight = false,
}) => {
  const onlineSession = useAppStore((s) => s.onlineSession);
  const underDev = useAppStore((s) => s.underDevelopment);
  const updateUnderDev = useAppStore((s) => s.updateUnderDevelopment);
  const bridge = useAppStore((s) => s.bridge);

  const {
    clientInputEnabled,
    followHostWorkspace,
    telestratorPermission,
    arenaPreset,
    setClientInputEnabled,
    setFollowHostWorkspace,
    setTelestratorPermission,
    setArenaPreset,
  } = useSpectateWorkspaceStore();

  const [copiedRoom, setCopiedRoom] = React.useState(false);
  const isHosting = Boolean(onlineSession?.isHosting);
  const roomId = onlineSession?.roomId || '—';
  const peersCount = onlineSession?.connectedPeers?.length ?? 0;
  const activeActivity = onlineSession?.activeRoomActivity || 'freeplay';
  const currentArena: 'standard' | 'throwback' =
    underDev?.stadiumPreset === 'throwback' || arenaPreset === 'throwback'
      ? 'throwback'
      : 'standard';

  const broadcastNow = (overrides?: Record<string, unknown>) => {
    bridge.onBroadcastGlobalWorkspace?.({
      clientInputEnabled,
      followHostWorkspace,
      telestratorPermission,
      arenaPreset: currentArena,
      ...(overrides ?? {}),
    });
  };

  const handleCopyRoomId = async () => {
    if (!onlineSession?.roomId) return;
    try {
      await navigator.clipboard.writeText(onlineSession.roomId);
      setCopiedRoom(true);
      setTimeout(() => setCopiedRoom(false), 1500);
    } catch {
      // Clipboard may be unavailable in headless environments
    }
  };

  return (
    <div className="flex flex-col gap-3 h-full select-none text-xs overflow-y-auto pr-0.5">
      {/* Room Status Header */}
      <div
        className={`p-2.5 rounded-xl border flex items-center justify-between gap-2 ${
          isHosting
            ? isLight
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
            : isLight
              ? 'bg-neutral-100 border-neutral-300 text-neutral-700'
              : 'bg-neutral-900/70 border-neutral-700 text-neutral-300'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Radio className="w-4 h-4 shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="font-bold truncate">
              {isHosting ? `HOSTING · ${roomId}` : 'NOT HOSTING'}
            </span>
            <span className="text-[11px] opacity-80 truncate">
              Activity: {activeActivity} · Peers: {peersCount} ·{' '}
              {onlineSession?.signalingConnected ? 'Signaling OK' : 'Offline'}
            </span>
          </div>
        </div>
        {isHosting && onlineSession?.roomId && (
          <button
            type="button"
            onClick={handleCopyRoomId}
            className={`px-2 py-1 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer ${
              isLight
                ? 'bg-white border-emerald-300 text-emerald-800 hover:bg-emerald-100'
                : 'bg-emerald-900/40 border-emerald-500/40 text-emerald-200 hover:bg-emerald-900/70'
            }`}
          >
            {copiedRoom ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            <span>{copiedRoom ? 'Copied' : 'Copy Code'}</span>
          </button>
        )}
      </div>

      {/* Pure CSR Sync All Controls */}
      <div
        className={`p-3 rounded-xl border flex flex-col gap-3 ${
          isLight
            ? 'bg-white border-neutral-200 text-neutral-800'
            : 'bg-neutral-900/50 border-neutral-800 text-neutral-200'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <span className="font-semibold">Follow Host Workspace (Mirror UI)</span>
            <span className="text-[11px] opacity-70">
              Auto-mirrors Host menu route & floating windows on Clients
            </span>
          </div>
          <ToggleSwitch
            checked={followHostWorkspace}
            onCheckedChange={(checked) => {
              setFollowHostWorkspace(checked);
              broadcastNow({ followHostWorkspace: checked });
            }}
            isLight={isLight}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {clientInputEnabled ? (
              <ShieldOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            ) : (
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            )}
            <div className="flex flex-col">
              <span className="font-semibold">Allow Client Driving Input</span>
              <span className="text-[11px] opacity-70">
                {clientInputEnabled
                  ? 'Clients can drive cars (Interactive mode)'
                  : 'Pure CSR: Client inputs zeroed on Client & Host'}
              </span>
            </div>
          </div>
          <ToggleSwitch
            checked={clientInputEnabled}
            onCheckedChange={(checked) => {
              setClientInputEnabled(checked);
              if (bridge.onSetClientInputEnabled) {
                bridge.onSetClientInputEnabled(checked);
              } else {
                broadcastNow({ clientInputEnabled: checked });
              }
            }}
            isLight={isLight}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <span className="font-semibold">Telestrator Drawing (Everyone)</span>
            <span className="text-[11px] opacity-70">
              Permission: {telestratorPermission === 'everyone' ? 'Everyone' : 'Host Only'}
            </span>
          </div>
          <ToggleSwitch
            checked={telestratorPermission === 'everyone'}
            onCheckedChange={(checked) => {
              const next = checked ? 'everyone' : 'host_only';
              setTelestratorPermission(next);
              broadcastNow({ telestratorPermission: next });
            }}
            isLight={isLight}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <span className="font-semibold">Arena Preset Sync</span>
            <span className="text-[11px] opacity-70">
              Synchronizes Standard / Throwback Stadium preset
            </span>
          </div>
          <div className="flex items-center gap-1">
            {(['standard', 'throwback'] as const).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  setArenaPreset(preset);
                  updateUnderDev({ stadiumPreset: preset });
                  broadcastNow({ arenaPreset: preset });
                }}
                className={`px-2 py-1 rounded-lg border text-[11px] font-semibold capitalize cursor-pointer ${
                  currentArena === preset
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                    : isLight
                      ? 'bg-neutral-100 border-neutral-300 text-neutral-700'
                      : 'bg-neutral-800 border-neutral-700 text-neutral-300'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        {/* Room Activity Mode Switcher */}
        <div className="flex flex-col gap-1.5 pt-1 border-t border-neutral-500/20">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Room Activity Mode</span>
            {activeActivity === 'multiplayer_training' && (
              <button
                type="button"
                disabled={!isHosting}
                onClick={() => bridge.onResetTrainingShot?.({})}
                className="px-2 py-0.5 rounded-md border text-[11px] font-semibold bg-amber-500/20 border-amber-500/40 text-amber-300 hover:bg-amber-500/30 cursor-pointer disabled:opacity-40"
              >
                Reset Shot
              </button>
            )}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {(
              [
                { id: 'freeplay', label: 'Freeplay' },
                { id: 'multiplayer_training', label: 'Training' },
                { id: 'replay', label: 'Replay' },
                { id: 'match', label: 'Match' },
              ] as const
            ).map((act) => (
              <button
                key={act.id}
                type="button"
                disabled={!isHosting}
                onClick={() => {
                  if (act.id === 'match') {
                    setClientInputEnabled(true);
                    bridge.onSwitchRoomActivity?.({
                      activityId: 'match',
                      stateSummary: { autoPullConnectedPeers: true, clientInputEnabled: true },
                    });
                  } else {
                    bridge.onSwitchRoomActivity?.({ activityId: act.id });
                  }
                }}
                className={`px-1.5 py-1 rounded-lg border text-[11px] font-semibold cursor-pointer disabled:opacity-40 ${
                  activeActivity === act.id
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                    : isLight
                      ? 'bg-neutral-100 border-neutral-300 text-neutral-700'
                      : 'bg-neutral-800 border-neutral-700 text-neutral-300'
                }`}
              >
                {act.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 mt-auto">
        <button
          type="button"
          onClick={() => broadcastNow()}
          disabled={!isHosting}
          className={`flex-1 py-2 px-3 rounded-xl border font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40 ${
            isLight
              ? 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700'
              : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30'
          }`}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Broadcast Sync Now</span>
        </button>
        {(isHosting || (onlineSession?.isDevSyncRoom && Boolean(onlineSession?.roomId))) && (
          <button
            type="button"
            onClick={() => {
              void bridge.onLeaveOnlineServer?.();
            }}
            className={`py-2 px-3 rounded-xl border font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer ${
              isLight
                ? 'bg-rose-50 text-rose-700 border-rose-300 hover:bg-rose-100'
                : 'bg-rose-500/15 text-rose-300 border-rose-500/40 hover:bg-rose-500/25'
            }`}
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{isHosting ? 'Stop Room' : 'Leave Sync Room'}</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default DevRoomSyncFloatingWindow;
