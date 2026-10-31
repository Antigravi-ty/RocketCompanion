/**
 * ReachabilityVisualizer.js
 * High-performance, decoupled Three.js 3D orchestrator for:
 * 1. Ground/Surface Reachability Isochrones (GroundReachabilityRenderer)
 * 2. Aerial 3D Spacetime Funnel / Horn & Discrete Isochrone Bubbles (AerialReachabilityRenderer)
 * 3. Real-time Optimal Intercept Point 3D Orthogonal Cross (InterceptCrossRenderer)
 */

import * as THREE from 'three';
import { preloadGroundReachabilityLut } from './reachability/groundReachabilityLut.js';
import { GroundReachabilityRenderer } from './reachability/GroundReachabilityRenderer.js';
import { AerialReachabilityRenderer } from './reachability/AerialReachabilityRenderer.js';
import { InterceptCrossRenderer } from './reachability/InterceptCrossRenderer.js';

export class ReachabilityVisualizer {
  /**
   * @param {THREE.Scene} scene
   * @param {Object} physics - RocketSimPhysicsEngine
   * @param {Object} ballTrajectoryPredictor - BallTrajectoryPredictor instance
   * @param {Object} [options] - Optional getConfig and onTelemetry callbacks
   */
  constructor(scene, physics = null, ballTrajectoryPredictor = null, options = {}) {
    this.scene = scene;
    this.physics = physics;
    this.ballTrajectoryPredictor = ballTrajectoryPredictor;
    this.getConfig = options.getConfig || null;
    this.onTelemetry = options.onTelemetry || null;

    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'reachability-visualizer-root';
    this.rootGroup.visible = false;

    if (this.scene) {
      this.scene.add(this.rootGroup);
    }

    this.groundRenderer = new GroundReachabilityRenderer(this.rootGroup);
    this.aerialRenderer = new AerialReachabilityRenderer(this.rootGroup);
    this.interceptRenderer = new InterceptCrossRenderer(this.rootGroup, this.ballTrajectoryPredictor);

    this.groundGroup = this.groundRenderer.group;
    this.aerialGroup = this.aerialRenderer.group;
    this.interceptGroup = this.interceptRenderer.group;

    this._lastTelemetryPublishMs = 0;

    preloadGroundReachabilityLut();
  }

  /**
   * Per-frame update called from GameRenderSubsystem.
   */
  update(runtime, currentTick, renderWidth, renderHeight) {
    const config = this.getConfig?.();
    if (!config || !config.enabled) {
      if (this.rootGroup.visible) {
        this.rootGroup.visible = false;
      }
      return;
    }

    const phys = runtime?.physics || this.physics;
    if (!phys) return;

    const targetIdx = config.targetCarIndex >= 0
      ? config.targetCarIndex
      : (runtime?.playerCarIndex ?? 0);

    const carView = runtime?.interpolator?.getCurrCarStateView?.(targetIdx) || phys.getCarStateView?.(targetIdx);
    if (!carView || carView.isDemoed) {
      this.rootGroup.visible = false;
      return;
    }

    this.rootGroup.visible = true;

    // Extract current vehicle state in RocketSim coordinates (using interpolated visual position if available)
    const carGroup = runtime?.arena?.cars?.[targetIdx];
    const posX = carGroup ? carGroup.position.x : carView.posX;
    const posY = carGroup ? carGroup.position.z : carView.posY; // Three.js Z -> RocketSim Y
    const posZ = carGroup ? carGroup.position.y : carView.posZ; // Three.js Y -> RocketSim Z

    const carState = {
      posX,
      posY,
      posZ,
      velX: carView.velX,
      velY: carView.velY,
      velZ: carView.velZ,
      fwdX: carView.fwdX,
      fwdY: carView.fwdY,
      fwdZ: carView.fwdZ,
      rightX: carView.rightX,
      rightY: carView.rightY,
      rightZ: carView.rightZ,
      upX: carView.upX,
      upY: carView.upY,
      upZ: carView.upZ,
      angVelX: carView.angVelX,
      angVelY: carView.angVelY,
      angVelZ: carView.angVelZ,
      boost: carView.boost,
      isOnGround: Boolean(carView.isOnGround),
    };

    const t0 = performance.now();
    this.groundRenderer.update(carState, config);
    const t1 = performance.now();
    this.aerialRenderer.update(carState, config);
    const t2 = performance.now();
    const interceptRes = this.interceptRenderer.update(
      carState,
      config,
      currentTick,
      renderWidth,
      renderHeight,
      phys
    );
    const t3 = performance.now();

    // Throttle UI store telemetry updates to ~15Hz so React UI never lags the 120Hz render loop
    if (t3 - this._lastTelemetryPublishMs > 65.0) {
      this._lastTelemetryPublishMs = t3;
      const groundUs = (t1 - t0) * 1000.0;
      const aerialUs = (t2 - t1) * 1000.0;
      const interceptUs = (t3 - t2) * 1000.0;
      this.onTelemetry?.({
        computeTimeUs: groundUs + aerialUs + interceptUs,
        groundComputeUs: groundUs,
        aerialComputeUs: aerialUs,
        interceptComputeUs: interceptUs,
        isOnGround: carState.isOnGround,
        boostAmount: carState.boost,
        forwardSpeed: carView.forwardSpeed ?? 0,
        interceptStatus: interceptRes.status,
        interceptTimeSec: interceptRes.timeSec,
        interceptDistance: interceptRes.distance,
        interceptMargin: interceptRes.margin,
        interceptCentrality: interceptRes.centrality ?? 0,
        interceptPaceStatus: interceptRes.paceStatus ?? 'none',
        interceptMinBoost: interceptRes.minBoost,
        interceptPos: [
          Math.round(interceptRes.rx),
          Math.round(interceptRes.ry),
          Math.round(interceptRes.rz),
        ],
      });
    }
  }

  dispose() {
    if (this.rootGroup) {
      if (this.scene) {
        this.scene.remove(this.rootGroup);
      }
      this.rootGroup.traverse((node) => {
        node.geometry?.dispose?.();
        if (node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          mats.forEach((m) => m?.dispose?.());
        }
      });
    }
  }
}

export default ReachabilityVisualizer;
