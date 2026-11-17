import type { AuthoritativeServerHost } from '../../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../../network/client/PredictionReconciler.ts';
import type { RocketSimPhysicsEngine } from '../../../physics/RocketSimPhysicsEngine.ts';
import { useAppStore } from '../../runtimeUiPort.ts';

export function isDevSyncHostBroadcastingMode(hasServer: boolean): boolean {
  if (!hasServer) return false;
  const onlineSession = useAppStore?.getState?.()?.onlineSession;
  return Boolean(
    onlineSession?.isDevSyncRoom &&
      onlineSession?.isHosting &&
      onlineSession?.activeRoomActivity !== 'match'
  );
}

export function isDevSyncClientPureCsrSpectateMode(
  reconciler: PredictionReconciler | null | undefined
): boolean {
  if (!reconciler) return false;
  const onlineSession = useAppStore?.getState?.()?.onlineSession;
  return Boolean(
    onlineSession?.isDevSyncRoom &&
      !onlineSession?.isHosting &&
      onlineSession?.activeRoomActivity !== 'match' &&
      reconciler.spectateMirrorMode &&
      reconciler.clientInputEnabled === false &&
      !reconciler.replayPlaybackMode
  );
}

export class HostBroadcastPublisher {
  private lastPublishMs = 0;
  private lastPublishedTick = -1;
  private hasPublishedInitial = false;
  private readonly publishIntervalMs: number;

  constructor(publishHz = 60) {
    this.publishIntervalMs = publishHz > 0 ? 1000 / publishHz : 1000 / 60;
  }

  public reset(): void {
    this.lastPublishMs = 0;
    this.lastPublishedTick = -1;
    this.hasPublishedInitial = false;
  }

  public publishIfReady(params: {
    readonly timestamp: number;
    readonly physics: RocketSimPhysicsEngine;
    readonly server: AuthoritativeServerHost | null;
    readonly isPaused?: boolean;
  }): boolean {
    const { timestamp, physics, server, isPaused = false } = params;
    if (!server || !isDevSyncHostBroadcastingMode(true)) {
      return false;
    }

    const snap = physics.saveCompactState?.();
    if (!snap || snap.length < 22) return false;

    const currentTick = Math.floor(
      physics.getHeaderView?.()?.tickCount ?? (Number(snap[0]) || 0)
    );

    if (!this.hasPublishedInitial) {
      server.enterStateOnlyMode(snap, currentTick);
      this.hasPublishedInitial = true;
      this.lastPublishMs = timestamp;
      this.lastPublishedTick = currentTick;
      return true;
    }

    const elapsed = timestamp - this.lastPublishMs;
    const tickChangedWhilePaused = Boolean(isPaused && currentTick !== this.lastPublishedTick);
    const effectiveInterval = this.publishIntervalMs > 4 ? this.publishIntervalMs - 2 : this.publishIntervalMs;
    if (elapsed < effectiveInterval && !tickChangedWhilePaused) {
      return false;
    }

    server.pushBroadcastSnapshot(snap, currentTick);
    this.lastPublishMs = timestamp;
    this.lastPublishedTick = currentTick;
    return true;
  }
}
