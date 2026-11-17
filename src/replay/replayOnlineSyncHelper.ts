/**
 * src/replay/replayOnlineSyncHelper.ts
 * Helpers for streaming StandaloneReplayViewerController state, pause/seek heartbeats,
 * and Host camera state into AuthoritativeServerHost & MultiplayerSessionManager.
 */

import {
  buildHostWorkspaceBroadcastPayload,
  captureCameraSyncFromPort,
  useAppStore,
} from '../game/runtimeUiPort.ts';
import { getPauseHeartbeatIntervalMs } from '../network/protocol/GlobalWorkspaceProtocol.ts';

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
}

export function syncReplayFrameToAuthoritativeServer(
  runtime: ReplayOnlineRuntimePort | null | undefined,
  tickOverride?: number
): void {
  const server = runtime?.authoritativeServer;
  if (!server) return;
  const snap = runtime?.physics?.saveCompactState?.() ?? null;
  if (!snap) return;
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

  if (opts.switchActivity) {
    const activityId = opts.active ? 'replay' : 'freeplay';
    useAppStore.getState().setOnlineSession?.({ activeRoomActivity: activityId });
    session.broadcastRoomActivitySwitch?.({
      activityId,
      mode: activityId,
      ...(opts.replayId ? { replayId: opts.replayId } : {}),
      config: {
        playbackPaused: Boolean(opts.playbackPaused),
        pausedAtTick: Math.max(0, Math.round(opts.pausedAtTick || 0)),
      },
    });
  }

  const cameraSync = runtime?.camera
    ? captureCameraSyncFromPort(runtime.camera, opts.active)
    : undefined;
  const payload = buildHostWorkspaceBroadcastPayload({
    playbackPaused: Boolean(opts.playbackPaused),
    pausedAtTick: Math.max(0, Math.round(opts.pausedAtTick || 0)),
    ...(cameraSync ? { cameraSync } : {}),
  });
  if (!payload) return 0;
  return session.broadcastGlobalWorkspace?.(payload) ?? 0;
}

export class ReplayOnlineHeartbeatTracker {
  private lastSyncMs = 0;
  private lastCameraKey = '';

  public reset(): void {
    this.lastSyncMs = 0;
    this.lastCameraKey = '';
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
    const intervalMs = getPauseHeartbeatIntervalMs(opts.pauseHeartbeatHz ?? 2);
    const cameraChanged = camKey !== '' && camKey !== this.lastCameraKey;
    if (!cameraChanged && nowMs - this.lastSyncMs < intervalMs) {
      return false;
    }
    this.lastSyncMs = nowMs;
    this.lastCameraKey = camKey;
    syncReplayWorkspaceToOnlineRoom(runtime, {
      active: true,
      playbackPaused: opts.playbackPaused,
      pausedAtTick: opts.pausedAtTick,
    });
    return true;
  }
}
