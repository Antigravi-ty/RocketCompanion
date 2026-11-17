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
  evaluateSimulationFrameFlags,
} from './simulationFrameClassifierPipeline.ts';
import { stepNetworkReconciliationAndReplayStream } from './simulationNetworkReconcilePipeline.ts';
import {
  ClientAuthorityPublisher,
  HostBroadcastPublisher,
  isDevSyncClientInputAuthorityMode,
  isDevSyncClientPureCsrSpectateMode,
  isDevSyncHostBroadcastingMode,
} from './HostBroadcastPublisher.ts';
import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.ts';
import { SpectateInterpolationBuffer } from '../../../network/sync/ReplicationStateInterpolator.ts';
import {
  buildHostWorkspaceBroadcastPayload,
  isSpectatePlaybackPaused,
  syncClientInputEnabledUi,
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
  modeManager: {
    getActiveMode(): ActiveModeSimulationPort | null;
  } | null;
  multiplayerSession?: {
    isHosting?: boolean;
    broadcastGlobalWorkspace?: (payload: Record<string, unknown>) => number;
    hostController?: {
      stepPauseAckLoop?: (nowMs?: number) => void;
      inputAuthority?: {
        activeInputPeerId: string;
        authorityMode: string;
        authorityEpoch: number;
        setAuthority: (enabled: boolean, targetPeerId?: string) => Record<string, unknown>;
        consumeLatestFrame: () => { snapshot: Float32Array; tick: number } | null;
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

    if (remoteHasAuthority && hostInputAuthority?.authorityMode === 'fpv_master_slave') {
      this.runtime.pollInputs(false);
      const ctrl = this.runtime.playerControls;
      const hostMoved = Boolean(
        ctrl &&
        (Math.abs(ctrl.throttle ?? 0) > 0.05 ||
          Math.abs(ctrl.steer ?? 0) > 0.05 ||
          ctrl.jump ||
          ctrl.boost)
      );
      if (hostMoved) {
        const reclaimPatch = hostInputAuthority.setAuthority(false, 'host');
        syncClientInputEnabledUi(false);
        server?.setClientInputEnabled?.(false);
        const wsPayload = buildHostWorkspaceBroadcastPayload(reclaimPatch);
        if (wsPayload) {
          this.runtime.multiplayerSession?.broadcastGlobalWorkspace?.(wsPayload);
        }
        remoteHasAuthority = false;
      }
    }

    const flags = evaluateSimulationFrameFlags({
      matchState,
      activeMode,
      isPodiumControllerActive: Boolean(podiumController?.isActive),
      hasReconciler: Boolean(reconciler && !isBroadcastingHost && !isClientInputAuthority),
      hasServer: Boolean(server),
    });

    if (
      isClientInputAuthority &&
      !isSpectatePlaybackPaused() &&
      !flags.isReplayPaused &&
      !flags.isGoalReplay &&
      !flags.isMatchEnded
    ) {
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

    const holdForClientAuthorityLobby =
      flags.shouldHoldAccumulator &&
      !(
        isClientInputAuthority &&
        !isSpectatePlaybackPaused() &&
        !flags.isReplayPaused &&
        !flags.isGoalReplay &&
        !flags.isMatchEnded
      );
    if (holdForClientAuthorityLobby || isPureCsrClient || remoteHasAuthority) {
      if (!flags.isGoalReplay && !podiumController?.isActive) {
        interpolator.sync(timestamp);
      }
    } else {
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
      const clientFrame = hostInputAuthority.consumeLatestFrame();
      if (clientFrame) {
        applyReplayFrameToEngine(physics, clientFrame.snapshot, interpolator);
        server?.pushBroadcastSnapshot(clientFrame.snapshot, clientFrame.tick);
      }
    }

    if (reconciler && !isBroadcastingHost && !isClientInputAuthority) {
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
      this.clientAuthorityPublisher.publishIfReady({
        timestamp,
        physics,
        channel: reconciler?.channel as {
          peerId?: string | null;
          sendClientAuthorityFrame?: (payload: Record<string, unknown>) => boolean;
        },
        authorityEpoch: reconciler?.authorityEpoch ?? 0,
      });
    } else {
      this.clientAuthorityPublisher.reset();
    }

    if (isBroadcastingHost && server && !remoteHasAuthority) {
      this.broadcastPublisher.publishIfReady({
        timestamp,
        physics,
        server,
        isPaused: flags.shouldHoldAccumulator || flags.isReplayPaused || isSpectatePlaybackPaused(),
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
    }

    if (profiler && !context.isSimulationOnly) {
      profiler.mark();
    }
  }
}
