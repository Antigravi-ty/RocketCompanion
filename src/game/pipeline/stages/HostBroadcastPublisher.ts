import type { CarControlsInput } from '../../../network/protocol/InputPacketCodec.ts';
import { MATCH_SIGNALS } from '../../../network/protocol/GlobalPayloadCodec.ts';
import type { AuthoritativeServerHost } from '../../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../../network/client/PredictionReconciler.ts';
import { FLIP_RESET_SUBTYPES } from '../../../physics/RocketSimConstants.ts';
import type { RocketSimPhysicsEngine } from '../../../physics/RocketSimPhysicsEngine.ts';
import { useAppStore } from '../../runtimeUiPort.ts';

export function broadcastHostFlipResetSignalsIfNeeded(
  server: AuthoritativeServerHost | null | undefined,
  tickRes: { flipResetVisualCarIndices?: readonly number[] } | null | undefined,
  currentTick: number
): void {
  if (!server || !isDevSyncHostBroadcastingMode(true)) return;
  const indices = tickRes?.flipResetVisualCarIndices;
  if (!Array.isArray(indices) || indices.length === 0) return;
  for (let i = 0; i < indices.length; i++) {
    server.pushBroadcastSignal(
      MATCH_SIGNALS.FLIP_RESET_GAINED,
      currentTick,
      indices[i],
      FLIP_RESET_SUBTYPES.BALL
    );
  }
}

export function collectHostBroadcastControls(params: {
  numCars: number;
  playerCarIdx: number;
  playerControls: CarControlsInput | Record<string, unknown> | null | undefined;
  activeMode: {
    getCarControls?: (carIdx: number) => CarControlsInput | Record<string, unknown> | null;
  } | null;
  botCoordinator?: { isBotMatch?: boolean; botControls?: CarControlsInput } | null;
}): Array<{ carIndex: number; controls: CarControlsInput }> {
  const { numCars, playerCarIdx, playerControls, activeMode, botCoordinator } = params;
  const out: Array<{ carIndex: number; controls: CarControlsInput }> = [];
  for (let carIdx = 0; carIdx < numCars; carIdx++) {
    const modeCtrl = activeMode?.getCarControls?.(carIdx) as CarControlsInput | null | undefined;
    if (modeCtrl) out.push({ carIndex: carIdx, controls: modeCtrl });
    else if (carIdx === playerCarIdx && playerControls)
      out.push({ carIndex: carIdx, controls: playerControls as CarControlsInput });
    else if (botCoordinator?.isBotMatch && carIdx === 1 && botCoordinator.botControls)
      out.push({ carIndex: carIdx, controls: botCoordinator.botControls });
  }
  return out;
}

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
    !reconciler.replayPlaybackMode &&
    !isDevSyncClientInputAuthorityMode(reconciler)
  );
}

export function isDevSyncClientInputAuthorityMode(
  reconciler: PredictionReconciler | null | undefined
): boolean {
  if (!reconciler) return false;
  const onlineSession = useAppStore?.getState?.()?.onlineSession;
  if (
    !onlineSession?.isDevSyncRoom ||
    onlineSession?.isHosting ||
    onlineSession?.activeRoomActivity === 'match' ||
    !reconciler.spectateMirrorMode ||
    reconciler.clientInputEnabled !== true ||
    reconciler.replayPlaybackMode
  ) {
    return false;
  }
  const activePeer = reconciler.activeInputPeerId || 'any';
  if (activePeer === 'host') return false;
  if (activePeer === 'any') return true;
  const localPeerId = (reconciler.channel as { peerId?: string | null } | null | undefined)?.peerId;
  return !localPeerId || activePeer === localPeerId;
}

export class HostBroadcastPublisher {
  private lastPublishMs = 0;
  private lastPublishedTick = -1;
  private hasPublishedInitial = false;
  private wasPaused = false;
  private readonly publishIntervalMs: number;

  constructor(publishHz = 60) {
    this.publishIntervalMs = publishHz > 0 ? 1000 / publishHz : 1000 / 60;
  }

  public reset(): void {
    this.lastPublishMs = 0;
    this.lastPublishedTick = -1;
    this.hasPublishedInitial = false;
    this.wasPaused = false;
  }

