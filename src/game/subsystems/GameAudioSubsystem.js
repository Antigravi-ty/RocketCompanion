import { EMotorSynth } from '../../audio/EMotorSynth.js';
import { getAudioContext, getMasterAudioInput, subsystemState, registerAudioRuntime } from '../../audio/audioContext.js';
import { getAudioSettings } from '../../ui-core/config/audioConfig.js';
import { gameAudio, gameAudioEngine } from '../../audio/GameAudioEngineFacade.js';
import { isSignalAudioMutedInGoalReplay } from '../../audio/SignalAudioEngine.js';
import { updateAudioListener, SpatialAudioSource } from '../../audio/SpatialAudioSource.js';
import { CarStateView } from '../../physics/RocketSimStateViews.js';
import { INCIDENT_EVENT_TYPES, DIAGNOSTIC_PROBE_SLOTS, isDiagnosticProbeSlot } from '../../physics/RocketSimConstants.js';
import { hudStore } from '../../ui-core/stores/hudStore';

/**
 * GameAudioSubsystem.js
 * Encapsulates multi-car procedural EMotorSynth synthesis, spatial audio bus tracking,
 * vehicle listeners, ball acoustics, and lifecycle game sound effects.
 */
export class GameAudioSubsystem {
  /**
   * @param {object} runtime
   */
  constructor(runtime) {
    this.runtime = runtime;
    this.engineSynths = [];
    this._lobbyCarViews = Array.from({ length: 8 }, () => new CarStateView());
    this._prevTestCarBoosting = { 6: false, 7: false };
    registerAudioRuntime(runtime);
  }

  async setupAudio(onProgress = null) {
    const r = this.runtime;
    await Promise.all([
      gameAudioEngine.preload(onProgress),
      r.flipResetVisual?.preloadAudio?.(),
      r.arena?.prepareAssets?.()
    ]);
  }

  resetAudio() {
    const r = this.runtime;
    for (const eng of this.engineSynths) {
      eng.synth?.reset?.();
      eng.synth?.silence?.();
      eng.spatialBus?.setEnabled?.(false);
    }
    gameAudioEngine?.silenceAll?.();
    r.audioLastGoalScored = false;
    r.audioLastCountdown = -1;
    r.audioLast10sCountdown = -1;
    r.audioLastBoostPressed = false;
  }

