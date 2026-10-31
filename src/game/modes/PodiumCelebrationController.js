/**
 * PodiumCelebrationController.js
 * Post-Match Podium Showcase & Celebration Controller.
 *
 * Orchestrates Rocket League-style post-match podium celebrations:
 * - Arranges active cars on symmetrical V-formation pedestals facing the showcase camera.
 * - Locks horizontal X/Y translation via `engine.setCarLinearFactorAndGravity(carIndex, 0, 0, 1, 1)`
 *   so vehicles cannot drive off the podium while retaining Z-axis jumping, double-jumping,
 *   dodging, air-roll spins, and boost plume effects.
 * - Drives celebratory AI bot stunts and smooth Podium Showcase camera framing.
 */

import * as THREE from 'three';
import { FIXED_TIMESTEP, MAX_PHYSICS_SUBSTEPS } from '../../physics/RocketSimConstants.js';
import {
  PODIUM_FORMATION_SPOTS,
  PODIUM_CAMERA_POSE,
  applyPodiumFormationToEngine,
  releasePodiumLocksOnEngine
} from '../../replay/PodiumPhysicsHelper.js';

export {
  PODIUM_FORMATION_SPOTS,
  PODIUM_CAMERA_POSE,
  applyPodiumFormationToEngine,
  releasePodiumLocksOnEngine
};

export class PodiumCelebrationController {
  /**
   * @param {object} runtime
   */
  constructor(runtime) {
    this.runtime = runtime;
    this.isActive = false;
    this.winningTeam = 0;
    this.winReason = 'SCORE';
    this.elapsedSeconds = 0;
    this.accumulator = 0;
    this.podiumTick = 0;

    this._cameraPos = new THREE.Vector3();
    this._cameraLookAt = new THREE.Vector3();
  }

  _resolveCarTeam(carIndex) {
    const r = this.runtime;
    const activeMode = r?.modeManager?.getActiveMode?.();
    if (activeMode && Array.isArray(activeMode.spawnedCars)) {
      const entry = activeMode.spawnedCars.find((c) => c.carIndex === carIndex);
      if (entry && (entry.team === 0 || entry.team === 1)) {
        return entry.team;
      }
    }
    return carIndex % 2;
  }

  /**
   * Activates Post-Match Podium mode, places cars onto podium pedestals,
   * and locks horizontal X/Y translation (`setCarLinearFactorAndGravity(c, 0, 0, 1, 1)`).
   *
   * @param {number|string} [winningTeam=0] - 0 / 'BLUE', 1 / 'ORANGE', or 2 / 'DRAW'
   * @param {string} [winReason='SCORE']
   */
  enterPodium(winningTeam = 0, winReason = 'SCORE') {
    const r = this.runtime;
    const resolvedTeam = winningTeam === 'ORANGE' || winningTeam === 1
      ? 1
      : (winningTeam === 'DRAW' || winningTeam === 2 ? 2 : 0);

    this.isActive = true;
    this.winningTeam = resolvedTeam;
    this.winReason = winReason || 'SCORE';
    this.elapsedSeconds = 0;
    this.accumulator = 0;
    this.podiumTick = 0;

    if (r?.physics) {
      applyPodiumFormationToEngine(r.physics, resolvedTeam, (c) => this._resolveCarTeam(c));
      r.interpolator?.sync?.();
      const numCars = Math.min(r.physics.numCars || 0, 6);
      for (let c = 0; c < numCars; c++) {
        if (r.arena?.cars?.[c]) {
          r.arena.cars[c].visible = true;
        }
      }
    }
    r?.arena?.resetBallTrail?.();
  }

  /**
   * Exits Podium mode, restores full 3D movement (`setCarLinearFactorAndGravity(c, 1, 1, 1, 1)`),
   * zeroes out celebratory car controls, and silences all residual boost/supersonic/engine audio loops.
   */
  exitPodium() {
    if (!this.isActive) return;
    this.isActive = false;
    this.elapsedSeconds = 0;
    this.accumulator = 0;
    this.podiumTick = 0;

    const r = this.runtime;
    if (r?.physics) {
      releasePodiumLocksOnEngine(r.physics);
      const neutral = r.neutralControls || {
        throttle: 0,
        steer: 0,
        pitch: 0,
        yaw: 0,
        roll: 0,
        jump: false,
        boost: false,
        handbrake: false
      };
      const numCars = Math.min(r.physics.numCars || 0, 8);
      for (let c = 0; c < numCars; c++) {
        r.physics.setControls?.(c, neutral);
        r.authoritativeServer?.setCarControls?.(c, neutral);
      }
      if (r.physics.controlsView) {
        r.physics.controlsView.fill(0);
      }
      r.playerControls = { ...neutral };
      r.botControls = { ...neutral };
      r.playerThrottle = 0;
    }

    const activeMode = r?.modeManager?.getActiveMode?.();
    if (activeMode?.carControlsMap) {
      activeMode.carControlsMap.clear();
    }

    r?.simulationStage?.resetActionStates?.();
    r?.audioSubsystem?.resetAudio?.();
    r?.interpolator?.sync?.();
  }