  public publishIfReady(params: {
    readonly timestamp: number;
    readonly physics: RocketSimPhysicsEngine;
    readonly server: AuthoritativeServerHost | null;
    readonly isPaused?: boolean;
    readonly isGoalReplay?: boolean;
    readonly acknowledgedControls?: Array<{ carIndex: number; controls: CarControlsInput }> | null;
  }): boolean {
    const {
      timestamp,
      physics,
      server,
      isPaused = false,
      isGoalReplay = false,
      acknowledgedControls = null,
    } = params;
    if (!server || !isDevSyncHostBroadcastingMode(true)) {
      return false;
    }

    const snap = physics.saveCompactState?.();
    if (!snap || snap.length < 22) return false;

    const currentTick = Math.floor(physics.getHeaderView?.()?.tickCount ?? (Number(snap[0]) || 0));

    if (!this.hasPublishedInitial) {
      server.enterStateOnlyMode(snap, currentTick, acknowledgedControls);
      this.hasPublishedInitial = true;
      this.lastPublishMs = timestamp;
      this.lastPublishedTick = currentTick;
      this.wasPaused = isPaused;
      return true;
    }

    const tickChangedWhilePaused = Boolean(isPaused && currentTick !== this.lastPublishedTick);
    if (isPaused && !tickChangedWhilePaused) {
      this.wasPaused = true;
      return false;
    }

    const resumedFromPause = this.wasPaused && !isPaused;
    this.wasPaused = isPaused;

    const elapsed = timestamp - this.lastPublishMs;
    const effectiveInterval =
      this.publishIntervalMs > 4 ? this.publishIntervalMs - 2 : this.publishIntervalMs;
    if (elapsed < effectiveInterval && !tickChangedWhilePaused && !resumedFromPause) {
      return false;
    }

    let publishTick = currentTick;
    if (isGoalReplay && !isPaused) {
      const tickStep = this.lastPublishMs > 0 ? Math.max(1, Math.round(elapsed / (1000 / 120))) : 1;
      publishTick = Math.max(currentTick, this.lastPublishedTick + tickStep);
      snap[0] = publishTick;
    }

    server.pushBroadcastSnapshot(snap, publishTick, acknowledgedControls);
    this.lastPublishMs = timestamp;
    this.lastPublishedTick = publishTick;
    return true;
  }
}

export interface ClientAuthorityChannelPort {
  peerId?: string | null;
  sendClientAuthorityFrame?: (payload: Record<string, unknown>) => boolean;
}

export class ClientAuthorityPublisher {
  private lastPublishMs = 0;
  private readonly publishIntervalMs: number;

  constructor(publishHz = 60) {
    this.publishIntervalMs = publishHz > 0 ? 1000 / publishHz : 1000 / 60;
  }

  public reset(): void {
    this.lastPublishMs = 0;
  }

  public publishIfReady(params: {
    readonly timestamp: number;
    readonly physics: RocketSimPhysicsEngine;
    readonly channel: ClientAuthorityChannelPort | null | undefined;
    readonly authorityEpoch: number;
    readonly acknowledgedControls?: Array<{ carIndex: number; controls: CarControlsInput }> | null;
  }): boolean {
    const { timestamp, physics, channel, authorityEpoch, acknowledgedControls } = params;
    if (!channel?.sendClientAuthorityFrame) return false;
    const elapsed = timestamp - this.lastPublishMs;
    const effectiveInterval =
      this.publishIntervalMs > 4 ? this.publishIntervalMs - 2 : this.publishIntervalMs;
    if (this.lastPublishMs > 0 && elapsed < effectiveInterval) {
      return false;
    }
    const snap = physics.saveCompactState?.();
    if (!snap || snap.length < 22) return false;
    const tick = Math.floor(physics.getHeaderView?.()?.tickCount ?? (Number(snap[0]) || 0));
    const sent = channel.sendClientAuthorityFrame({
      authorityEpoch,
      tick,
      peerId: channel.peerId || 'client',
      snapshot: Array.from(snap),
      ...(acknowledgedControls && acknowledgedControls.length > 0 ? { acknowledgedControls } : {}),
    });
    if (sent) {
      this.lastPublishMs = timestamp;
    }
    return sent;
  }
}
