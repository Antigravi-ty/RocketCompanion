import {
  PHYSICS_EVENT_TYPES,
  INCIDENT_EVENT_TYPES,
  isIncidentEvent,
  isBallFlipResetEvent,
  isDiagnosticProbeSlot,
} from '../../../physics/RocketSimConstants.ts';
import { eventStreamStore } from '../../runtimeUiPort.ts';
import { isEventLogEnabled } from '../../../ui-core/config/audioConfig';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import type { RocketSimPhysicsEngine } from '../../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsEventRecord } from '../../../physics/PhysicsEventReader.ts';
import type { CarControlsInput } from '../../../network/protocol/GlobalPayloadCodec.ts';
import type { CameraManager } from '../../../camera/CameraManager.ts';
import type { CameraTransformLike } from '../../../audio/SpatialAudioSource.ts';

export interface CarActionDebounceState {
  boostLatched: boolean;
  hasSingleJumped: boolean;
  jumpReleasedSinceSingleJump: boolean;
  hasAirJumped: boolean;
  lastBoostTick: number;
  lastJumpTick: number;
  lastAirJumpTick: number;
  lastFlipResetTick: number;
  lastFlipResetTimeMs: number;
  localEdgeInitialized: boolean;
  prevLocalJumping: boolean;
  prevLocalFlipping: boolean;
  remoteEdgeInitialized: boolean;
  prevRemoteOnGround: boolean;
  prevRemoteJumping: boolean;
  prevRemoteFlipping: boolean;
  prevRemoteBoosting: boolean;
  prevRemoteSupersonic: boolean;
}

export interface CarActionPhysicsEventPayload {
  type: number;
  carIndex?: number;
  primaryId?: number;
  secondaryId?: number;
  x?: number;
  y?: number;
  z?: number;
  speed?: number;
  impulse?: number;
  tick?: number;
  isGoalBarrierHit?: boolean;
}

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
  arena: { triggerGoalBarrierImpact?(x?: number, y?: number, z?: number): void } | null;
  ballTrajectoryPredictor?: { notifyCarBallHit?(tick?: number): void } | null;
  modeManager?: {
    getActiveMode?(): { onPhysicsEvent?(event: CarActionPhysicsEventPayload): void } | null;
  } | null;
  getFlipResetVisual?(carIndex: number): { play(): void } | null;
}

/**
 * CarActionEventSynthesizer
 * Stateful sub-controller managing per-vehicle action debounce state,
 * remote/local edge event synthesis, and native WASM physics incident dispatch.
 */
export class CarActionEventSynthesizer {
  private readonly _carActionStates = new Map<number, CarActionDebounceState>();
  private _lastSeenPhysicsTick = -1;

  public reset(): void {
    this._carActionStates.clear();
    this._lastSeenPhysicsTick = -1;
    gameAudio?.resetIncidentDebounceState?.();
  }

  public getCarActionState(carIdx: number): CarActionDebounceState {
    let st = this._carActionStates.get(carIdx);
    if (!st) {
      st = {
        boostLatched: false,
        hasSingleJumped: false,
        jumpReleasedSinceSingleJump: true,
        hasAirJumped: false,
        lastBoostTick: -100,
        lastJumpTick: -100,
        lastAirJumpTick: -100,
        lastFlipResetTick: -1000,
        lastFlipResetTimeMs: -1000,
        localEdgeInitialized: false,
        prevLocalJumping: false,
        prevLocalFlipping: false,
        remoteEdgeInitialized: false,
        prevRemoteOnGround: true,
        prevRemoteJumping: false,
        prevRemoteFlipping: false,
        prevRemoteBoosting: false,
        prevRemoteSupersonic: false,
      };
      this._carActionStates.set(carIdx, st);
    }
    return st;
  }

