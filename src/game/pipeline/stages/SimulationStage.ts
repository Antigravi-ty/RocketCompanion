import type { CarControlsInput } from '../../../network/protocol/InputPacketCodec.ts';
import type { CameraManager } from '../../../camera/CameraManager.ts';
import type { CameraTransformLike } from '../../../audio/SpatialAudioSource.ts';
import type { AuthoritativeServerHost } from '../../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../../network/client/PredictionReconciler.ts';
import type { PhysicsStateInterpolator } from '../../../physics/PhysicsStateInterpolator.ts';
import type { ReplayTimelineController } from '../../../replay/ReplayTimelineController.ts';
import type { FrameContext, PipelineStage } from '../FramePipeline.ts';
import {
  CarActionEventSynthesizer,
  type CarActionDebounceState,
  type CarActionSynthesizerRuntimePort,
  dispatchCarActionTickEffects,
} from './CarActionEventSynthesizer.ts';
import {
  type ActiveModeSimulationPort,
  type SimulationMatchStateSnapshot,
  classifySimulationDrivePolicy,
  evaluateSimulationFrameFlags,
} from './simulationFrameClassifierPipeline.ts';
import { stepNetworkReconciliationAndReplayStream } from './simulationNetworkReconcilePipeline.ts';
import {
  broadcastHostFlipResetSignalsIfNeeded,
  ClientAuthorityPublisher,
  collectHostBroadcastControls,
  HostBroadcastPublisher,
  isDevSyncClientInputAuthorityMode,
  isDevSyncClientPureCsrSpectateMode,
  isDevSyncHostBroadcastingMode,
} from './HostBroadcastPublisher.ts';
import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.ts';
import { SpectateInterpolationBuffer } from '../../../network/sync/ReplicationStateInterpolator.ts';
import { CoachAuthorityHandoverController } from '../../runtime/CoachAuthorityHandoverController.ts';
import { sharedAuthorityCameraSyncTracker } from './AuthorityCameraSyncTracker.ts';
import {
  buildHostWorkspaceBroadcastPayload,
  isSpectatePlaybackPaused,
} from '../../runtimeUiPort.ts';

export type { CarActionDebounceState };

export interface SimulationStageRuntimePort extends CarActionSynthesizerRuntimePort {
  interpolator: PhysicsStateInterpolator | null;
  match: {
    state: SimulationMatchStateSnapshot;
  } | null;
  camera: CameraManager | null;
  podiumController: { isActive: boolean } | null;
  replayTimelineController: ReplayTimelineController | null;
  botCoordinator?: {
    isBotMatch?: boolean;
    botControls?: CarControlsInput;
  } | null;
  modeManager: {
    getActiveMode():
      | (ActiveModeSimulationPort & {
          getCarControls?(carIdx: number): CarControlsInput | Record<string, unknown> | null;
        })
      | null;
  } | null;
  multiplayerSession?: {
    isHosting?: boolean;
    broadcastGlobalWorkspace?: (payload: Record<string, unknown>) => number;
    broadcastCameraStateSync?: (payload: Record<string, unknown>) => number;
    hostController?: {
      stepPauseAckLoop?: (nowMs?: number) => void;
      getConnectedPeerList?: () => Array<{ id: string }>;
      inputAuthority?: {
        activeInputPeerId: string;
        clientInputEnabled: boolean;
        authorityMode: string;
        authorityEpoch: number;
        setAuthority: (enabled: boolean, targetPeerId?: string) => Record<string, unknown>;
        syncFromHandover?: (state: {
          authorityEpoch: number;
          activeInputPeerId: string;
          authorityMode: 'explicit' | 'fpv_master_slave';
          clientInputEnabled: boolean;
        }) => void;
        consumeLatestFrame: () => {
          snapshot: Float32Array;
          tick: number;
          acknowledgedControls?: Array<{ carIndex: number; controls: CarControlsInput }>;
        } | null;
        consumePendingFrames?: () => Array<{
          snapshot: Float32Array;
          tick: number;
          acknowledgedControls?: Array<{ carIndex: number; controls: CarControlsInput }>;
        }>;
      };
    } | null;
  } | null;
  networkManager: {
    diagnosticDumpMaxFrames?: number;
    rosterSyncCoordinator?: {
      lastRosterSnapshot?: {
        players?: Array<{
          carIndex?: number;
          entityId?: number;
          team?: number | string;
          [key: string]: unknown;
        }>;
      } | null;
    } | null;
    sessionCoordinator: {
      authoritativeServer: AuthoritativeServerHost | null;
      networkReconciler: PredictionReconciler | null;
      clientReplayOverflowPaused?: boolean;
    };
    diagnosticsProbe: {
      testCarAudioEnabled?: boolean;
      diagnosticsFleetController?: {
        enabled: boolean;
        applyToAuthority(serverOrSim: unknown, tick: number): void;
      } | null;
    };
  } | null;
  profiler: { mark(): void } | null;
  pollInputs(commitPhysicsStep?: boolean): boolean;
}

