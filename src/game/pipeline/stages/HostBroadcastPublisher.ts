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

function computeBroadcastSignature(snap: Float32Array): number {
  let hash = 2166136261;
  const n = snap.length;
  const indices = [0, 1, 4, 5, 6, 7, 8, 9, 22, 23, 24, 25, 26, 27];
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx >= n) continue;
    const val = Math.round((Number(snap[idx]) || 0) * 10);
    hash ^= val & 0xff;
    hash = Math.imul(hash, 16777619);
    hash ^= (val >> 8) & 0xff;
    hash = Math.imul(hash, 16777619);
    hash ^= (val >> 16) & 0xff;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class HostBroadcastPublisher {
  private lastPublishMs = 0;
  private lastEngineTick = -1;
  private lastStreamTick = -1;
  private lastSignature = 0;
  private hasPublishedInitial = false;
  private wasPaused = false;
  private readonly publishIntervalMs: number;

  constructor(publishHz = 60) {
    this.publishIntervalMs = publishHz > 0 ? 1000 / publishHz : 1000 / 60;
  }

  public reset(): void {
    this.lastPublishMs = 0;
    this.lastEngineTick = -1;
    this.lastStreamTick = -1;
    this.lastSignature = 0;
    this.hasPublishedInitial = false;
    this.wasPaused = false;
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

    const engineTick = Math.floor(
      physics.getHeaderView?.()?.tickCount ?? (Number(snap[0]) || 0)
    );
    const sig = computeBroadcastSignature(snap);

    if (!this.hasPublishedInitial) {
      server.enterStateOnlyMode(snap, engineTick);
      this.hasPublishedInitial = true;
      this.lastPublishMs = timestamp;
      this.lastEngineTick = engineTick;
      this.lastStreamTick = engineTick;
      this.lastSignature = sig;
      this.wasPaused = isPaused;
      return true;
    }

    const engineTickChanged = engineTick !== this.lastEngineTick;
    const signatureChanged = sig !== this.lastSignature;
    const stateChangedWhilePaused = Boolean(isPaused && (engineTickChanged || signatureChanged));
    if (isPaused && !stateChangedWhilePaused) {
      this.wasPaused = true;
      return false;
    }

    const resumedFromPause = this.wasPaused && !isPaused;
    this.wasPaused = isPaused;

    const elapsed = timestamp - this.lastPublishMs;
    const effectiveInterval = this.publishIntervalMs > 4 ? this.publishIntervalMs - 2 : this.publishIntervalMs;
    if (elapsed < effectiveInterval && !stateChangedWhilePaused && !resumedFromPause) {
      return false;
    }

    let nextStreamTick = engineTick;
    if (!engineTickChanged && signatureChanged) {
      nextStreamTick = this.lastStreamTick + 1;
    } else if (engineTick <= this.lastStreamTick && signatureChanged) {
      nextStreamTick = this.lastStreamTick + 1;
    }

    server.pushBroadcastSnapshot(snap, nextStreamTick);
    this.lastPublishMs = timestamp;
    this.lastEngineTick = engineTick;
    this.lastStreamTick = nextStreamTick;
    this.lastSignature = sig;
    return true;
  }
}
