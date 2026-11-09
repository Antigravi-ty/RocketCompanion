import {
  PHYSICS_EVENT_TYPES,
  INCIDENT_EVENT_TYPES,
  isIncidentEvent,
  isBallFlipResetEvent,
} from '../../../physics/RocketSimConstants.ts';
import { eventStreamStore } from '../../runtimeUiPort.ts';
import { isEventLogEnabled } from '../../../ui-core/config/audioConfig';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import {
  CarActionDebounceRegistry,
  type CarActionDebounceState,
  type CarActionPhysicsEventPayload,
  type CarEdgeSynthesisContext,
} from './CarActionDebounceRegistry.ts';
import type { RocketSimPhysicsEngine } from '../../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsEventRecord } from '../../../physics/PhysicsEventReader.ts';
import type { CarControlsInput } from '../../../network/protocol/GlobalPayloadCodec.ts';
import type { CameraManager } from '../../../camera/CameraManager.ts';
import type { CameraTransformLike } from '../../../audio/SpatialAudioSource.ts';

export type { CarActionDebounceState, CarActionPhysicsEventPayload };

export interface ProcessTickEventsParams {
  physics: RocketSimPhysicsEngine | null;
  playerCarIndex: number;
  playerControls: Partial<CarControlsInput> | null | undefined;
  networkReconciler: { lobbyDualWorldMode?: boolean } | null | undefined;
  testCarAudioEnabled: boolean;
  isMatchEnded: boolean;
  matchPhase: string;
  clientGoalIncidentLatched: boolean;
  camera: CameraTransformLike | null | undefined;
  arena: { triggerGoalBarrierImpact?(x?: number, y?: number, z?: number): void } | null | undefined;
  onGoalIncidentLatched: () => void;
  onModePhysicsEvent: (event: CarActionPhysicsEventPayload) => void;
  onPlayFlipResetVisual: (carIndex: number) => void;
}

export interface CarActionSynthesizerRuntimePort {
  physics: RocketSimPhysicsEngine | null;
  playerCarIndex: number;
  playerControls: CarControlsInput;
  networkManager?: {
    sessionCoordinator?: {
      networkReconciler?: { lobbyDualWorldMode?: boolean } | null;
    } | null;
    diagnosticsProbe?: {
      testCarAudioEnabled?: boolean;
    } | null;
  } | null;
  match?: { state: { phase: string } } | null;
  _clientGoalIncidentLatched: boolean;
  camera: CameraManager | CameraTransformLike | null;
  arena: {
    triggerGoalBarrierImpact?(x?: number, y?: number, z?: number): void;
    carVisual?: string;
    vehiclePresets?: ArrayLike<string | null | undefined>;
    carTeams?: ArrayLike<number | null | undefined>;
    carColors?: ArrayLike<string | number | null | undefined>;
    carPaintFinishes?: ArrayLike<string | null | undefined>;
    carBoostVisuals?: ArrayLike<string | null | undefined>;
    carBoostAudios?: ArrayLike<string | null | undefined>;
    cars?: ArrayLike<{ visible?: boolean } | null | undefined>;
  } | null;
  ballTrajectoryPredictor?: { notifyCarBallHit?(tick?: number): void } | null;
  modeManager?: {
    getActiveMode?(): {
      standaloneReplayViewer?: { isActive?: boolean; isIntervening?: boolean } | null;
      rlrcReplaySession?: { isActive?: boolean; isIntervening?: boolean } | null;
      onPhysicsEvent?(event: CarActionPhysicsEventPayload): void;
    } | null;
  } | null;
  getFlipResetVisual?(carIndex: number): { play(): void } | null;
}

/**
 * CarActionEventSynthesizer
 * Stateful sub-controller orchestrating per-vehicle action debounce state,
 * remote/local edge event synthesis, and native WASM physics incident dispatch.
 */
export class CarActionEventSynthesizer {
  private readonly _debounceRegistry = new CarActionDebounceRegistry();
  private _lastSeenPhysicsTick = -1;

  public reset(): void {
    this._debounceRegistry.reset();
    this._lastSeenPhysicsTick = -1;
    gameAudio?.resetIncidentDebounceState?.();
  }

  public getCarActionState(carIdx: number): CarActionDebounceState {
    return this._debounceRegistry.getCarActionState(carIdx);
  }

  public notifyLocalJumpReleased(playerCarIndex: number): void {
    this._debounceRegistry.notifyLocalJumpReleased(playerCarIndex);
  }

