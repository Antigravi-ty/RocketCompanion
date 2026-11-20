import { CoachAuthorityHandoverController } from '../../runtime/CoachAuthorityHandoverController.ts';
import { ClientFpvAuthorityGuard } from '../../runtime/ClientFpvAuthorityGuard.ts';
import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.ts';
import { buildHostWorkspaceBroadcastPayload } from '../../runtimeUiPort.ts';
import type { CarControlsInput } from '../../../network/protocol/GlobalPayloadCodec.ts';

export interface HostFpvInputAuthorityPort {
  activeInputPeerId: string;
  clientInputEnabled: boolean;
  authorityMode: string;
  authorityEpoch: number;
  syncFromHandover?: (state: {
    authorityEpoch: number;
    activeInputPeerId: string;
    authorityMode: 'explicit' | 'fpv_master_slave';
    clientInputEnabled: boolean;
  }) => void;
  hasRecentStudentInput?: (nowMs?: number, maxAgeMs?: number) => boolean;
  consumeLatestFrame: () => {
    snapshot: Float32Array;
    tick: number;
    acknowledgedControls?: Array<{ carIndex: number; controls: CarControlsInput }>;
  } | null;
}

export function stepHostFpvCoachHandover(params: {
  timestamp: number;
  coachHandoverController: CoachAuthorityHandoverController;
  hostInputAuthority: HostFpvInputAuthorityPort;
  pollInputs: (applyToCar?: boolean) => void;
  playerControls: CarControlsInput | null | undefined;
  hasPeer: boolean;
  physics: Parameters<typeof applyReplayFrameToEngine>[0];
  interpolator: Parameters<typeof applyReplayFrameToEngine>[2];
  resetHostSpectateBuffer: () => void;
  broadcastWorkspace?: (payload: Record<string, unknown>) => number;
}): boolean {
  const {
    timestamp,
    coachHandoverController,
    hostInputAuthority,
    pollInputs,
    playerControls,
    hasPeer,
    physics,
    interpolator,
    resetHostSpectateBuffer,
    broadcastWorkspace,
  } = params;

  if (coachHandoverController.authorityEpoch !== hostInputAuthority.authorityEpoch) {
    coachHandoverController.configure({
      clientInputEnabled: hostInputAuthority.clientInputEnabled,
      targetPeerId: hostInputAuthority.activeInputPeerId,
      authorityMode: 'fpv_master_slave',
    });
    coachHandoverController.authorityEpoch = hostInputAuthority.authorityEpoch;
    coachHandoverController.activeInputPeerId = hostInputAuthority.activeInputPeerId;
  }

  pollInputs(false);
  const handoverStep = coachHandoverController.step({
    nowMs: timestamp,
    controls: playerControls,
    studentHasActiveInput: hostInputAuthority.hasRecentStudentInput?.(timestamp),
    hasTargetPeer: hasPeer,
  });

  if (handoverStep.changed) {
    if (handoverStep.action === 'reclaim_to_host') {
      const lastClientFrame = hostInputAuthority.consumeLatestFrame();
      if (lastClientFrame) {
        applyReplayFrameToEngine(physics, lastClientFrame.snapshot, interpolator);
      }
      resetHostSpectateBuffer();
    }
    hostInputAuthority.syncFromHandover?.({
      authorityEpoch: handoverStep.authorityEpoch,
      activeInputPeerId: handoverStep.activeInputPeerId,
      authorityMode: handoverStep.authorityMode,
      clientInputEnabled: handoverStep.clientInputEnabled,
    });
    const wsPayload = buildHostWorkspaceBroadcastPayload({
      authorityEpoch: handoverStep.authorityEpoch,
      activeInputPeerId: handoverStep.activeInputPeerId,
      authorityMode: handoverStep.authorityMode,
      clientInputEnabled: handoverStep.clientInputEnabled,
    });
    if (wsPayload) {
      broadcastWorkspace?.(wsPayload);
    }
    return handoverStep.activeInputPeerId !== 'host';
  }

  return hostInputAuthority.activeInputPeerId !== 'host';
}

export function syncClientFpvAuthorityGuard(
  guard: ClientFpvAuthorityGuard,
  reconciler: {
    authorityEpoch?: number;
    activeInputPeerId?: string;
    clientInputEnabled?: boolean;
    channel?: { peerId?: string | null } | null;
  } | null
): boolean {
  if (!reconciler) {
    guard.reset();
    return false;
  }
  const localPeerId = reconciler.channel?.peerId || 'client';
  const res = guard.applyIncomingAuthority({
    authorityEpoch: reconciler.authorityEpoch ?? 0,
    activeInputPeerId: reconciler.activeInputPeerId ?? 'host',
    localPeerId,
    clientInputEnabled: Boolean(reconciler.clientInputEnabled),
  });
  return res.preempted;
}