  /**
   * Generates rhythmic celebratory jump, spin, and boost controls for AI bots on the podium.
   * @param {number} tick
   * @param {number} carIndex
   */
  _computeBotCelebrationControls(tick, carIndex = 1) {
    const phase = (tick + carIndex * 45) % 240;
    const isJumpPulse = phase === 10 || phase === 11 || phase === 32 || phase === 33;
    const isAirborneSpin = phase > 12 && phase < 150;
    const isBoosting = isAirborneSpin && (phase % 18 < 9);

    return {
      throttle: 1.0,
      steer: Math.sin(tick * 0.05 + carIndex),
      pitch: isAirborneSpin ? 0.55 : 0.0,
      yaw: isAirborneSpin ? 0.85 : 0.0,
      roll: isAirborneSpin ? (carIndex % 2 === 0 ? 1.0 : -1.0) : 0.0,
      jump: isJumpPulse,
      boost: isBoosting,
      handbrake: false
    };
  }

  _clampPodiumCarsToPedestals() {
    const engine = this.runtime?.physics;
    const spots = engine?._podiumCarSpots;
    if (!engine || !spots) return;

    const numCars = Math.min(engine.numCars || 0, 6);
    for (let c = 0; c < numCars; c++) {
      const spot = spots.get(c);
      if (!spot) continue;
      const carSlice = engine.getCarState(c);
      if (!carSlice) continue;

      const dx = Math.abs(carSlice[0] - spot.x);
      const dy = Math.abs(carSlice[1] - spot.y);
      const z = carSlice[2];
      const vz = carSlice[14];

      if (dx > 2.0 || dy > 2.0 || z > 165.0) {
        carSlice[0] = spot.x;
        carSlice[1] = spot.y;
        carSlice[12] = 0.0;
        carSlice[13] = 0.0;
        if (z > 165.0) {
          carSlice[2] = 165.0;
          if (vz > 0) carSlice[14] = 0.0;
        }
        engine.setCarState(c, carSlice);
      }
    }
  }