  public processRuntimeTickEvents(
    runtime: CarActionSynthesizerRuntimePort,
    isMatchEnded: boolean,
  ): void {
    if (!runtime.physics) return;
    const matchPhase = runtime.match?.state.phase ?? 'playing';
    const ballPosY = Math.abs(runtime.physics.getBallStateView?.()?.posY || 0);
    if (ballPosY < 5000 && matchPhase !== 'goal') {
      runtime._clientGoalIncidentLatched = false;
    }
    const activeMode = runtime.modeManager?.getActiveMode?.();
    if (
      (activeMode?.standaloneReplayViewer?.isActive &&
        !activeMode.standaloneReplayViewer.isIntervening) ||
      (activeMode?.rlrcReplaySession?.isActive &&
        !activeMode.rlrcReplaySession.isIntervening)
    ) {
      return;
    }
    const camTransform: CameraTransformLike | null | undefined =
      runtime.camera && 'camera' in runtime.camera ? runtime.camera.camera : runtime.camera;

    this.processTickEvents({
      physics: runtime.physics,
      playerCarIndex: runtime.playerCarIndex ?? 0,
      playerControls: runtime.playerControls,
      networkReconciler: runtime.networkManager?.sessionCoordinator?.networkReconciler,
      testCarAudioEnabled: Boolean(runtime.networkManager?.diagnosticsProbe?.testCarAudioEnabled),
      isMatchEnded,
      matchPhase,
      clientGoalIncidentLatched: Boolean(runtime._clientGoalIncidentLatched),
      camera: camTransform,
      arena: runtime.arena,
      onGoalIncidentLatched: () => {
        runtime._clientGoalIncidentLatched = true;
      },
      onModePhysicsEvent: (event) => {
        if (event?.type === INCIDENT_EVENT_TYPES.CAR_BALL_HIT) {
          runtime.ballTrajectoryPredictor?.notifyCarBallHit?.(event.tick);
        }
        runtime.modeManager?.getActiveMode?.()?.onPhysicsEvent?.(event);
      },
      onPlayFlipResetVisual: (carIdx) => {
        const visual = runtime.getFlipResetVisual?.(carIdx);
        if (visual) {
          visual.play();
        }
      },
    });
  }

  public processTickEvents(params: ProcessTickEventsParams): void {
    const {
      physics,
      playerCarIndex,
      playerControls,
      networkReconciler,
      testCarAudioEnabled,
      isMatchEnded,
      matchPhase,
      camera,
      arena,
      onGoalIncidentLatched,
      onModePhysicsEvent,
      onPlayFlipResetVisual,
    } = params;

    if (!physics) return;

    let goalIncidentLatched = params.clientGoalIncidentLatched;
    const currentTick = Math.floor(physics.getHeaderView?.()?.tickCount ?? 0);
    if (this._lastSeenPhysicsTick >= 0 && this._lastSeenPhysicsTick - currentTick > 180) {
      this.reset();
    }
    this._lastSeenPhysicsTick = currentTick;

    const edgeCtx: CarEdgeSynthesisContext = {
      physics,
      playerCarIndex,
      playerControls,
      networkReconciler,
      testCarAudioEnabled,
      camera,
      onModePhysicsEvent,
    };

    this._debounceRegistry.syncPreTickCarStatesAndRemoteEdges(edgeCtx, currentTick);

    physics.readEvents((event: PhysicsEventRecord) => {
      if (!isIncidentEvent(event.type)) {
        return;
      }
      const evtCarIdx = event.carIndex ?? event.primaryId ?? -1;
      if ((evtCarIdx === 6 || evtCarIdx === 7) && !testCarAudioEnabled) {
        return;
      }
      if (
        networkReconciler?.lobbyDualWorldMode &&
        evtCarIdx >= 0 &&
        evtCarIdx < 65535 &&
        evtCarIdx !== playerCarIndex
      ) {
        return;
      }

      if (evtCarIdx >= 0 && evtCarIdx < 8) {
        if (
          !this._debounceRegistry.shouldAcceptCarActionIncident(
            event,
            evtCarIdx,
            currentTick,
            edgeCtx,
          )
        ) {
          return;
        }
      }

      if (event.type === INCIDENT_EVENT_TYPES.GOAL_SCORED || event.type === 0x0e) {
        if (goalIncidentLatched || isMatchEnded || matchPhase === 'replay') {
          return;
        }
        goalIncidentLatched = true;
        onGoalIncidentLatched();
      }

      if (
        event.type === PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED ||
        event.type === INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED
      ) {
        if (networkReconciler && !networkReconciler.lobbyDualWorldMode) {
          return;
        }
        const targetCarIdx =
          typeof event.carIndex === 'number' && event.carIndex >= 0
            ? event.carIndex
            : playerCarIndex;
        if (
          !this._debounceRegistry.shouldAcceptFlipResetIncident(
            event,
            targetCarIdx,
            physics,
            onModePhysicsEvent,
          )
        ) {
          return;
        }
      }

      if (isEventLogEnabled(event.type)) {
        console.log(
          `[Physics Incident 0x${event.type.toString(16).padStart(2, '0')}]`,
          event,
        );
      }

      eventStreamStore.addEvent(event);
      onModePhysicsEvent(event);

      if (
        (event.type === PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED ||
          event.type === INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED) &&
        isBallFlipResetEvent(event)
      ) {
        const targetCarIdx =
          typeof event.carIndex === 'number' && event.carIndex >= 0
            ? event.carIndex
            : playerCarIndex;
        onPlayFlipResetVisual(targetCarIdx);
      }

      if (event.isGoalBarrierHit) {
        arena?.triggerGoalBarrierImpact?.(event.x, event.y, event.z);
      }

      if (gameAudio) {
        gameAudio.handleEvent(event, camera);
      }
    });

    this._debounceRegistry.synthesizePostTickLocalFallbackEdges(edgeCtx, currentTick);
  }
}
