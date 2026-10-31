import {
  PHYSICS_EVENT_TYPES,
  INCIDENT_EVENT_TYPES,
  isBallFlipResetEvent,
  isDiagnosticProbeSlot
} from '../../../physics/RocketSimConstants.js';
import { eventStreamStore } from '../../../ui-core/stores/eventStreamStore';
import { isEventLogEnabled } from '../../../ui-core/config/audioConfig.js';
import { gameAudioEngine } from '../../../audio/GameAudioEngineFacade.js';
import { applyReplayFrameToEngine } from '../../../replay/ReplayFrameInterpolator.js';

/**
 * SimulationStage.js
 * Advances deterministic 120Hz physics accumulator, network reconciliation,
 * and processes native debounced collision events.
 */
export class SimulationStage {
  constructor(runtime) {
    this.runtime = runtime;
    this._carActionStates = new Map();
    this._lastSeenPhysicsTick = -1;
    this._pendingGoalScored = false;
  }

  resetActionStates() {
    this._carActionStates.clear();
    this._lastSeenPhysicsTick = -1;
    this._pendingGoalScored = false;
    if (gameAudioEngine?.incidentEngine) {
      const inc = gameAudioEngine.incidentEngine;
      inc.lastCarBallHitTimestamp = 0;
      inc.lastCarCollisionTimestamp = 0;
      inc.lastBoostPickupByPad?.clear?.();
      if (inc.worldImpactHandler) {
        inc.worldImpactHandler.lastGoalpostHitTimestamp = 0;
        inc.worldImpactHandler.lastBallWorldHitTimestamp = 0;
      }
    }
    if (gameAudioEngine?.vehicleManager) {
      gameAudioEngine.vehicleManager._lastFlipResetMsByCar?.clear?.();
    }
  }

  resetCarActionStates() {
    this.resetActionStates();
  }