  /**
   * Steps podium celebration physics and input polling during `matchPhase === 'podium'`.
   * @param {object} context
   */
  update(context) {
    const r = this.runtime;
    if (!r || !r.physics) return;

    if (!this.isActive) {
      const w = r.match?.state?.winner ?? 0;
      this.enterPodium(w, r.match?.state?.winReason || 'SCORE');
    }

    const dt = Math.min(Math.max(context?.dt ?? FIXED_TIMESTEP, 0), 0.1);
    this.elapsedSeconds += dt;
    this.accumulator += dt;

    // Read live player celebration controls (jump, boost, pitch, yaw, roll)
    const kbReading = r.keyboard?.read?.() || r.neutralControls;
    const padReading = r.gamepad?.read?.() || r.neutralControls;
    const activeDevice = r.gamepad?.active?.() ? 'gamepad' : 'keyboard';
    const playerControls = activeDevice === 'gamepad' ? padReading : kbReading;

    r.playerControls = playerControls;
    r.playerThrottle = playerControls.throttle || 0;

    let substeps = Math.floor(this.accumulator / FIXED_TIMESTEP);
    this.accumulator = Math.max(0, this.accumulator - substeps * FIXED_TIMESTEP);
    if (substeps > MAX_PHYSICS_SUBSTEPS) {
      substeps = MAX_PHYSICS_SUBSTEPS;
    }

    const numCars = Math.min(r.physics.numCars || 1, 6);
    const localCarTeam = this._resolveCarTeam(r.playerCarIndex);
    const isLocalWinner = this.winningTeam === 2 || localCarTeam === this.winningTeam;
    const effectivePlayerControls = isLocalWinner
      ? playerControls
      : { ...playerControls, throttle: 0, steer: 0 };

    const activeMode = r.modeManager?.getActiveMode?.();
    const isExpMultiBots = r.match?.state?.mode === 'exp-multi-bots';
    if (isExpMultiBots && activeMode?.carControlsMap) {
      activeMode.carControlsMap.set(r.playerCarIndex, effectivePlayerControls);
    }

    for (let i = 0; i < substeps; i++) {
      this.podiumTick++;

      for (let c = 0; c < numCars; c++) {
        if (c === r.playerCarIndex) continue;
        if ((r.isBotMatch && c === 1) || isExpMultiBots) {
          const botTeam = this._resolveCarTeam(c);
          const isBotWinner = this.winningTeam === 2 || botTeam === this.winningTeam;
          const rawBotCtrl = this._computeBotCelebrationControls(this.podiumTick, c);
          const botCtrl = isBotWinner ? rawBotCtrl : { ...rawBotCtrl, throttle: 0, steer: 0 };
          if (c === 1) r.botControls = botCtrl;
          if (isExpMultiBots && activeMode?.carControlsMap) {
            activeMode.carControlsMap.set(c, botCtrl);
          }
          r.physics.setControls(c, botCtrl);
          r.authoritativeServer?.setCarControls?.(c, botCtrl);
        } else if (r.networkReconciler?.lastRemoteControls) {
          const remote = r.networkReconciler.lastRemoteControls.get(c);
          const remoteCtrl = remote?.controls ? remote.controls : (remote || r.neutralControls);
          r.physics.setControls(c, remoteCtrl);
        }
      }

      if (r.interpolator) {
        r.interpolator.prevState.set(r.interpolator.currState);
      }

      if (r.networkReconciler) {
        const predicted =
          r.networkReconciler.sampleAndPredictInput(r.playerCarIndex, effectivePlayerControls) ||
          effectivePlayerControls;
        r.physics.setControls(r.playerCarIndex, predicted);
        r.physics.step(1);
      } else {
        r.physics.setControls(r.playerCarIndex, effectivePlayerControls);
        r.physics.step(1);
      }

      this._clampPodiumCarsToPedestals();

      if (r.interpolator) {
        r.interpolator.currState.set(r.physics.state);
      }
    }

    if (r.interpolator) {
      r.interpolator.alpha = Math.min(1.0, this.accumulator / FIXED_TIMESTEP);
    }
  }

  /**
   * Positions the Three.js camera in front of the Podium Showcase pedestals.
   * Note: Three.js coordinate mapping from Unreal is (X -> X, Z -> Y [up], Y -> Z [forward]).
   *
   * @param {import('../../camera/CameraManager.js').CameraManager} cameraManager
   * @param {number} [dt=0.016]
   */
  updateCamera(cameraManager, dt = 0.016) {
    const cam = cameraManager?.camera;
    if (!cam) return;

    const sway = Math.sin(this.elapsedSeconds * 0.45) * 55.0;
    const desiredX = PODIUM_CAMERA_POSE.eyeX + sway;
    const desiredY = PODIUM_CAMERA_POSE.eyeZ; // Unreal Z -> Three.js Y (up)
    const desiredZ = PODIUM_CAMERA_POSE.eyeY; // Unreal Y -> Three.js Z

    const targetX = PODIUM_CAMERA_POSE.targetX;
    const targetY = PODIUM_CAMERA_POSE.targetZ; // Unreal Z -> Three.js Y (up)
    const targetZ = PODIUM_CAMERA_POSE.targetY; // Unreal Y -> Three.js Z

    const blend = Math.min(1.0, Math.max(0.08, dt * 6.0));
    if (this.elapsedSeconds <= dt * 1.5) {
      this._cameraPos.set(desiredX, desiredY, desiredZ);
      this._cameraLookAt.set(targetX, targetY, targetZ);
    } else {
      this._cameraPos.x += (desiredX - this._cameraPos.x) * blend;
      this._cameraPos.y += (desiredY - this._cameraPos.y) * blend;
      this._cameraPos.z += (desiredZ - this._cameraPos.z) * blend;
      this._cameraLookAt.set(targetX, targetY, targetZ);
    }

    cam.position.copy(this._cameraPos);
    cam.lookAt(this._cameraLookAt);
  }
}

export default PodiumCelebrationController;