  triggerGameAudioEvents(goalScored, curBoost, isSupersonic, curr) {
    const r = this.runtime;
    const audio = r.options.gameAudio || gameAudio;
    if (!audio) return;

    if (isSignalAudioMutedInGoalReplay(r)) {
      r.audioLastGoalScored = Boolean(goalScored || (r.match.state.mode === 'match' && r.match.state.phase === 'goal'));
      r.audioLastRemainingSec = r.match.state.remainingSeconds;
      r.audioLastOvertime = r.match.state.overtime;
      r.audioLastPhase = r.match.state.phase;
      r.audioLastBoostPressed = Boolean(r.playerControls && r.playerControls.boost);
      return;
    }

    const isGoalNow = goalScored || (r.match.state.mode === 'match' && r.match.state.phase === 'goal');
    if (isGoalNow && !r.audioLastGoalScored && !r.networkReconciler) {
      audio.play('sfx_goal_poof', 1.0);
    }
    r.audioLastGoalScored = isGoalNow;

    if (r.networkReconciler) {
      if (r.match?.state?.phase === 'kickoff' && typeof r.lastKickoffTargetFrame === 'number' && r.lastKickoffTargetFrame > 0) {
        const currentTick = r.networkReconciler.lastAckedServerTick >= 0
          ? r.networkReconciler.lastAckedServerTick
          : (r.networkReconciler.serverTick ?? 0);
        const remainingTicks = Math.max(0, r.lastKickoffTargetFrame - currentTick);
        if (remainingTicks > 0) {
          const rawSec = Math.max(1, Math.min(3, Math.ceil(remainingTicks / 120)));
          const prevSec = typeof r.match.state.countdown === 'number' && r.match.state.countdown >= 1
            ? r.match.state.countdown
            : 3;
          const displaySec = Math.min(prevSec, rawSec);

          if (r.match.state.countdown !== displaySec) {
            r.match.state.countdown = displaySec;
            hudStore.getState().setMatchState({
              matchPhase: 'kickoff',
              kickoffCountdown: displaySec
            });
          }
        }

        if (!r.latchedKickoffSeconds) {
          r.latchedKickoffSeconds = new Set();
        }
        if (remainingTicks <= 360 && remainingTicks > 240 && !r.latchedKickoffSeconds.has(3)) {
          r.latchedKickoffSeconds.add(3);
          audio.play('match_countdown_321', 1.0);
        } else if (remainingTicks <= 240 && remainingTicks > 120 && !r.latchedKickoffSeconds.has(2)) {
          r.latchedKickoffSeconds.add(2);
          audio.play('match_countdown_321', 1.0);
        } else if (remainingTicks <= 120 && remainingTicks > 0 && !r.latchedKickoffSeconds.has(1)) {
          r.latchedKickoffSeconds.add(1);
          audio.play('match_countdown_321', 1.0);
        } else if (currentTick >= r.lastKickoffTargetFrame + 12) {
          console.warn(
            `[GameAudioSubsystem:Fallback] Authoritative KICKOFF_START signal not observed by tick ${currentTick} (target=${r.lastKickoffTargetFrame}); releasing local kickoff lock.`
          );
          r.networkReconciler.setKickoffMaskUntilTick?.(-1);
          r.lastKickoffTargetFrame = -1;
          r.latchedKickoffSeconds?.clear();
          r.match.state.phase = 'playing';
          r.match.state.countdown = 0;
          hudStore.getState().setMatchState({
            matchPhase: 'playing',
            kickoffCountdown: 0
          });
          audio.play('match_start_go', 1.0);
        }
      }
    } else {
      if (r.match.state.mode === 'match' && !r.match.state.overtime && r.match.state.phase === 'playing') {
        if (
          r.audioLastRemainingSec > 60 &&
          r.match.state.remainingSeconds <= 60 &&
          r.match.state.remainingSeconds > 30
        ) {
          audio.play('match_60_seconds_left', 1.0, 10000);
        }
        if (
          r.audioLastRemainingSec > 30 &&
          r.match.state.remainingSeconds <= 30 &&
          r.match.state.remainingSeconds > 0
        ) {
          audio.play('match_30_seconds_left', 1.0, 10000);
        }
      }

      if (r.match.state.mode === 'match' && !r.match.state.overtime && r.match.state.phase === 'playing') {
        const remSec = Math.ceil(r.match.state.remainingSeconds);
        if (remSec <= 10 && remSec >= 1 && remSec !== r.audioLast10sCountdown) {
          r.audioLast10sCountdown = remSec;
          audio.play('match_countdown_10s', 1.0);
        } else if (remSec > 10 || remSec <= 0) {
          r.audioLast10sCountdown = -1;
        }
      }

      if (r.match.state.mode === 'match' && r.match.state.overtime && !r.audioLastOvertime) {
        audio.play('match_entering_overtime', 1.0, 10000);
      }

      if (r.match.state.mode === 'match' && r.match.state.phase === 'kickoff') {
        const currentCount = Math.ceil(r.match.state.countdown);
        if (currentCount >= 1 && currentCount <= 3 && currentCount !== r.audioLastCountdown) {
          r.audioLastCountdown = currentCount;
          audio.play('match_countdown_321', 1.0);
        }
      } else {
        r.audioLastCountdown = -1;
      }

      if (r.match.state.mode === 'match' && r.audioLastPhase === 'kickoff' && r.match.state.phase === 'playing') {
        audio.play('match_start_go', 1.0);
      }

      r.audioLastRemainingSec = r.match.state.remainingSeconds;
      r.audioLastOvertime = r.match.state.overtime;
      r.audioLastPhase = r.match.state.phase;
    }

    const isBoostPressed = Boolean(r.playerControls && r.playerControls.boost);
    if (isBoostPressed && !r.audioLastBoostPressed && curBoost <= 0.001) {
      audio.play('sfx_error_no_boost', 0.85);
    }
    r.audioLastBoostPressed = isBoostPressed;
  }

