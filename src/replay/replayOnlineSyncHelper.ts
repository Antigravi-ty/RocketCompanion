/**
 * src/replay/replayOnlineSyncHelper.ts
 * Helpers for streaming StandaloneReplayViewerController state, pause/seek heartbeats,
 * and Host camera state into AuthoritativeServerHost & MultiplayerSessionManager.
 */

import {
  buildHostWorkspaceBroadcastPayload,
  captureCameraSyncFromPort,
  hudStore,
  useAppStore,
  useReplayViewerStore,
} from '../game/runtimeUiPort.ts';
import {
  getPauseHeartbeatIntervalMs,
  type WorkspaceReplaySyncPayload,
} from '../network/protocol/GlobalWorkspaceProtocol.ts';
import { sharedAuthorityCameraSyncTracker } from '../game/pipeline/stages/AuthorityCameraSyncTracker.ts';

import type { ReplayTakeoverRuntimePort } from './ReplayTakeoverSubController.ts';

export interface ReplayOnlineRuntimePort {
  physics?: {
    saveCompactState?: () => Float32Array | null;
    getHeaderView?: () => { tickCount?: number } | null;
  } | null;
  camera?: {
    resetView?: () => void;
    isFreeCam?: boolean;
    ballCam?: boolean;
    focusedCarIndex?: number;
    getFreeCamStateSnapshot?: () => {
      eyeThreeJs?: [number, number, number];
      targetThreeJs?: [number, number, number];
    } | null;
  } | null;
  authoritativeServer?: ReplayTakeoverRuntimePort['authoritativeServer'];
  multiplayerSession?: {
    isHosting?: boolean;
    broadcastRoomActivitySwitch?: (opts: {
      activityId: string;
      mode?: string;
      replayId?: string;
      config?: Record<string, unknown>;
    }) => unknown;
    broadcastGlobalWorkspace?: (payload: Record<string, unknown>) => number;
  } | null;
}

export interface ReplayOnlineWorkspaceSyncOptions {
  active: boolean;
  playbackPaused: boolean;
  pausedAtTick: number;
  switchActivity?: boolean;
  replayId?: string;
  replaySync?: Partial<WorkspaceReplaySyncPayload>;
}

export function syncReplayFrameToAuthoritativeServer(
  runtime: ReplayOnlineRuntimePort | null | undefined,
  tickOverride?: number
): void {
  const server = runtime?.authoritativeServer;
  if (!server) return;
  const snap = runtime?.physics?.saveCompactState?.() ?? null;
  if (!snap) return;
  if (
    typeof (server as { pushBroadcastSnapshot?: (s: Float32Array, t: number) => void })
      .pushBroadcastSnapshot === 'function'
  ) {
    const tick =
      typeof tickOverride === 'number' && Number.isFinite(tickOverride)
        ? Math.max(0, Math.round(tickOverride))
        : Math.max(
            0,
            Math.round(
              Number(snap[0]) || Number(runtime?.physics?.getHeaderView?.()?.tickCount) || 0
            )
          );
    (server as { pushBroadcastSnapshot: (s: Float32Array, t: number) => void }).pushBroadcastSnapshot(
      snap,
      tick
    );
    return;
  }
  if (typeof server.enterStateOnlyMode === 'function') {
    const tick =
      typeof tickOverride === 'number' && Number.isFinite(tickOverride)
        ? Math.max(0, Math.round(tickOverride))
        : Math.max(
            0,
            Math.round(
              Number(snap[0]) || Number(runtime?.physics?.getHeaderView?.()?.tickCount) || 0
            )
          );
    server.enterStateOnlyMode(snap, tick);
    return;
  }
  if (server.sim?.restoreState) {
    void server.sim.restoreState(snap);
  }
}

