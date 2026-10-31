/**
 * BallTrajectoryPredictor.js
 * High-performance 3D visual subsystem for Ball Trajectory Prediction.
 *
 * Powered by RocketSim WASM BallPredTracker (up to 5.0 seconds = 600 ticks @ 120Hz).
 * Features:
 * - Purely client-side local prediction driven directly by native physics state
 * - World-space line thickness relative to ball size (1% - 75% of ball diameter, step 1%)
 * - Mandatory Native Physics Triggers (Zero-Overhead Raw Coordinate Comparison):
 *     1. Linear Velocity Threshold: Predicts only when at least one velocity component >= 250 UU/s.
 *     2. Trajectory Deviation Check: Recomputes when live ball position deviates > 5 UU from predicted point.
 * - Dual trajectory modes:
 *     * Static Mode: Dashed pattern fixed in world space; ball follows path; passed frames disappear
 *     * Dynamic Mode (Default): Dashed pattern flows forward relative to live ball position (ball pushes line)
 * - Hardware-accelerated 3D world-space wide lines using Three.js LineSegments2 & LineMaterial (worldUnits: true).
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import {
  loadSavedTrajectorySettings,
  saveTrajectorySettings,
} from '../ui-core/config/trainingDefaults.js';

export const DEFAULT_TRAJECTORY_SETTINGS = Object.freeze({
  enabled: true,
  predictionTicks: 600,        // 60 - 600 ticks (default: 600 ticks = 5.0s @ 120Hz)
  solidTicks: 50,              // 5 - 240 ticks (default: 50 ticks)
  transparentTicks: 20,        // 5 - 240 ticks (default: 20 ticks)
  thickness: 10,               // 1% - 75% of ball diameter (default: 10%)
  opacity: 0.5,                // 0.05 - 1.0 (default: 0.5)
  color: '#B2B2B2',            // Default: #B2B2B2
  dynamicMode: true            // true: Ball pushes line (default: true)
});


export class BallTrajectoryPredictor {
  /**
   * @param {THREE.Scene} scene - Target 3D scene where the trajectory line will be rendered
   * @param {Object} [initialSettings={}] - Initial configuration overrides
   * @param {number} [ballRadius=91.25] - Ball collision radius in world units (Unreal Units)
   * @param {Object} [physics=null] - RocketSimPhysicsEngine reference
   */
  constructor(scene, initialSettings = {}, ballRadius = 91.25, physics = null) {
    this.scene = scene;
    this.ballRadius = Number(ballRadius) || 91.25;
    this.physics = physics;
    this.settings = {
      ...loadSavedTrajectorySettings(),
      ...initialSettings
    };

    // Preallocated typed buffers for points and vertices
    // 600 ticks max, each tick has 3 coordinates (x, y, z)
    this.maxTicks = 600;
    this.predictedPoints = new Float32Array(this.maxTicks * 3); // Three.js render coordinates (x, z, y)
    this.rawPredictedPoints = new Float32Array(this.maxTicks * 3); // Raw RocketSim native coordinates (x, y, z)
    this.predictionCount = 0;
    this.impactTick = -1;
    this.isActive = false;
    this.staticPreviewActive = false;
    this.forcePredictAnyMovement = false;

    // Movement state tracking for trigger management
    this.wasMovingFast = false;
    this.lastVelX = 0;
    this.lastVelY = 0;
    this.lastVelZ = 0;

    // Segment positions buffer (each segment is 2 points = 6 floats)
    // At most 600 segments = 3600 floats
    this.segmentPositionsBuffer = new Float32Array(this.maxTicks * 6);

    // Setup Three.js LineSegments2 rendering pipeline with worldUnits
    const ballDiameter = (this.ballRadius || 91.25) * 2;
    const clampedPct = Math.min(75, Math.max(1, Number(this.settings.thickness) || 10));
    const worldLinewidth = (clampedPct / 100) * ballDiameter;

    this.geometry = new LineSegmentsGeometry();
    this.geometry.setPositions(this.segmentPositionsBuffer);
    this.geometry.instanceCount = 0;

    const initialResX = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const initialResY = typeof window !== 'undefined' ? window.innerHeight : 1080;

    // Pass A (renderOrder 0.05): renders after all opaque geometry (including solid Pass 1 goalposts
    // at renderOrder 0) and before semi-transparent goalpost/recess overlays (renderOrder 0.1..0.6).
    // Trajectory segments behind semi-transparent goalposts/recesses pass the depth test against the
    // arena floor and are drawn into the color buffer first so the semi-transparent goalpost overlay
    // blends on top of them, visually layering the trajectory behind the semi-transparent goalpost.
    this.preOcclusionMaterial = new LineMaterial({
      color: new THREE.Color(this.settings.color),
      linewidth: worldLinewidth,
      transparent: true,
      opacity: this.settings.opacity,
      depthTest: true,
      depthWrite: false,
      dashed: false,
      worldUnits: true
    });
    this.preOcclusionMaterial.resolution.set(initialResX, initialResY);

    this.preOcclusionLineMesh = new LineSegments2(this.geometry, this.preOcclusionMaterial);
    this.preOcclusionLineMesh.name = 'ball-trajectory-predictor-line-pre-occlusion';
    this.preOcclusionLineMesh.renderOrder = 0.05;
    this.preOcclusionLineMesh.frustumCulled = false;
    this.preOcclusionLineMesh.visible = false;
    this.preOcclusionLineMesh.userData = { bloomOccluder: false };

    // Pass B (renderOrder 14): stencil-gated foreground pass that only draws where a semi-transparent
    // goalpost/wall overlay wrote stencil bit 0x02 AND the trajectory is closer to the camera than the
    // semi-transparent goalpost (z_traj <= z_goal), keeping foreground trajectories on top of goalposts
    // without double-blending in the open arena or drawing over goalposts that are in front of the line.
    this.material = new LineMaterial({
      color: new THREE.Color(this.settings.color),
      linewidth: worldLinewidth,
      transparent: true,
      opacity: this.settings.opacity,
      depthTest: true,
      depthWrite: false,
      dashed: false,
      worldUnits: true
    });
    this.material.stencilWrite = true;
    this.material.stencilFunc = THREE.EqualStencilFunc;
    this.material.stencilRef = 2;
    this.material.stencilFuncMask = 0x02;
    this.material.stencilWriteMask = 0x00;
    this.material.stencilZPass = THREE.KeepStencilOp;
    this.material.stencilFail = THREE.KeepStencilOp;
    this.material.stencilZFail = THREE.KeepStencilOp;
    this.material.resolution.set(initialResX, initialResY);

    this.lineMesh = new LineSegments2(this.geometry, this.material);
    this.lineMesh.name = 'ball-trajectory-predictor-line';
    this.lineMesh.renderOrder = 14;
    this.lineMesh.frustumCulled = false;
    this.lineMesh.visible = false;
    this.lineMesh.userData = { bloomOccluder: false };

    if (this.scene) {
      this.scene.add(this.preOcclusionLineMesh);
      this.scene.add(this.lineMesh);
    }
  }

  /**
   * Updates ball radius in world units and adjusts 3D line width accordingly.
   * @param {number} radius
   */
  setBallRadius(radius) {
    if (typeof radius === 'number' && radius > 0) {
      this.ballRadius = radius;
      this.syncMaterialProperties();
    }
  }

  /**
   * Sets the physics engine reference.
   * @param {Object} physics
   */
  setPhysicsEngine(physics) {
    this.physics = physics;
    if (physics?.ballRadius) {
      this.setBallRadius(physics.ballRadius);
    }
  }

  /**
   * Synchronizes Three.js LineMaterial uniforms from current settings & ball dimensions.
   */
  syncMaterialProperties() {
    if (!this.material) return;
    const ballDiameter = (this.ballRadius || 91.25) * 2;
    const clampedPct = Math.min(75, Math.max(1, Number(this.settings.thickness) || 10));
    const worldLinewidth = (clampedPct / 100) * ballDiameter;

    for (const mat of [this.material, this.preOcclusionMaterial]) {
      if (!mat) continue;
      mat.color.set(this.settings.color);
      mat.linewidth = worldLinewidth;
      mat.opacity = this.settings.opacity;
    }
  }

  /**
   * Updates configuration settings and syncs visual material properties.
   * @param {Partial<typeof DEFAULT_TRAJECTORY_SETTINGS>} newSettings
   */
  updateSettings(newSettings) {
    Object.assign(this.settings, newSettings);
    this.syncMaterialProperties();

    if (!this.settings.enabled) {
      this.clear();
    }

    saveTrajectorySettings(this.settings);
  }

  /**
   * Computes a static preview trajectory for a stationary/staged ball (used in Static Training Pack
   * Edit Mode & Pre-Launch Play Mode) and enables continuous dashed scrolling along the predicted path.
   */
  setStaticPreviewTrajectory(physics = null, ballLaunchState = null) {
    const phys = physics || this.physics;
    if (!phys || typeof phys.getBallState !== 'function' || typeof phys.setBallState !== 'function') {
      this.clearStaticPreview();
      return 0;
    }

    if (ballLaunchState?.kickoffState) {
      this.clearStaticPreview();
      return 0;
    }

    const savedBall = new Float32Array(phys.getBallState());
    try {
      if (ballLaunchState) {
        phys.setBallState({
          pos: ballLaunchState.pos,
          vel: ballLaunchState.vel,
          angVel: ballLaunchState.angVel || [0, 0, 0]
        });
      }

      const bState = phys.getBallState();
      const vx = bState[12] || 0;
      const vy = bState[13] || 0;
      const vz = bState[14] || 0;
      const pz = bState[2] || 93.15;
      const speedMag = Math.hypot(vx, vy, vz);

      // If ball has zero speed and is resting on the ground, no trajectory to show
      if (speedMag < 1.0 && pz <= 95.0) {
        this.clearStaticPreview();
        return 0;
      }

      const distanceTicks = Math.min(600, Math.max(60, this.settings.predictionTicks || 600));
      const seconds = Math.min(5.0, Math.max(0.5, (distanceTicks + 0.05) / 120.0));
      const count = phys.updateBallPrediction(seconds);
      const rawData = phys.getBallPrediction();

      if (!rawData || count <= 1) {
        this.clearStaticPreview();
        return 0;
      }

      const actualCount = Math.min(count, distanceTicks, this.maxTicks);
      this.predictionCount = actualCount;
      this.impactTick = Math.floor(phys.getHeaderView?.()?.tickCount ?? 0);

      for (let i = 0; i < actualCount; i++) {
        const srcOffset = i * 6;
        const dstOffset = i * 3;
        const x = rawData[srcOffset + 0];
        const y = rawData[srcOffset + 1];
        const z = rawData[srcOffset + 2];

        this.predictedPoints[dstOffset + 0] = x;
        this.predictedPoints[dstOffset + 1] = z;
        this.predictedPoints[dstOffset + 2] = y;

        this.rawPredictedPoints[dstOffset + 0] = x;
        this.rawPredictedPoints[dstOffset + 1] = y;
        this.rawPredictedPoints[dstOffset + 2] = z;
      }

      this.isActive = true;
      this.staticPreviewActive = true;
      return actualCount;
    } finally {
      phys.setBallState(savedBall);
    }
  }

  clearStaticPreview() {
    this.staticPreviewActive = false;
    this.clear();
  }

  /**
   * Trigger prediction from current ball physics state.
   * @param {Object} [physics] - RocketSimPhysicsEngine instance
   * @param {number} [targetTick] - Current tick
   * @returns {number} Count of predicted ticks
   */
  predictFromCurrentState(physics = null, targetTick = null) {
    const phys = physics || this.physics;
    if ((!this.settings.enabled && !this.forcePredictAnyMovement) || !phys) {
      return 0;
    }

    const distanceTicks = Math.min(600, Math.max(60, this.settings.predictionTicks));
    const seconds = Math.min(5.0, Math.max(0.5, (distanceTicks + 0.05) / 120.0));

    const count = phys.updateBallPrediction(seconds);
    const rawData = phys.getBallPrediction();

    if (!rawData || count <= 0) {
      this.clear();
      return 0;
    }

    const actualCount = Math.min(count, distanceTicks, this.maxTicks);
    const resolvedTick = targetTick !== null && targetTick !== undefined
      ? targetTick
      : (phys.getHeaderView()?.tickCount ?? 0);

    this.impactTick = resolvedTick;
    this.predictionCount = actualCount;

    // Convert coordinates from RocketSim (X=fwd, Y=right, Z=up) to Three.js (X=x, Y=z, Z=y)
    // Also retain raw RocketSim coordinates for zero-overhead deviation testing
    for (let i = 0; i < actualCount; i++) {
      const srcOffset = i * 6; // posX, posY, posZ, velX, velY, velZ
      const dstOffset = i * 3;
      const x = rawData[srcOffset + 0];
      const y = rawData[srcOffset + 1];
      const z = rawData[srcOffset + 2];

      // Three.js coordinates for rendering
      this.predictedPoints[dstOffset + 0] = x;
      this.predictedPoints[dstOffset + 1] = z; // Three.js height
      this.predictedPoints[dstOffset + 2] = y;

      // Raw RocketSim native coordinates (UU)
      this.rawPredictedPoints[dstOffset + 0] = x;
      this.rawPredictedPoints[dstOffset + 1] = y;
      this.rawPredictedPoints[dstOffset + 2] = z;
    }

    this.isActive = true;
    return actualCount;
  }

  /**
   * Main per-frame update loop.
   * Directly evaluates raw native velocity and position offsets with minimal overhead.
   *
   * @param {number} currentTick - Current physics simulation tick count
   * @param {THREE.Vector3} [liveBallPosition] - Optional live ball position for smooth anchor
   * @param {number} [renderWidth] - Viewport width
   * @param {number} [renderHeight] - Viewport height
   * @param {Object} [physics] - Optional physics engine reference
   */
  update(currentTick, liveBallPosition = null, renderWidth = null, renderHeight = null, physics = null) {
    if (!this.settings.enabled && !this.staticPreviewActive && !this.forcePredictAnyMovement) {
      if (this.lineMesh && this.lineMesh.visible) {
        this.lineMesh.visible = false;
      }
      if (this.preOcclusionLineMesh && this.preOcclusionLineMesh.visible) {
        this.preOcclusionLineMesh.visible = false;
      }
      return;
    }

    const phys = physics || this.physics;

    // Sync viewport resolution for LineMaterial aspect ratio calculation
    if (renderWidth && renderHeight) {
      if (this.material) {
        this.material.resolution.set(renderWidth, renderHeight);
      }
      if (this.preOcclusionMaterial) {
        this.preOcclusionMaterial.resolution.set(renderWidth, renderHeight);
      }
    }

    // Static Training Pack Preview Mode: ball is stationary, dashes scroll forward automatically
    if (this.staticPreviewActive && this.isActive && this.predictionCount > 1) {
      const solidTicks = Math.max(5, Math.min(240, this.settings.solidTicks || 50));
      const transparentTicks = Math.max(5, Math.min(240, this.settings.transparentTicks || 20));
      const cycleLength = solidTicks + transparentTicks;
      // Advance dash scroll at ~90 ticks per second so dashes flow forward along the trajectory direction
      const nowSec = typeof performance !== 'undefined' ? performance.now() * 0.001 : 0;
      const scrollOffset = Math.floor(nowSec * 90);

      let floatCount = 0;
      const endIndex = this.predictionCount - 1;
      for (let k = 0; k < endIndex; k++) {
        const phase = (((k - scrollOffset) % cycleLength) + cycleLength) % cycleLength;
        if (phase >= solidTicks) continue;

        const p0Offset = k * 3;
        const p1Offset = (k + 1) * 3;

        if (k === 0 && liveBallPosition) {
          this.segmentPositionsBuffer[floatCount++] = liveBallPosition.x;
          this.segmentPositionsBuffer[floatCount++] = liveBallPosition.y;
          this.segmentPositionsBuffer[floatCount++] = liveBallPosition.z;
        } else {
          this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p0Offset + 0];
          this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p0Offset + 1];
          this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p0Offset + 2];
        }

        this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p1Offset + 0];
        this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p1Offset + 1];
        this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p1Offset + 2];
      }

      if (floatCount > 0) {
        const instStart = this.geometry.attributes.instanceStart;
        if (instStart && instStart.data) {
          this.geometry.instanceCount = floatCount / 6;
          instStart.data.needsUpdate = true;
        } else {
          this.geometry.setPositions(this.segmentPositionsBuffer);
          this.geometry.instanceCount = floatCount / 6;
        }
        this.lineMesh.visible = true;
        if (this.preOcclusionLineMesh) this.preOcclusionLineMesh.visible = true;
      } else {
        this.lineMesh.visible = false;
        if (this.preOcclusionLineMesh) this.preOcclusionLineMesh.visible = false;
      }
      return;
    }

    if (!phys) {
      return;
    }

    // Direct access to native shared state buffer (Zero allocations, zero conversions)
    // SIM_OFFSETS.BALL = 4: posX[4], posY[5], posZ[6], velX[16], velY[17], velZ[18]
    const stateBuf = phys.state;
    const isSleeping = typeof phys.isBallSleeping === 'function' ? phys.isBallSleeping() : false;

    if (isSleeping || !stateBuf) {
      this.wasMovingFast = false;
      if (this.isActive) this.clear();
      return;
    }

    const rawVelX = stateBuf[16];
    const rawVelY = stateBuf[17];
    const rawVelZ = stateBuf[18];

    // Velocity impulse detection (e.g. car hit ball or sudden direction change)
    const dvX = rawVelX - this.lastVelX;
    const dvY = rawVelY - this.lastVelY;
    const dvZ = rawVelZ - this.lastVelZ;
    const hasImpulse = (dvX > 100 || dvX < -100) || (dvY > 100 || dvY < -100) || (dvZ > 100 || dvZ < -100);

    this.lastVelX = rawVelX;
    this.lastVelY = rawVelY;
    this.lastVelZ = rawVelZ;

    const velThreshold = this.forcePredictAnyMovement ? 15 : 250;
    // Check if any velocity component is >= threshold UU/s (or airborne in training pack mode)
    const isFastEnough = (
      (rawVelX >= velThreshold || rawVelX <= -velThreshold) ||
      (rawVelY >= velThreshold || rawVelY <= -velThreshold) ||
      (rawVelZ >= velThreshold || rawVelZ <= -velThreshold) ||
      (this.forcePredictAnyMovement && stateBuf[6] > 96.0)
    );

    // Initial state trigger: only activate when ball is fast enough or receives an impulse
    if (!this.isActive) {
      if (isFastEnough || hasImpulse) {
        this.predictFromCurrentState(phys, currentTick);
        this.wasMovingFast = true;
      }
    } else {
      // Once active, recompute if ball receives a new hit impulse
      if (hasImpulse) {
        this.predictFromCurrentState(phys, currentTick);
      }
    }

    if (!this.isActive || this.predictionCount <= 1) {
      if (this.lineMesh && this.lineMesh.visible) {
        this.lineMesh.visible = false;
      }
      if (this.preOcclusionLineMesh && this.preOcclusionLineMesh.visible) {
        this.preOcclusionLineMesh.visible = false;
      }
      return;
    }

    let elapsed = Math.floor(currentTick - this.impactTick);

    // If all predicted frames have elapsed, ignore and do not recompute
    if (elapsed >= this.predictionCount) {
      this.clear();
      return;
    }

    if (elapsed < 0) {
      this.lineMesh.visible = false;
      if (this.preOcclusionLineMesh) this.preOcclusionLineMesh.visible = false;
      return;
    }

    // Direct raw coordinate deviation check (recompute if any coordinate exceeds 5 UU)
    if (elapsed >= 0 && elapsed < this.predictionCount) {
      const predOffset = elapsed * 3;
      const rawPredX = this.rawPredictedPoints[predOffset + 0];
      const rawPredY = this.rawPredictedPoints[predOffset + 1];
      const rawPredZ = this.rawPredictedPoints[predOffset + 2];

      const rawLiveX = stateBuf[4];
      const rawLiveY = stateBuf[5];
      const rawLiveZ = stateBuf[6];

      const diffX = rawLiveX - rawPredX;
      const diffY = rawLiveY - rawPredY;
      const diffZ = rawLiveZ - rawPredZ;

      if ((diffX > 5 || diffX < -5) || (diffY > 5 || diffY < -5) || (diffZ > 5 || diffZ < -5)) {
        this.predictFromCurrentState(phys, currentTick);
        elapsed = 0;
      }
    }

    const solidTicks = Math.max(5, Math.min(240, this.settings.solidTicks));
    const transparentTicks = Math.max(5, Math.min(240, this.settings.transparentTicks));
    const cycleLength = solidTicks + transparentTicks;
    const isDynamic = Boolean(this.settings.dynamicMode);

    const startIndex = Math.max(0, elapsed);
    const endIndex = this.predictionCount - 1;

    let floatCount = 0;

    for (let k = startIndex; k < endIndex; k++) {
      let isSolid = false;
      if (isDynamic) {
        // Dynamic Mode ("Ball pushes line"):
        // Dash cycle phase flows forward relative to live ball position (k - elapsed).
        const deltaFromBall = k - elapsed;
        const phase = deltaFromBall % cycleLength;
        isSolid = phase < solidTicks;
      } else {
        // Static Mode ("Ball follows line"):
        // Dash cycle phase is anchored to absolute predicted tick k from impact.
        const phase = k % cycleLength;
        isSolid = phase < solidTicks;
      }

      if (!isSolid) {
        continue;
      }

      const p0Offset = k * 3;
      const p1Offset = (k + 1) * 3;

      if (k === startIndex && liveBallPosition) {
        this.segmentPositionsBuffer[floatCount++] = liveBallPosition.x;
        this.segmentPositionsBuffer[floatCount++] = liveBallPosition.y;
        this.segmentPositionsBuffer[floatCount++] = liveBallPosition.z;
      } else {
        this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p0Offset + 0];
        this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p0Offset + 1];
        this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p0Offset + 2];
      }

      this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p1Offset + 0];
      this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p1Offset + 1];
      this.segmentPositionsBuffer[floatCount++] = this.predictedPoints[p1Offset + 2];
    }

    if (floatCount > 0) {
      const instStart = this.geometry.attributes.instanceStart;
      if (instStart && instStart.data) {
        this.geometry.instanceCount = floatCount / 6;
        instStart.data.needsUpdate = true;
      } else {
        this.geometry.setPositions(this.segmentPositionsBuffer);
        this.geometry.instanceCount = floatCount / 6;
      }
      this.lineMesh.visible = true;
      if (this.preOcclusionLineMesh) this.preOcclusionLineMesh.visible = true;
    } else {
      this.lineMesh.visible = false;
      if (this.preOcclusionLineMesh) this.preOcclusionLineMesh.visible = false;
    }
  }

  /**
   * Clears the current trajectory and hides the 3D line.
   */
  clear() {
    this.isActive = false;
    this.staticPreviewActive = false;
    this.predictionCount = 0;
    this.impactTick = -1;
    if (this.lineMesh) {
      this.lineMesh.visible = false;
    }
    if (this.preOcclusionLineMesh) {
      this.preOcclusionLineMesh.visible = false;
    }
  }

  /**
   * Cleans up Three.js resources and removes mesh from scene.
   */
  dispose() {
    this.clear();
    if (this.preOcclusionLineMesh && this.scene) {
      this.scene.remove(this.preOcclusionLineMesh);
    }
    if (this.lineMesh && this.scene) {
      this.scene.remove(this.lineMesh);
    }
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    if (this.preOcclusionMaterial) {
      this.preOcclusionMaterial.dispose();
      this.preOcclusionMaterial = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    this.preOcclusionLineMesh = null;
    this.lineMesh = null;
  }
}

export default BallTrajectoryPredictor;