  public notifyLocalJumpReleased(playerCarIndex: number): void {
    if (playerCarIndex >= 0) {
      this.getCarActionState(playerCarIndex).jumpReleasedSinceSingleJump = true;
    }
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
    if (this._lastSeenPhysicsTick >= 0 && currentTick < this._lastSeenPhysicsTick) {
      this.reset();
    }
    this._lastSeenPhysicsTick = currentTick;

    for (let c = 0; c < 8; c++) {
      if (typeof physics.isCarSlotActive === 'function' && !physics.isCarSlotActive(c)) {
        continue;
      }
      const st = this.getCarActionState(c);
      const cv = physics.getCarStateView?.(c);
      const isLocal = c === playerCarIndex;
      const ctrlBase = c * 8;
      const jumpCtrl = isLocal
        ? Boolean(playerControls?.jump)
        : physics.controlsView
          ? physics.controlsView[ctrlBase + 5] >= 0.5
          : false;
      const boostCtrl = isLocal
        ? Boolean(playerControls?.boost)
        : physics.controlsView
          ? physics.controlsView[ctrlBase + 6] >= 0.5
          : false;

      if (!jumpCtrl) {
        st.jumpReleasedSinceSingleJump = true;
      }
      if (cv?.isOnGround && !cv?.isJumping && !cv?.isFlipping) {
        st.hasSingleJumped = false;
        st.hasAirJumped = false;
      }
      if (!boostCtrl && !cv?.isBoosting) {
        st.boostLatched = false;
      }

      if (networkReconciler && !isLocal && cv) {
        if (isDiagnosticProbeSlot(c) && !testCarAudioEnabled) {
          continue;
        }
        if (networkReconciler.lobbyDualWorldMode && c !== 6 && c !== 7) {
          continue;
        }
        const curOnGround = Boolean(cv.isOnGround);
        const curJumping = Boolean(cv.isJumping);
        const curFlipping = Boolean(cv.isFlipping);
        const curBoosting = Boolean(cv.isBoosting);
        const curSupersonic = Boolean(cv.isSupersonic);

        if (!st.remoteEdgeInitialized) {
          st.remoteEdgeInitialized = true;
        } else if (gameAudio) {
          const emitRemoteEdge = (type: number) => {
            const evt = {
              type,
              carIndex: c,
              primaryId: c,
              x: cv.posX ?? 0,
              y: cv.posY ?? 0,
              z: cv.posZ ?? 0,
              speed: Math.hypot(cv.velX ?? 0, cv.velY ?? 0, cv.velZ ?? 0),
              impulse: 0,
              tick: currentTick,
            };
            eventStreamStore.addEvent(evt);
            gameAudio.handleEvent(evt, camera);
          };
          if (!st.prevRemoteJumping && curJumping) {
            emitRemoteEdge(INCIDENT_EVENT_TYPES.CAR_JUMP);
          }
          if (!st.prevRemoteFlipping && curFlipping) {
            emitRemoteEdge(INCIDENT_EVENT_TYPES.CAR_DODGE);
          }
          if (!st.prevRemoteBoosting && curBoosting) {
            emitRemoteEdge(INCIDENT_EVENT_TYPES.CAR_BOOST_START);
          } else if (st.prevRemoteBoosting && !curBoosting) {
            emitRemoteEdge(INCIDENT_EVENT_TYPES.CAR_BOOST_STOP);
          }
          if (!st.prevRemoteSupersonic && curSupersonic) {
            emitRemoteEdge(INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER);
          }
        }
        st.prevRemoteOnGround = curOnGround;
        st.prevRemoteJumping = curJumping;
        st.prevRemoteFlipping = curFlipping;
        st.prevRemoteBoosting = curBoosting;
        st.prevRemoteSupersonic = curSupersonic;
      }
    }

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
        const isLocal = evtCarIdx === playerCarIndex;
        if (
          networkReconciler &&
          !isLocal &&
          (event.type === INCIDENT_EVENT_TYPES.CAR_BOOST_START ||
            event.type === INCIDENT_EVENT_TYPES.BOOST_START ||
            event.type === INCIDENT_EVENT_TYPES.CAR_BOOST_STOP ||
            event.type === INCIDENT_EVENT_TYPES.BOOST_END ||
            event.type === INCIDENT_EVENT_TYPES.CAR_JUMP ||
            event.type === INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP ||
            event.type === INCIDENT_EVENT_TYPES.CAR_DODGE ||
            event.type === INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER)
        ) {
          return;
        }
        const st = this.getCarActionState(evtCarIdx);
        const cv = physics.getCarStateView?.(evtCarIdx);
        const ctrlBase = evtCarIdx * 8;
        const boostCtrl = isLocal
          ? Boolean(playerControls?.boost)
          : physics.controlsView
            ? physics.controlsView[ctrlBase + 6] >= 0.5
            : false;

        if (
          event.type === INCIDENT_EVENT_TYPES.CAR_BOOST_START ||
          event.type === INCIDENT_EVENT_TYPES.BOOST_START
        ) {
          if (
            st.boostLatched ||
            (event.tick > 0 && Math.abs(event.tick - st.lastBoostTick) < 4)
          ) {
            return;
          }
          st.boostLatched = true;
          st.lastBoostTick = event.tick || 0;
        } else if (
          event.type === INCIDENT_EVENT_TYPES.CAR_BOOST_STOP ||
          event.type === INCIDENT_EVENT_TYPES.BOOST_END
        ) {
          if (boostCtrl && (cv?.boost ?? 0) > 0.5) {
            return;
          }
          st.boostLatched = false;
        } else if (event.type === INCIDENT_EVENT_TYPES.CAR_JUMP) {
          if (
            st.hasSingleJumped ||
            (event.tick > 0 && Math.abs(event.tick - st.lastJumpTick) < 6)
          ) {
            return;
          }
          st.hasSingleJumped = true;
          st.jumpReleasedSinceSingleJump = !Boolean(playerControls?.jump);
          st.lastJumpTick = event.tick || 0;
        } else if (
          event.type === INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP ||
          event.type === INCIDENT_EVENT_TYPES.CAR_DODGE
        ) {
          if (
            st.hasAirJumped ||
            (event.tick > 0 && Math.abs(event.tick - st.lastAirJumpTick) < 6)
          ) {
            return;
          }
          st.hasAirJumped = true;
          st.lastAirJumpTick = event.tick || 0;
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
        const st = this.getCarActionState(targetCarIdx);
        const cv = physics.getCarStateView?.(targetCarIdx);

        if (!isBallFlipResetEvent(event)) {
          if (!cv?.isFlipping) {
            st.hasAirJumped = false;
          }
          st.jumpReleasedSinceSingleJump = true;
          onModePhysicsEvent(event);
          return;
        }

        const nowMs = performance.now();
        const tickDelta =
          event.tick > 0 && st.lastFlipResetTick > 0
            ? Math.abs(event.tick - st.lastFlipResetTick)
            : Infinity;
        const timeDeltaMs = nowMs - st.lastFlipResetTimeMs;
        if (tickDelta < 60 || timeDeltaMs < 500) {
          return;
        }
        if (!cv?.isFlipping) {
          st.hasAirJumped = false;
        }
        st.jumpReleasedSinceSingleJump = true;
        st.lastFlipResetTick = event.tick || 0;
        st.lastFlipResetTimeMs = nowMs;
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

    const localIdx = playerCarIndex ?? 0;
    if (
      networkReconciler &&
      localIdx >= 0 &&
      localIdx < 8 &&
      (typeof physics.isCarSlotActive !== 'function' || physics.isCarSlotActive(localIdx))
    ) {
      const st = this.getCarActionState(localIdx);
      const cv = physics.getCarStateView?.(localIdx);
      if (cv) {
        const curJumping = Boolean(cv.isJumping);
        const curFlipping = Boolean(cv.isFlipping);
        const risingJump = st.localEdgeInitialized
          ? !st.prevLocalJumping && curJumping
          : curJumping;
        const risingFlip = st.localEdgeInitialized
          ? !st.prevLocalFlipping && curFlipping
          : curFlipping;
        st.localEdgeInitialized = true;
        st.prevLocalJumping = curJumping;
        st.prevLocalFlipping = curFlipping;
        const emitLocalFallback = (type: number) => {
          const evt = {
            type,
            carIndex: localIdx,
            primaryId: localIdx,
            x: cv.posX ?? 0,
            y: cv.posY ?? 0,
            z: cv.posZ ?? 0,
            speed: Math.hypot(cv.velX ?? 0, cv.velY ?? 0, cv.velZ ?? 0),
            impulse: 0,
            tick: currentTick,
          };
          eventStreamStore.addEvent(evt);
          onModePhysicsEvent(evt);
          if (gameAudio) {
            gameAudio.handleEvent(evt, camera);
          }
        };
        if (
          risingJump &&
          !st.hasSingleJumped &&
          Math.abs(currentTick - st.lastJumpTick) >= 6
        ) {
          st.hasSingleJumped = true;
          st.jumpReleasedSinceSingleJump = !Boolean(playerControls?.jump);
          st.lastJumpTick = currentTick;
          emitLocalFallback(INCIDENT_EVENT_TYPES.CAR_JUMP);
        }
        if (
          risingFlip &&
          !st.hasAirJumped &&
          Math.abs(currentTick - st.lastAirJumpTick) >= 6
        ) {
          st.hasAirJumped = true;
          st.lastAirJumpTick = currentTick;
          emitLocalFallback(INCIDENT_EVENT_TYPES.CAR_DODGE);
        }
      }
    }
  }
}