const CUSTOM_STEP_MODES = new Set([
  'freeplay',
  'replay-viewer',
  'kickoff-training',
  'dev-test-lab',
  'exp-multi-bots',
  'static-training-pack',
  'dynamic-training-pack',
]);

/**
 * SimulationStage.ts
 * Advances deterministic 120Hz physics accumulator, network reconciliation,
 * and delegates vehicle action debounce & incident synthesis to CarActionEventSynthesizer.
 */
export class SimulationStage implements PipelineStage {
  public runtime: SimulationStageRuntimePort;
  public readonly actionSynthesizer = new CarActionEventSynthesizer();
  public readonly broadcastPublisher = new HostBroadcastPublisher(60);
  public readonly clientAuthorityPublisher = new ClientAuthorityPublisher(60);
  public readonly spectateInterpolationBuffer = new SpectateInterpolationBuffer();
  public readonly hostAuthoritySpectateBuffer = new SpectateInterpolationBuffer();
  public readonly coachHandoverController = new CoachAuthorityHandoverController();
  private _lastRecordedClientReplayTick = -1;
  private _pendingGoalScored = false;

  constructor(runtime: SimulationStageRuntimePort) {
    this.runtime = runtime;
  }

  public resetActionStates(): void {
    this._pendingGoalScored = false;
    this.actionSynthesizer.reset();
  }

  public getCarActionState(carIdx: number): CarActionDebounceState {
    return this.actionSynthesizer.debounceRegistry.getCarActionState(carIdx);
  }