export function syncReplayWorkspaceToOnlineRoom(
  runtime: ReplayOnlineRuntimePort | null | undefined,
  opts: ReplayOnlineWorkspaceSyncOptions
): number {
  const session = runtime?.multiplayerSession;
  if (!session?.isHosting) return 0;

  const rvStore = useReplayViewerStore?.getState?.();
  const hudState = hudStore?.getState?.();
  const rawCam = runtime?.camera
    ? captureCameraSyncFromPort(runtime.camera, opts.active)
    : undefined;
  const focusedCarIndex =
    opts.replaySync?.focusedCarIndex ??
    (rawCam && typeof rawCam.focusedCarIndex === 'number' ? rawCam.focusedCarIndex : undefined) ??
    rvStore?.activePovCarIndex;
  const blueScore =
    opts.replaySync?.blueScore ??
    (typeof hudState?.blueScore === 'number' ? hudState.blueScore : undefined);
  const orangeScore =
    opts.replaySync?.orangeScore ??
    (typeof hudState?.orangeScore === 'number' ? hudState.orangeScore : undefined);
  const remainingSeconds =
    opts.replaySync?.remainingSeconds ??
    (typeof hudState?.remainingSeconds === 'number' ? hudState.remainingSeconds : undefined);
  const isOvertime =
    opts.replaySync?.isOvertime ??
    (typeof hudState?.isOvertime === 'boolean' ? hudState.isOvertime : undefined);
  const overtimeSeconds =
    opts.replaySync?.overtimeSeconds ??
    (typeof hudState?.overtimeSeconds === 'number' ? hudState.overtimeSeconds : undefined);
  const matchPhase =
    opts.replaySync?.matchPhase ??
    (typeof hudState?.matchPhase === 'string' ? hudState.matchPhase : undefined);
  const localTeam: 0 | 1 | undefined =
    opts.replaySync?.localTeam ??
    (hudState?.localTeam === 1 ? 1 : hudState?.localTeam === 0 ? 0 : undefined);
  const replaySync: WorkspaceReplaySyncPayload | undefined = opts.active
    ? {
        fileName: opts.replaySync?.fileName ?? opts.replayId ?? rvStore?.loadedFileName ?? undefined,
        totalFrames: opts.replaySync?.totalFrames ?? rvStore?.totalFrames ?? 0,
        currentFrame:
          opts.replaySync?.currentFrame ??
          rvStore?.cursorFrame ??
          Math.max(0, Math.round(opts.pausedAtTick || 0)),
        playbackState:
          opts.replaySync?.playbackState ?? (opts.playbackPaused ? 'paused' : 'playing'),
        flowPct: opts.replaySync?.flowPct ?? rvStore?.effectiveFlowPct ?? 100,
        ...(typeof focusedCarIndex === 'number' ? { focusedCarIndex } : {}),
        ...(typeof blueScore === 'number' ? { blueScore } : {}),
        ...(typeof orangeScore === 'number' ? { orangeScore } : {}),
        ...(typeof remainingSeconds === 'number' ? { remainingSeconds } : {}),
        ...(typeof isOvertime === 'boolean' ? { isOvertime } : {}),
        ...(typeof overtimeSeconds === 'number' ? { overtimeSeconds } : {}),
        ...(typeof matchPhase === 'string' ? { matchPhase } : {}),
        ...(localTeam !== undefined ? { localTeam } : {}),
        ...(opts.replaySync?.roster
          ? { roster: opts.replaySync.roster }
          : Array.isArray(rvStore?.resolvedRoster) && rvStore.resolvedRoster.length > 0
            ? {
                roster: rvStore.resolvedRoster.map((r) => ({
                  carIndex: r.carIndex,
                  name: r.name || `Car ${r.carIndex + 1}`,
                  team: (r.team === 1 ? 1 : 0) as 0 | 1,
                  ...(typeof r.isBot === 'boolean' ? { isBot: r.isBot } : {}),
                })),
              }
            : {}),
      }
    : undefined;

  if (opts.switchActivity) {
    if (opts.active) {
      sharedAuthorityCameraSyncTracker.bumpLocalSeq();
    }
    const activityId = opts.active ? 'replay' : 'freeplay';
    useAppStore.getState().setOnlineSession?.({ activeRoomActivity: activityId });
    session.broadcastRoomActivitySwitch?.({
      activityId,
      mode: activityId,
      ...(opts.replayId ? { replayId: opts.replayId } : {}),
      config: {
        playbackPaused: Boolean(opts.playbackPaused),
        pausedAtTick: Math.max(0, Math.round(opts.pausedAtTick || 0)),
        ...(replaySync ? { replaySync } : {}),
      },
    });
  }

  const cameraSync = rawCam
    ? {
        ...rawCam,
        cameraSyncSeq: sharedAuthorityCameraSyncTracker.getCurrentSeq(),
        authorityPeerId: 'host',
      }
    : undefined;
  const payload = buildHostWorkspaceBroadcastPayload({
    playbackPaused: Boolean(opts.playbackPaused),
    pausedAtTick: Math.max(0, Math.round(opts.pausedAtTick || 0)),
    ...(cameraSync ? { cameraSync } : {}),
    ...(replaySync ? { replaySync } : {}),
  });
  if (!payload) return 0;
  return session.broadcastGlobalWorkspace?.(payload) ?? 0;
}

export class ReplayOnlineHeartbeatTracker {
  private lastSyncMs = 0;
  private lastCameraKey = '';
  private lastHudKey = '';

  public reset(): void {
    this.lastSyncMs = 0;
    this.lastCameraKey = '';
    this.lastHudKey = '';
  }

  public maybeSync(
    runtime: ReplayOnlineRuntimePort | null | undefined,
    opts: { playbackPaused: boolean; pausedAtTick: number; pauseHeartbeatHz?: number },
    nowMs: number = typeof performance !== 'undefined' ? performance.now() : Date.now()
  ): boolean {
    if (!runtime?.multiplayerSession?.isHosting) return false;
    const cam = runtime.camera;
    const camKey = cam
      ? `${Boolean(cam.isFreeCam)}:${typeof cam.ballCam === 'boolean' ? cam.ballCam : true}:${Math.round(Number(cam.focusedCarIndex) || 0)}`
      : '';
    const hud = hudStore?.getState?.();
    const hudKey = hud
      ? `${hud.blueScore ?? 0}:${hud.orangeScore ?? 0}:${hud.remainingSeconds ?? 0}:${hud.isOvertime ? 1 : 0}:${hud.matchPhase ?? ''}`
      : '';
    const intervalMs = getPauseHeartbeatIntervalMs(opts.pauseHeartbeatHz ?? 2);
    const cameraChanged =
      camKey !== '' && this.lastCameraKey !== '' && camKey !== this.lastCameraKey;
    const hudChanged =
      hudKey !== '' && this.lastHudKey !== '' && hudKey !== this.lastHudKey;
    if (!cameraChanged && !hudChanged && nowMs - this.lastSyncMs < intervalMs) {
      return false;
    }
    if (cameraChanged) {
      sharedAuthorityCameraSyncTracker.bumpLocalSeq();
    }
    this.lastSyncMs = nowMs;
    this.lastCameraKey = camKey;
    this.lastHudKey = hudKey;
    syncReplayWorkspaceToOnlineRoom(runtime, {
      active: true,
      playbackPaused: opts.playbackPaused,
      pausedAtTick: opts.pausedAtTick,
    });
    return true;
  }
}