  update(context) {
    const r = this.runtime;
    const { dt, activeCar, activeCarMesh, playerCarView, numCarsInArena, isMatchActive, hasBlockingOverlay, continueOnBlur, isHidden, goalScored, curBoost, isSupersonic } = context;

    if (!r.camera?.camera) return;

    // 1. Update 3D Audio Listener
    updateAudioListener(r.camera.camera);

    const isAudibleActive =
      !hasBlockingOverlay && Boolean(isMatchActive) && (!isHidden || Boolean(continueOnBlur));

    // 2. Update Ball Spatial Acoustics
    if (gameAudioEngine && typeof gameAudioEngine.updateBallAudio === 'function' && r.arena?.ball) {
      if (isAudibleActive) {
        gameAudioEngine.updateBallAudio(r.arena.ball, r.camera, r.physics);
      } else {
        gameAudioEngine.ballEngine?.silenceAll?.();
      }
    }

    const testCarAudioEnabled = Boolean(r.testCarAudioEnabled);
    const isLobbyDualWorld = Boolean(r.networkReconciler?.lobbyDualWorldMode);
    const lobbyState = isLobbyDualWorld ? r.networkReconciler.lobbyCurrAuthoritativeState : null;
    const lobbyNumCars = lobbyState ? Math.min(8, Math.max(0, Math.round(lobbyState[1] || 0))) : 0;
    const effectiveNumCars = Math.max(numCarsInArena, testCarAudioEnabled ? lobbyNumCars : 0);

    const resolveCarView = (i) => {
      if (isDiagnosticProbeSlot(i) && !testCarAudioEnabled) {
        return null;
      }
      if (isLobbyDualWorld && i !== activeCar) {
        if (i >= 1 && i < 6) {
          return null;
        }
        if (lobbyState && i < lobbyNumCars) {
          const view = this._lobbyCarViews[i].attachCar(lobbyState, i);
          if (view.posZ <= -200 || view.posX < -5000 || view.isDemoed) {
            return null;
          }
          return view;
        }
        return null;
      }
      const cView = r.interpolator?.getCurrCarStateView(i);
      if (!cView || cView.posZ <= -200 || cView.posX < -5000) {
        return null;
      }
      return cView;
    };

    if (isLobbyDualWorld && lobbyState && gameAudioEngine) {
      for (const testIdx of DIAGNOSTIC_PROBE_SLOTS) {
        const view = testCarAudioEnabled ? resolveCarView(testIdx) : null;
        const nowBoosting = Boolean(view && view.isBoosting && !view.isDemoed);
        const wasBoosting = Boolean(this._prevTestCarBoosting[testIdx]);
        if (nowBoosting !== wasBoosting) {
          this._prevTestCarBoosting[testIdx] = nowBoosting;
          if (testCarAudioEnabled && view) {
            gameAudioEngine.handleEvent({
              type: nowBoosting ? INCIDENT_EVENT_TYPES.CAR_BOOST_START : INCIDENT_EVENT_TYPES.CAR_BOOST_STOP,
              carIndex: testIdx,
              carPosX: view.posX,
              carPosY: view.posY,
              carPosZ: view.posZ,
              x: view.posX,
              y: view.posY,
              z: view.posZ
            }, r.camera);
          }
        }
      }
    } else {
      for (const testIdx of DIAGNOSTIC_PROBE_SLOTS) {
        this._prevTestCarBoosting[testIdx] = false;
      }
    }

    // 3. Multi-car Procedural EMotorSynth Engine Audio
    const audioCtx = getAudioContext();
    const masterInput = getMasterAudioInput();

    while (this.engineSynths.length < Math.max(2, effectiveNumCars)) {
      const carIndex = this.engineSynths.length;
      const isSpatial = carIndex !== activeCar;
      let spatialBus = null;
      let synth = null;
      if (audioCtx) {
        if (isSpatial) {
          spatialBus = new SpatialAudioSource(audioCtx, masterInput);
          synth = new EMotorSynth(audioCtx, spatialBus.input);
        } else {
          synth = new EMotorSynth(audioCtx, masterInput);
        }
      }
      this.engineSynths.push({
        synth,
        spatialBus,
        spatial: isSpatial,
        position: { x: 0, y: 0, z: 0 }
      });
    }

    const settings = getAudioSettings();
    const engineVol = (settings.engineVolume ?? 0.8) * (settings.masterVolume ?? 1.0);

    for (let i = 0; i < this.engineSynths.length; i++) {
      const entry = this.engineSynths[i];
      const isThisActiveCar = i === activeCar;
      const carView = i < effectiveNumCars ? resolveCarView(i) : null;
      const isCarValid = Boolean(carView);

      if (entry.spatial === isThisActiveCar && entry.synth?.outputNode) {
        entry.spatial = !isThisActiveCar;
        try {
          entry.synth.outputNode.disconnect();
          if (entry.spatial) {
            if (!entry.spatialBus && audioCtx) {
              entry.spatialBus = new SpatialAudioSource(audioCtx, masterInput);
            }
            if (entry.spatialBus) {
              entry.synth.outputNode.connect(entry.spatialBus.input);
            }
          } else {
            entry.synth.outputNode.connect(masterInput);
          }
        } catch (e) {
          console.warn('[GameAudioSubsystem] Spatial audio routing update failed:', e);
        }
      }

      if (!isCarValid) {
        entry.synth?.silence();
        entry.spatialBus?.setEnabled(false);
        continue;
      }

      let carPos;
      if (isThisActiveCar && activeCarMesh) {
        carPos = activeCarMesh.position;
      } else if (r.arena?.cars?.[i]?.visible && r.arena?.cars?.[i]?.position) {
        carPos = r.arena.cars[i].position;
      } else {
        if (!this._scratchCarAudioPos) {
          this._scratchCarAudioPos = { x: 0, y: 0, z: 0 };
        }
        this._scratchCarAudioPos.x = -carView.posX;
        this._scratchCarAudioPos.y = carView.posZ;
        this._scratchCarAudioPos.z = carView.posY;
        carPos = this._scratchCarAudioPos;
      }

      const forwardSpeed = carView ? carView.forwardSpeed : 0;
      const alive = isCarValid && !carView.isDemoed;
      const audible = isAudibleActive;

      if (entry.spatialBus && carPos) {
        entry.spatialBus.setPosition(carPos);
        entry.spatialBus.setEnabled(alive && audible);
      }

      if (entry.synth) {
        entry.synth.setVolume(engineVol);
        if (!this._scratchSynthParams) {
          this._scratchSynthParams = { forwardSpeed: 0, alive: true, audible: true };
        }
        this._scratchSynthParams.forwardSpeed = forwardSpeed;
        this._scratchSynthParams.alive = alive;
        this._scratchSynthParams.audible = audible;
        entry.synth.update(this._scratchSynthParams);
      }
    }

    // 4. Supersonic & Boost loops
    if (subsystemState?.lastTelemetry) {
      let activeSynths = 0;
      for (let i = 0; i < this.engineSynths.length; i++) {
        if (this.engineSynths[i]?.synth?.active) activeSynths++;
      }
      const t = subsystemState.lastTelemetry;
      t.updatedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      t.contextCurrentTime = audioCtx ? audioCtx.currentTime : 0;
      t.isMatchActive = Boolean(isMatchActive);
      t.hasBlockingOverlay = Boolean(hasBlockingOverlay);
      if (!Array.isArray(t.blockingOverlays)) {
        t.blockingOverlays = [];
      } else {
        t.blockingOverlays.length = 0;
      }
      if (r.openOverlays && r.openOverlays.size > 0) {
        for (const overlayName of r.openOverlays) {
          t.blockingOverlays.push(overlayName);
        }
      }
      t.continueOnBlur = Boolean(continueOnBlur);
      t.isHidden = Boolean(isHidden);
      t.isAudibleActive = Boolean(isAudibleActive);
      t.activeCar = activeCar;
      t.effectiveNumCars = effectiveNumCars;
      t.engineSynthsCount = this.engineSynths.length;
      t.activeEngineSynths = activeSynths;
    }

    if (gameAudioEngine) {
      gameAudioEngine.updateSupersonic(isSupersonic, isAudibleActive);
      gameAudioEngine.updateBoost(playerCarView?.isBoosting && !playerCarView?.isDemoed, isAudibleActive);

      // 5. Multi-car Dynamic Spatial Audio Tracking (positions, loops, emitters)
      if (typeof gameAudioEngine.updateVehicles === 'function') {
        if (!this._scratchVehiclePos) {
          this._scratchVehiclePos = { posX: 0, posY: 0, posZ: 0 };
        }
        if (!this._scratchVehicleUpdateOpts) {
          this._scratchVehicleUpdateOpts = {
            activeCarIndex: 0,
            numCars: 0,
            getCarPos: (i) => {
              const cView = resolveCarView(i);
              if (cView && Number.isFinite(cView.posX) && Number.isFinite(cView.posY) && Number.isFinite(cView.posZ)) {
                this._scratchVehiclePos.posX = cView.posX;
                this._scratchVehiclePos.posY = cView.posY;
                this._scratchVehiclePos.posZ = cView.posZ;
                return this._scratchVehiclePos;
              }
              return (i === this._scratchVehicleUpdateOpts.activeCarIndex && this.runtime.arena?.car)
                ? this.runtime.arena.car.position
                : this.runtime.arena?.cars?.[i]?.position;
            },
            getCarState: (i) => resolveCarView(i),
            isMatchActive: true,
            hasBlockingOverlay: false,
            continueOnBlur: false,
            isHidden: false
          };
        }
        const vOpts = this._scratchVehicleUpdateOpts;
        vOpts.activeCarIndex = activeCar;
        vOpts.numCars = effectiveNumCars;
        vOpts.isMatchActive = isMatchActive;
        vOpts.hasBlockingOverlay = hasBlockingOverlay;
        vOpts.continueOnBlur = continueOnBlur;
        vOpts.isHidden = isHidden;
        gameAudioEngine.updateVehicles(vOpts);
      }
    }

    // 6. Game lifecycle audio triggers (countdown, goals, overtimes)
    if (isMatchActive) {
      this.triggerGameAudioEvents(goalScored, curBoost, isSupersonic, r.interpolator?.currState);
    }
  }

  dispose() {
    for (const eng of this.engineSynths) {
      eng.synth?.dispose?.();
      eng.spatialBus?.dispose?.();
    }
    this.engineSynths.length = 0;
  }
}