  _getCarActionState(carIdx) {
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
        remoteEdgeInitialized: false,
        prevRemoteOnGround: true,
        prevRemoteJumping: false,
        prevRemoteFlipping: false,
        prevRemoteBoosting: false,
        prevRemoteSupersonic: false
      };
      this._carActionStates.set(carIdx, st);
    }
    return st;
  }

  execute(context) {
    const r = this.runtime;
    const { timestamp } = context;

    const isMatchEnded =
      (r.match.state.mode === 'match' || r.match.state.mode === 'exp-multi-bots') &&
      (r.match.state.phase === 'ended' || r.match.state.phase === 'podium');
    const isGoalReplay =
      (r.match.state.mode === 'match' ||
        r.match.state.mode === 'exp-multi-bots' ||
        r.match.state.mode === 'freeplay' ||
        r.match.state.mode === 'replay-viewer' ||
        r.match.state.mode === 'static-training-pack') &&
      r.match.state.phase === 'replay';

    // 1. Advance Physics Interpolator accumulator
    if (r.match.state.paused || isMatchEnded || isGoalReplay) {
      if (!isGoalReplay && !r.podiumController?.isActive) {
        r.interpolator.sync(timestamp);
      }
    } else {
      const isLocalSinglePlayerBotMatch = Boolean(
        r.isBotMatch &&
        r.match.state.mode === 'match' &&
        !r.authoritativeServer &&
        !r.networkReconciler
      );

      r.interpolator.update(
        timestamp,
        () => {
          r.pollInputs();
          if (r.playerCarIndex >= 0 && !r.playerControls?.jump) {
            this._getCarActionState(r.playerCarIndex).jumpReleasedSinceSingleJump = true;
          }
          if (r.diagnosticsFleetController?.enabled && r.physics && !r.networkReconciler) {
            const cTick = Math.floor(r.physics.getHeaderView().tickCount);
            r.diagnosticsFleetController.applyToAuthority(r.physics, cTick);
          }
          if (
            r.match.state.mode === 'freeplay' ||
            r.match.state.mode === 'replay-viewer' ||
            r.match.state.mode === 'kickoff-training' ||
            r.match.state.mode === 'dev-test-lab' ||
            r.match.state.mode === 'exp-multi-bots' ||
            r.match.state.mode === 'static-training-pack'
          ) {
            return r.modeManager.getActiveMode()?.onBeforePhysicsTick?.();
          }
        },
        isLocalSinglePlayerBotMatch
          ? () => r.stepBot()
          : (r.match.state.mode === 'kickoff-training')
            ? () => r.modeManager.getActiveMode()?.onStepPhysicsTick?.()
            : (r.match.state.mode === 'freeplay' ||
               r.match.state.mode === 'replay-viewer' ||
               r.match.state.mode === 'dev-test-lab' ||
               r.match.state.mode === 'exp-multi-bots' ||
               r.match.state.mode === 'static-training-pack')
              ? () => {
                  r.physics.step(1);
                  r.modeManager.getActiveMode()?.onAfterPhysicsTick?.();
                  return true;
                }
              : undefined
      );
    }

    // 2. Poll Goal Event (only directly poll & clear WASM goal flag when not driven by authoritative network reconciler)
    const activeSim = r.physics;
    if (r.networkReconciler) {
      context.goalScored = r.match.state.phase === 'goal';
    } else {
      if (activeSim.pollGoal() !== 0) {
        this._pendingGoalScored = true;
      }
      context.goalScored = Boolean(this._pendingGoalScored);
      if (!context.isSimulationOnly) {
        this._pendingGoalScored = false;
      }
    }

    // 3. Network Prediction & Authoritative Server update
    if (r.networkReconciler) {
      const now = performance.now();
      if (r.authoritativeServer) {
        if (r.diagnosticsFleetController?.enabled && !r.authoritativeServer.isWorker) {
          const sTick = Math.floor(r.authoritativeServer.sim?.getHeaderView?.()?.tickCount ?? 0);
          r.diagnosticsFleetController.applyToAuthority(r.authoritativeServer, sTick);
        }
        r.authoritativeServer.update(now);
      }
      const tickBeforeReconcile = Math.floor(r.physics.getHeaderView().tickCount);
      r.networkReconciler.reconcile(now);
      if (
        r.match.state.paused ||
        isMatchEnded ||
        isGoalReplay ||
        r.networkReconciler.replayPlaybackMode ||
        r.match.state.phase === 'prepare'
      ) {
        r.networkReconciler.flushPendingControlPackets?.(now);
      }
      const tickAfterReconcile = Math.floor(r.physics.getHeaderView().tickCount);
      if (
        r.interpolator &&
        !isGoalReplay &&
        !r.networkReconciler.replayPlaybackMode &&
        r.physics?.state
      ) {
        let hadStateNaN = false;
        const st = r.physics.state;
        if (!Number.isFinite(st[4]) || !Number.isFinite(st[5]) || !Number.isFinite(st[6])) {
          hadStateNaN = true;
        }
        const nCars = Math.min(r.physics.numCars || 1, 8);
        for (let c = 0; c < nCars; c++) {
          if (typeof r.physics.isCarSlotActive === 'function' && !r.physics.isCarSlotActive(c)) continue;
          const cOff = 22 + c * 40;
          if (!Number.isFinite(st[cOff]) || !Number.isFinite(st[cOff + 1]) || !Number.isFinite(st[cOff + 2])) {
            hadStateNaN = true;
            break;
          }
        }
        if (hadStateNaN) {
          r.physics.restoreCompactState?.(st, { preserveEngineTick: true });
          r.interpolator.sync(timestamp);
          r.camera?.resetView?.();
        } else {
          r.interpolator.currState.set(st);
          if (
            tickAfterReconcile !== tickBeforeReconcile ||
            (r.networkReconciler.metrics.lastCorrectionDelta > 0.05 && !r.networkReconciler.enableSmoothing)
          ) {
            r.interpolator.prevState.set(st);
          }
        }
      }
      if (
        r.networkReconciler.replayPlaybackMode &&
        Array.isArray(r.networkReconciler.drainedReplayPackets) &&
        r.networkReconciler.drainedReplayPackets.length > 0
      ) {
        const ctrl = r.replayTimelineController;
        const isCustomScrubbing = Boolean(
          ctrl &&
          (ctrl.isScrubbing || ctrl.isPaused || Math.abs((ctrl.playbackSpeed ?? 1.0) - 1.0) > 0.01)
        );
        for (let i = 0; i < r.networkReconciler.drainedReplayPackets.length; i++) {
          const pkt = r.networkReconciler.drainedReplayPackets[i];
          if (!pkt || !pkt.stateSnapshot) continue;
          if (ctrl) {
            if (!ctrl.isActive) {
              ctrl.beginReplaySession({
                scoringTeam: r.match?.state?.scorer ?? 0,
                isNetworkStreamed: true
              });
            }
            ctrl.appendStreamedReplayFrame?.(
              pkt.stateSnapshot,
              pkt.serverTick,
              pkt.acknowledgedControls
            );
          }
          if (r.physics && !isCustomScrubbing) {
            applyReplayFrameToEngine(r.physics, pkt.stateSnapshot, r.interpolator);
            if (!r.match.state.paused && !isMatchEnded) {
              const maxFrames = r.diagnosticDumpMaxFrames || 36000;
              const curFrames = r.physics.getReplayFrameCount?.() ?? 0;
              if (curFrames >= maxFrames) {
                r.physics.setReplayRecordingActive?.(false);
                r.clientReplayOverflowPaused = true;
              } else if (r.physics.getReplayRecordingActive?.() !== false) {
                r.physics.recordReplayFrame?.();
                r.clientReplayOverflowPaused = false;
              }
            }
          }
        }
        r.networkReconciler.drainedReplayPackets.length = 0;
      } else if (
        r.physics &&
        !r.match.state.paused &&
        !isMatchEnded &&
        !isGoalReplay &&
        !r.networkReconciler.replayPlaybackMode &&
        tickAfterReconcile !== this._lastRecordedClientReplayTick
      ) {
        const maxFrames = r.diagnosticDumpMaxFrames || 36000;
        const curFrames = r.physics.getReplayFrameCount?.() ?? 0;
        if (curFrames >= maxFrames) {
          r.physics.setReplayRecordingActive?.(false);
          r.clientReplayOverflowPaused = true;
        } else if (r.physics.getReplayRecordingActive?.() !== false) {
          r.physics.recordReplayFrame?.();
          this._lastRecordedClientReplayTick = tickAfterReconcile;
          r.clientReplayOverflowPaused = false;
        }
      }
    }

    // 4. Update isMatchActive flag
    const activeMode = r.modeManager?.getActiveMode();
    const isGoalReplayPaused = Boolean(
      isGoalReplay && activeMode?.replayController?.isPaused
    );
    const isStandaloneViewerPaused = Boolean(
      activeMode?.standaloneReplayViewer?.hasLoadedReplay &&
      activeMode.standaloneReplayViewer.getViewerState?.() === 'paused'
    );
    const isRewinderPausedScrub = Boolean(
      activeMode?.rewinderController &&
      activeMode.rewinderController.getRewinderState?.() === 'paused-scrub'
    );
    const isReplayPaused =
      isGoalReplayPaused || isStandaloneViewerPaused || isRewinderPausedScrub;
    context.isMatchActive =
      !isReplayPaused &&
      (r.match.state.mode === 'freeplay' ||
        r.match.state.mode === 'replay-viewer' ||
        r.match.state.mode === 'kickoff-training' ||
        r.match.state.mode === 'dev-test-lab' ||
        r.match.state.mode === 'exp-multi-bots' ||
        r.match.state.mode === 'static-training-pack' ||
        (!r.match.state.paused && (
          r.match.state.phase === 'playing' ||
          r.match.state.phase === 'kickoff' ||
          r.match.state.phase === 'goal'
        )));

    // 5. Read Native Collision Events
    if (r.physics) {
      const currentTick = Math.floor(r.physics.getHeaderView?.()?.tickCount ?? 0);
      if (this._lastSeenPhysicsTick >= 0 && currentTick < this._lastSeenPhysicsTick) {
        this.resetActionStates();
      }
      this._lastSeenPhysicsTick = currentTick;

      const ballPosY = Math.abs(r.physics.getBallStateView?.()?.posY || 0);
      if (ballPosY < 5000 && r.match.state.phase !== 'goal') {
        r._clientGoalIncidentLatched = false;
      }

      for (let c = 0; c < 8; c++) {
        if (typeof r.physics.isCarSlotActive === 'function' && !r.physics.isCarSlotActive(c)) {
          continue;
        }
        const st = this._getCarActionState(c);
        const cv = r.physics.getCarStateView?.(c);
        const isLocal = c === r.playerCarIndex;
        const ctrlBase = c * 8;
        const jumpCtrl = isLocal
          ? Boolean(r.playerControls?.jump)
          : (r.physics.controlsView ? r.physics.controlsView[ctrlBase + 5] >= 0.5 : false);
        const boostCtrl = isLocal
          ? Boolean(r.playerControls?.boost)
          : (r.physics.controlsView ? r.physics.controlsView[ctrlBase + 6] >= 0.5 : false);

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

        // Presentation-frame state-edge audio detection for remote cars in online mode
        if (r.networkReconciler && !isLocal && cv) {
          if (isDiagnosticProbeSlot(c) && !r.testCarAudioEnabled) {
            continue;
          }
          if (r.networkReconciler.lobbyDualWorldMode && c !== 6 && c !== 7) {
            continue;
          }
          const curOnGround = Boolean(cv.isOnGround);
          const curJumping = Boolean(cv.isJumping);
          const curFlipping = Boolean(cv.isFlipping);
          const curBoosting = Boolean(cv.isBoosting);
          const curSupersonic = Boolean(cv.isSupersonic);

          if (!st.remoteEdgeInitialized) {
            st.remoteEdgeInitialized = true;
          } else if (gameAudioEngine) {
            const emitRemoteEdge = (type) => {
              const evt = {
                type,
                carIndex: c,
                primaryId: c,
                x: cv.posX ?? 0,
                y: cv.posY ?? 0,
                z: cv.posZ ?? 0,
                speed: Math.hypot(cv.velX ?? 0, cv.velY ?? 0, cv.velZ ?? 0),
                impulse: 0,
                tick: currentTick
              };
              eventStreamStore.addEvent(evt);
              gameAudioEngine.handleEvent(evt, r.camera);
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
              emitRemoteEdge(INCIDENT_EVENT_TYPES.SUPERSONIC_START);
            }
            if (!st.prevRemoteOnGround && curOnGround) {
              emitRemoteEdge(INCIDENT_EVENT_TYPES.CAR_LANDED);
            }
          }
          st.prevRemoteOnGround = curOnGround;
          st.prevRemoteJumping = curJumping;
          st.prevRemoteFlipping = curFlipping;
          st.prevRemoteBoosting = curBoosting;
          st.prevRemoteSupersonic = curSupersonic;
        }
      }

      r.physics.readEvents((event) => {
        const evtCarIdx = event.carIndex ?? event.primaryId ?? -1;
        if ((evtCarIdx === 6 || evtCarIdx === 7) && !r.testCarAudioEnabled) {
          return;
        }
        if (
          r.networkReconciler?.lobbyDualWorldMode &&
          evtCarIdx >= 0 &&
          evtCarIdx < 65535 &&
          evtCarIdx !== r.playerCarIndex
        ) {
          return;
        }

        if (evtCarIdx >= 0 && evtCarIdx < 8) {
          const isLocal = evtCarIdx === r.playerCarIndex;
          if (
            r.networkReconciler &&
            !isLocal &&
            (event.type === INCIDENT_EVENT_TYPES.CAR_BOOST_START ||
              event.type === INCIDENT_EVENT_TYPES.BOOST_START ||
              event.type === INCIDENT_EVENT_TYPES.CAR_BOOST_STOP ||
              event.type === INCIDENT_EVENT_TYPES.BOOST_END ||
              event.type === INCIDENT_EVENT_TYPES.CAR_JUMP ||
              event.type === INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP ||
              event.type === INCIDENT_EVENT_TYPES.CAR_DODGE ||
              event.type === INCIDENT_EVENT_TYPES.CAR_LANDED ||
              event.type === INCIDENT_EVENT_TYPES.SUPERSONIC_START)
          ) {
            return;
          }
          const st = this._getCarActionState(evtCarIdx);
          const cv = r.physics.getCarStateView?.(evtCarIdx);
          const ctrlBase = evtCarIdx * 8;
          const boostCtrl = isLocal
            ? Boolean(r.playerControls?.boost)
            : (r.physics.controlsView ? r.physics.controlsView[ctrlBase + 6] >= 0.5 : false);

          if (event.type === INCIDENT_EVENT_TYPES.CAR_BOOST_START || event.type === INCIDENT_EVENT_TYPES.BOOST_START) {
            if (st.boostLatched || (event.tick > 0 && Math.abs(event.tick - st.lastBoostTick) < 4)) {
              return;
            }
            st.boostLatched = true;
            st.lastBoostTick = event.tick || 0;
          } else if (event.type === INCIDENT_EVENT_TYPES.CAR_BOOST_STOP || event.type === INCIDENT_EVENT_TYPES.BOOST_END) {
            if (boostCtrl && (cv?.boost ?? 0) > 0.5) {
              return;
            }
            st.boostLatched = false;
          } else if (event.type === INCIDENT_EVENT_TYPES.CAR_JUMP) {
            if (st.hasSingleJumped || (event.tick > 0 && Math.abs(event.tick - st.lastJumpTick) < 6)) {
              return;
            }
            st.hasSingleJumped = true;
            st.jumpReleasedSinceSingleJump = !Boolean(r.playerControls?.jump);
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
          } else if (event.type === INCIDENT_EVENT_TYPES.CAR_LANDED) {
            st.hasSingleJumped = false;
            st.hasAirJumped = false;
          }
        }

        if (event.type === INCIDENT_EVENT_TYPES.GOAL_SCORED || event.type === 0x0E) {
          if (r._clientGoalIncidentLatched || isMatchEnded || r.match.state.phase === 'replay') {
            return;
          }
          r._clientGoalIncidentLatched = true;
        }

        if (event.type === PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED || event.type === INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED) {
          const targetCarIdx = typeof event.carIndex === 'number' && event.carIndex >= 0 ? event.carIndex : r.playerCarIndex;
          if (r.networkReconciler && !r.networkReconciler.lobbyDualWorldMode && targetCarIdx !== r.playerCarIndex) {
            return;
          }
          const st = this._getCarActionState(targetCarIdx);
          st.hasAirJumped = false;
          st.jumpReleasedSinceSingleJump = true;

          // Notify active mode of the raw detachment event (ball, car, ceiling, backboard, etc.)
          if (!isBallFlipResetEvent(event)) {
            r.modeManager?.getActiveMode()?.onPhysicsEvent?.(event);
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
          st.lastFlipResetTick = event.tick || 0;
          st.lastFlipResetTimeMs = nowMs;
        }

        if (isEventLogEnabled(event.type)) {
          console.log(`[Physics Incident 0x${event.type.toString(16).padStart(2, '0')}]`, event);
        }

        eventStreamStore.addEvent(event);
        r.modeManager?.getActiveMode()?.onPhysicsEvent?.(event);

        if (
          (event.type === PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED || event.type === INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED) &&
          isBallFlipResetEvent(event)
        ) {
          const targetCarIdx = typeof event.carIndex === 'number' && event.carIndex >= 0 ? event.carIndex : r.playerCarIndex;
          const visual = r.getFlipResetVisual(targetCarIdx);
          if (visual) {
            visual.play();
          }
        }

        if (event.isGoalBarrierHit) {
          r.arena?.triggerGoalBarrierImpact?.(event.x, event.y, event.z);
        }

        if (gameAudioEngine) {
          gameAudioEngine.handleEvent(event, r.camera);
        }
      });

      // Fallback state-edge detection for the local car in online mode in case a jump/dodge
      // transition occurred inside a silent reconciliation step without emitting a native event.
      const localIdx = r.playerCarIndex ?? 0;
      if (
        r.networkReconciler &&
        localIdx >= 0 &&
        localIdx < 8 &&
        (typeof r.physics.isCarSlotActive !== 'function' || r.physics.isCarSlotActive(localIdx))
      ) {
        const st = this._getCarActionState(localIdx);
        const cv = r.physics.getCarStateView?.(localIdx);
        if (cv) {
          const curJumping = Boolean(cv.isJumping);
          const curFlipping = Boolean(cv.isFlipping);
          const emitLocalFallback = (type) => {
            const evt = {
              type,
              carIndex: localIdx,
              primaryId: localIdx,
              x: cv.posX ?? 0,
              y: cv.posY ?? 0,
              z: cv.posZ ?? 0,
              speed: Math.hypot(cv.velX ?? 0, cv.velY ?? 0, cv.velZ ?? 0),
              impulse: 0,
              tick: currentTick
            };
            eventStreamStore.addEvent(evt);
            r.modeManager?.getActiveMode()?.onPhysicsEvent?.(evt);
            if (gameAudioEngine) {
              gameAudioEngine.handleEvent(evt, r.camera);
            }
          };
          if (curJumping && !st.hasSingleJumped && Math.abs(currentTick - st.lastJumpTick) >= 6) {
            st.hasSingleJumped = true;
            st.jumpReleasedSinceSingleJump = !Boolean(r.playerControls?.jump);
            st.lastJumpTick = currentTick;
            emitLocalFallback(INCIDENT_EVENT_TYPES.CAR_JUMP);
          }
          if (curFlipping && !st.hasAirJumped && Math.abs(currentTick - st.lastAirJumpTick) >= 6) {
            st.hasAirJumped = true;
            st.lastAirJumpTick = currentTick;
            emitLocalFallback(INCIDENT_EVENT_TYPES.CAR_DODGE);
          }
        }
      }
    }

    if (r.profiler && !context.isSimulationOnly) r.profiler.mark();
  }
}