  public execute(context: FrameContext): void {
    const {
      match,
      interpolator,
      physics,
      modeManager,
      networkManager,
      camera,
      podiumController,
      replayTimelineController,
      profiler,
    } = this.runtime;
    if (!match || !interpolator || !physics) return;

    const { timestamp, activeCar } = context;
    const matchState = match.state;
    const activeMode = modeManager?.getActiveMode() ?? null;
    const session = networkManager?.sessionCoordinator ?? null;
    const reconciler = session?.networkReconciler ?? null;
    const server = session?.authoritativeServer ?? null;
    const fleet = networkManager?.diagnosticsProbe?.diagnosticsFleetController ?? null;
    const isBroadcastingHost = isDevSyncHostBroadcastingMode(Boolean(server));
    const isPureCsrClient = isDevSyncClientPureCsrSpectateMode(reconciler);
    const isClientInputAuthority = isDevSyncClientInputAuthorityMode(reconciler);
    const hostInputAuthority = isBroadcastingHost
      ? (this.runtime.multiplayerSession?.hostController?.inputAuthority ?? null)
      : null;
    let remoteHasAuthority = Boolean(
      hostInputAuthority && hostInputAuthority.activeInputPeerId !== 'host'
    );

    if (
      isBroadcastingHost &&
      hostInputAuthority &&
      hostInputAuthority.authorityMode === 'fpv_master_slave' &&
      hostInputAuthority.clientInputEnabled
    ) {
      if (this.coachHandoverController.authorityEpoch !== hostInputAuthority.authorityEpoch) {
        this.coachHandoverController.configure({
          clientInputEnabled: hostInputAuthority.clientInputEnabled,
          targetPeerId: hostInputAuthority.activeInputPeerId,
          authorityMode: 'fpv_master_slave',
        });
        this.coachHandoverController.authorityEpoch = hostInputAuthority.authorityEpoch;
        this.coachHandoverController.activeInputPeerId = hostInputAuthority.activeInputPeerId;
      }
      this.runtime.pollInputs(false);
      const hasPeer = Boolean(
        (this.runtime.multiplayerSession?.hostController?.getConnectedPeerList?.().length ?? 1) > 0
      );
      const handoverStep = this.coachHandoverController.step({
        nowMs: timestamp,
        controls: this.runtime.playerControls,
        hasTargetPeer: hasPeer,
      });
      if (handoverStep.changed) {
        if (handoverStep.action === 'reclaim_to_host') {
          const lastClientFrame = hostInputAuthority.consumeLatestFrame();
          if (lastClientFrame) {
            applyReplayFrameToEngine(physics, lastClientFrame.snapshot, interpolator);
          }
          this.hostAuthoritySpectateBuffer.reset();
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
          this.runtime.multiplayerSession?.broadcastGlobalWorkspace?.(wsPayload);
        }
        remoteHasAuthority = handoverStep.activeInputPeerId !== 'host';
      }
    }

    const isSpectatePaused = isSpectatePlaybackPaused();
    const flags = evaluateSimulationFrameFlags({
      matchState,
      activeMode,
      isPodiumControllerActive: Boolean(podiumController?.isActive),
      hasReconciler: Boolean(reconciler && !isBroadcastingHost && !isClientInputAuthority),
      hasServer: Boolean(server),
    });
    const policy = classifySimulationDrivePolicy({
      flags,
      hasServer: Boolean(server),
      isBroadcastingHost,
      hasReconciler: Boolean(reconciler && !isBroadcastingHost),
      isPureCsrClient,
      isClientInputAuthority,
      isReconcilerReplayPlayback: Boolean(reconciler?.replayPlaybackMode),
      remoteHasAuthority,
      isSpectatePaused,
    });

    const canUnfreezeClientAuthority =
      isClientInputAuthority &&
      policy.mode === 'local-freeplay' &&
      !isSpectatePaused &&
      !flags.isReplayPaused &&
      !flags.isMatchEnded;
    if (canUnfreezeClientAuthority) {
      physics.setSimulationFrozen?.(false, 0, false);
      if (matchState.paused) {
        matchState.paused = false;
      }
      if (matchState.phase === 'lobby') {
        matchState.phase = 'playing';
      }
    }

    context.isPodiumActive = flags.isPodiumActive;
    context.isMatchActive = flags.isMatchActive;

    if (policy.shouldHoldAccumulator) {
      const isClientStreamMode =
        policy.mode === 'client-csr-spectate' || policy.mode === 'client-goal-replay';
      const shouldSyncInterpolator =
        (isClientStreamMode || !flags.isGoalReplay) && !flags.isPodiumActive;
      if (shouldSyncInterpolator) {
        interpolator.sync(timestamp);
      }
    } else if (policy.shouldStepLocalPhysics) {
      const modeName = matchState.mode;
      const isCustomStepMode = CUSTOM_STEP_MODES.has(modeName);
      interpolator.update(
        timestamp,
        () => {
          this.runtime.pollInputs();
          if (activeCar >= 0 && !this.runtime.playerControls?.jump) {
            this.actionSynthesizer.debounceRegistry.notifyLocalJumpReleased(activeCar);
          }
          if (fleet?.enabled && (!reconciler || isBroadcastingHost)) {
            const cTick = Math.floor(physics.getHeaderView().tickCount);
            fleet.applyToAuthority(physics, cTick);
          }
          if (isCustomStepMode) {
            return modeManager?.getActiveMode()?.onBeforePhysicsTick?.();
          }
        },
        modeName === 'kickoff-training'
          ? () => modeManager?.getActiveMode()?.onStepPhysicsTick?.()
          : isCustomStepMode
            ? () => {
                physics.step(1);
                modeManager?.getActiveMode()?.onAfterPhysicsTick?.();
                return true;
              }
            : undefined
      );
    }

    if (remoteHasAuthority && hostInputAuthority) {
      const frames =
        hostInputAuthority.consumePendingFrames?.() ??
        (() => {
          const single = hostInputAuthority.consumeLatestFrame();
          return single ? [single] : [];
        })();
      for (let i = 0; i < frames.length; i++) {
        const cf = frames[i];
        this.hostAuthoritySpectateBuffer.pushFrame(cf.snapshot, cf.tick, timestamp);
        if (i === frames.length - 1) {
          server?.pushBroadcastSnapshot(cf.snapshot, cf.tick, cf.acknowledgedControls);
        }
      }
      const sampled = this.hostAuthoritySpectateBuffer.sample(timestamp);
      if (sampled) {
        applyReplayFrameToEngine(physics, sampled.snapshot, interpolator);
      }
    } else {
      this.hostAuthoritySpectateBuffer.reset();
    }

    const useClientPredictedGoalState = Boolean(
      reconciler && !isBroadcastingHost && !isClientInputAuthority
    );
    if (useClientPredictedGoalState) {
      context.goalScored = matchState.phase === 'goal';
    } else {
      if (physics.pollGoal() !== 0) {
        this._pendingGoalScored = true;
      }
      context.goalScored = Boolean(this._pendingGoalScored);
      if (!context.isSimulationOnly) {
        this._pendingGoalScored = false;
      }
    }

    if ((reconciler || isBroadcastingHost) && !flags.isLocalDirectorPreview) {
      this._lastRecordedClientReplayTick = stepNetworkReconciliationAndReplayStream({
        timestamp,
        physics,
        interpolator,
        camera,
        matchState,
        flags,
        policy,
        reconciler,
        server,
        replayTimelineController,
        rosterCapturePort: this.runtime,
        diagnosticDumpMaxFrames: networkManager?.diagnosticDumpMaxFrames || 36000,
        fleetController: fleet,
        sessionStateTarget: session,
        lastRecordedClientReplayTick: this._lastRecordedClientReplayTick,
        skipReconciler: isBroadcastingHost || isClientInputAuthority,
        spectateInterpolationBuffer: this.spectateInterpolationBuffer,
      });
    }

    if (this.runtime.multiplayerSession?.isHosting) {
      this.runtime.multiplayerSession.hostController?.stepPauseAckLoop?.(Date.now());
    }

    if (isClientInputAuthority) {
      const targetCarIdx = activeCar >= 0 ? activeCar : (this.runtime.playerCarIndex ?? 0);
      const ackControls = this.runtime.playerControls
        ? [{ carIndex: targetCarIdx, controls: this.runtime.playerControls as CarControlsInput }]
        : null;
      this.clientAuthorityPublisher.publishIfReady({
        timestamp,
        physics,
        channel: reconciler?.channel as {
          peerId?: string | null;
          sendClientAuthorityFrame?: (payload: Record<string, unknown>) => boolean;
        },
        authorityEpoch: reconciler?.authorityEpoch ?? 0,
        acknowledgedControls: ackControls,
      });
    } else {
      this.clientAuthorityPublisher.reset();
    }

    const isLocalCameraAuthority =
      (isBroadcastingHost && !remoteHasAuthority) || isClientInputAuthority;
    if (isLocalCameraAuthority && camera) {
      const authEpoch = isBroadcastingHost
        ? (hostInputAuthority?.authorityEpoch ?? 0)
        : (reconciler?.authorityEpoch ?? 0);
      const localPeerId = isBroadcastingHost
        ? 'host'
        : (reconciler?.channel as { peerId?: string | null } | null)?.peerId || 'client';
      const camEmission = sharedAuthorityCameraSyncTracker.pollLocalCameraChange(
        camera,
        authEpoch,
        localPeerId
      );
      if (camEmission) {
        this.runtime.multiplayerSession?.broadcastCameraStateSync?.(
          camEmission as unknown as Record<string, unknown>
        );
      }
    }

    if (policy.shouldBroadcastSnapshot && server) {
      const numCars = Math.min(
        8,
        Math.max(1, Math.round(Number(physics.getHeaderView?.()?.numCars) || 1))
      );
      const acknowledgedControls = collectHostBroadcastControls({
        numCars,
        playerCarIdx: activeCar >= 0 ? activeCar : (this.runtime.playerCarIndex ?? 0),
        playerControls: this.runtime.playerControls,
        activeMode,
        botCoordinator: this.runtime.botCoordinator,
      });
      const isHostBroadcastPaused =
        (policy.mode === 'host-authoritative' && policy.shouldHoldAccumulator) ||
        flags.isReplayPaused ||
        isSpectatePaused;
      this.broadcastPublisher.publishIfReady({
        timestamp,
        physics,
        server,
        isPaused: isHostBroadcastPaused,
        isGoalReplay: policy.mode === 'host-goal-replay',
        acknowledgedControls,
      });
    } else {
      this.broadcastPublisher.reset();
    }

    if (flags.shouldSynthesizeTickEvents) {
      const camTransform: CameraTransformLike | null | undefined =
        camera && 'camera' in camera ? camera.camera : camera;
      const tickRes = this.actionSynthesizer.stepTickEvents({
        physics,
        playerCarIndex: this.runtime.playerCarIndex ?? 0,
        playerControls: this.runtime.playerControls,
        networkReconciler: isBroadcastingHost ? null : reconciler,
        testCarAudioEnabled: Boolean(networkManager?.diagnosticsProbe?.testCarAudioEnabled),
        isMatchEnded: flags.isMatchEnded,
        matchPhase: matchState.phase ?? 'playing',
        clientGoalIncidentLatched: Boolean(this.runtime._clientGoalIncidentLatched),
        camera: camTransform,
      });
      this.runtime._clientGoalIncidentLatched = tickRes.nextClientGoalIncidentLatched;
      dispatchCarActionTickEffects(tickRes, {
        ballTrajectoryPredictor: this.runtime.ballTrajectoryPredictor,
        activeMode: modeManager?.getActiveMode() ?? null,
        getFlipResetVisual: (carIndex) => this.runtime.getFlipResetVisual?.(carIndex) ?? null,
        arena: this.runtime.arena,
      });
      if (isBroadcastingHost && server) {
        broadcastHostFlipResetSignalsIfNeeded(
          server,
          tickRes,
          Math.floor(physics.getHeaderView().tickCount)
        );
      }
    }

    if (profiler && !context.isSimulationOnly) {
      profiler.mark();
    }
  }
}
