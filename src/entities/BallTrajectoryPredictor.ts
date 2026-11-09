/**
 * BallTrajectoryPredictor.ts
 * High-performance 3D visual subsystem for Ball Trajectory Prediction.
 *
 * Powered by RocketSim WASM BallPredTracker (up to 5.0 seconds = 600 ticks @ 120Hz).
 * Coordinates two dedicated SubControllers:
 * 1. BallTrajectorySamplingController: WASM incremental tail extension & progressive catch-up ramp.
 * 2. BallTrajectoryTubeRenderer: 1-draw-call indexed 3D volumetric tube, bounce rings, & drop lines.
 */

import type * as THREE from 'three';

import {
  loadSavedTrajectorySettings,
  saveTrajectorySettings,
  type TrajectoryDashCapStyle,
  type TrajectoryRenderStyle,
  type TrajectoryUpdateMode,
} from '../ui-core/config/trainingDefaults.ts';
import {
  resolveBallTrajectoryActivation,
  type BallTrajectoryOverride,
  type ResolvedBallTrajectoryActivation,
  type TrajectorySceneContext,
  type TrajectorySceneFlags,
  type TrajectoryUpdateKind,
} from './trajectory/ballTrajectoryPolicy.ts';
import type { LiveBallPositionLike } from './trajectory/ballTrajectoryGeometryPipeline.ts';
import {
  DEFAULT_TRAJECTORY_SETTINGS,
  buildBallTrajectoryTelemetrySnapshot,
  buildTubeRenderParams,
  computeStaticPreviewScrollOffset,
  resolvePatternElapsedTicks,
  shouldPublishTrajectoryTelemetry,
  type BallTrajectoryTelemetrySnapshot,
  type TrajectorySettingsConfig,
} from './trajectory/ballTrajectoryTelemetryPipeline.ts';
import { BallTrajectoryTubeRenderer } from './trajectory/BallTrajectoryTubeRenderer.ts';
import {
  BallTrajectorySamplingController,
  type TrajectoryBallLaunchState,
  type TrajectoryPhysicsPort,
} from './trajectory/BallTrajectorySamplingController.ts';

export type {
  BallTrajectoryOverride,
  BallTrajectoryTelemetrySnapshot,
  ResolvedBallTrajectoryActivation,
  TrajectoryBallLaunchState,
  TrajectoryDashCapStyle,
  TrajectoryPhysicsPort,
  TrajectoryRenderStyle,
  TrajectorySceneContext,
  TrajectorySceneFlags,
  TrajectorySettingsConfig,
  TrajectoryUpdateKind,
  TrajectoryUpdateMode,
};

export class BallTrajectoryPredictor {
  public ballRadius: number;
  public forcePredictAnyMovement: boolean;
  public maxTicks: number;
  public physics: TrajectoryPhysicsPort | null;
  public scene: THREE.Scene | null | undefined;
  public readonly sampler: BallTrajectorySamplingController;
  public tubeRenderer: BallTrajectoryTubeRenderer | null;
  public settings: TrajectorySettingsConfig;
  public trajectoryOverride: BallTrajectoryOverride = null;
  public runtimeOverride: BallTrajectoryOverride = null;
  public onTelemetry: ((telemetry: BallTrajectoryTelemetrySnapshot) => void) | null;

  private readonly _suppressionSources = new Set<string>();
  private _isGoalReplayActive = false;
  private _isPodiumActive = false;
  private _lastTelemetryPublishMs = 0;

  constructor(
    scene: THREE.Scene | null | undefined,
    initialSettings: Partial<TrajectorySettingsConfig> = {},
    ballRadius = 91.25,
    physics: TrajectoryPhysicsPort | null = null,
    onTelemetry: ((telemetry: BallTrajectoryTelemetrySnapshot) => void) | null = null
  ) {
    this.scene = scene;
    this.ballRadius = Number(ballRadius) || 91.25;
    this.physics = physics;
    this.onTelemetry = onTelemetry;
    this.settings = {
      ...DEFAULT_TRAJECTORY_SETTINGS,
      ...(loadSavedTrajectorySettings() as Partial<TrajectorySettingsConfig>),
      ...initialSettings,
    };

    const maxPredictionTicks = 600;
    this.maxTicks = maxPredictionTicks;
    this.forcePredictAnyMovement = false;
    this.sampler = new BallTrajectorySamplingController(maxPredictionTicks);
    this.tubeRenderer = new BallTrajectoryTubeRenderer(scene);
    this.syncMaterialProperties();
  }

  public get predictedPoints(): Float32Array {
    return this.sampler.predictedPoints;
  }
  public get rawPredictedPoints(): Float32Array {
    return this.sampler.rawPredictedPoints;
  }
  public get predictionCount(): number {
    return this.sampler.predictionCount;
  }
  public get impactTick(): number {
    return this.sampler.impactTick;
  }
  public get patternAnchorTick(): number {
    return this.sampler.patternAnchorTick;
  }
  public get isActive(): boolean {
    return this.sampler.isActive;
  }
  public get staticPreviewActive(): boolean {
    return this.sampler.staticPreviewActive;
  }
  public get anomalyRecorder() {
    return this.sampler.anomalyRecorder;
  }

  public notifyCarBallHit(tick?: number): void {
    this.sampler.notifyCarBallHit(tick);
  }

  public notifyBallStateReset(): void {
    this.sampler.notifyBallStateReset();
  }

  public getAnomalySummary() {
    return this.sampler.anomalyRecorder.getSummary();
  }

  public exportAnomalyBundle(includeAllSamples = true): Record<string, unknown> {
    return this.sampler.anomalyRecorder.buildExportBundle(includeAllSamples);
  }

  public resetAnomalyCapture(): void {
    this.sampler.anomalyRecorder.resetLatchedAnomaly();
  }

  public clearAnomalySamples(): void {
    this.sampler.anomalyRecorder.clearAllSamples();
  }

  public setTrajectoryOverride(override: BallTrajectoryOverride): void {
    this.trajectoryOverride = override;
    if (!this.isPredictionAllowed().allowed) this.clear();
  }

  public setRuntimeOverride(override: BallTrajectoryOverride): void {
    this.runtimeOverride = override;
    if (!this.isPredictionAllowed().allowed) this.clear();
  }

  public acquireTemporarySuppression(source: string = 'default'): void {
    if (source) this._suppressionSources.add(source);
    this.clear();
  }

  public releaseTemporarySuppression(source: string | null = null): void {
    if (source) {
      this._suppressionSources.delete(source);
    } else {
      this._suppressionSources.clear();
    }
  }

  public setSceneContext(context: {
    isGoalReplayActive?: boolean;
    isPodiumActive?: boolean;
  }): void {
    if (context.isGoalReplayActive !== undefined) {
      this._isGoalReplayActive = Boolean(context.isGoalReplayActive);
    }
    if (context.isPodiumActive !== undefined) {
      this._isPodiumActive = Boolean(context.isPodiumActive);
    }
    if (
      !this.isPredictionAllowed().allowed &&
      (this.isActive ||
        this.tubeRenderer?.preOcclusionMesh?.visible ||
        this.tubeRenderer?.foregroundMesh?.visible)
    ) {
      this.clear();
    }
  }

  public isPredictionAllowed(): ResolvedBallTrajectoryActivation {
    return resolveBallTrajectoryActivation({
      enabled: Boolean(this.settings.enabled),
      forcePredictAnyMovement: Boolean(this.forcePredictAnyMovement),
      staticPreviewActive: Boolean(this.staticPreviewActive),
      isGoalReplayActive: this._isGoalReplayActive,
      isPodiumActive: this._isPodiumActive,
      suppressionSourcesCount: this._suppressionSources.size,
      systemOverride: this.trajectoryOverride,
      runtimeOverride: this.runtimeOverride,
    });
  }

  public isTemporarilySuppressed(): boolean {
    const activation = this.isPredictionAllowed();
    return Boolean(
      activation.suppressedByOverride ||
      this._suppressionSources.size > 0 ||
      this._isGoalReplayActive ||
      this._isPodiumActive
    );
  }

  public setBallRadius(radius: number): void {
    if (Number.isFinite(radius) && radius > 0) {
      this.ballRadius = radius;
      this.syncMaterialProperties();
    }
  }

  public setPhysicsEngine(physics: TrajectoryPhysicsPort | null): void {
    this.physics = physics;
    if (physics?.ballRadius) this.setBallRadius(physics.ballRadius);
  }

  public syncMaterialProperties(): void {
    this.tubeRenderer?.syncUniforms(buildTubeRenderParams(this.ballRadius, this.settings));
  }

  public updateSettings(newSettings: Partial<TrajectorySettingsConfig>): void {
    Object.assign(this.settings, newSettings);
    this.syncMaterialProperties();
    if (!this.settings.enabled) this.clear();
    saveTrajectorySettings(this.settings);
  }

  public setStaticPreviewTrajectory(
    physics: TrajectoryPhysicsPort | null = null,
    ballLaunchState: TrajectoryBallLaunchState | null = null
  ): number {
    if (this.isTemporarilySuppressed()) {
      this.clearStaticPreview();
      return 0;
    }

    const phys = physics || this.physics;
    if (!phys?.getBallState || !phys?.setBallState) {
      this.clearStaticPreview();
      return 0;
    }

    const count = this.sampler.setStaticPreviewTrajectory(
      phys,
      ballLaunchState,
      this.settings.predictionTicks
    );
    if (count <= 0) this._hideMeshes();
    return count;
  }

  public clearStaticPreview(): void {
    this.clear();
  }

  public predictFromCurrentState(
    physics: TrajectoryPhysicsPort | null = null,
    targetTick: number | null = null,
    options: {
      forceFull?: boolean;
      deltaTicks?: number;
      reason?: TrajectoryUpdateKind;
    } = {}
  ): number {
    const phys = physics || this.physics;
    if (!this.isPredictionAllowed().allowed || !phys) {
      if (this.isActive) this.clear();
      return 0;
    }

    const count = this.sampler.predictFromCurrentState(phys, targetTick, this.settings, options);
    if (count <= 0) this._hideMeshes();
    return count;
  }

  private _hideMeshes(): void {
    this.tubeRenderer?.hideAll();
  }

  private _renderTrajectoryGeometry(
    elapsedTicks: number,
    patternElapsedTicks: number,
    dynamicMode: boolean,
    liveBallPosition: LiveBallPositionLike | null | undefined
  ): number {
    if (!this.tubeRenderer) return 0;

    const tubeParams = buildTubeRenderParams(this.ballRadius, this.settings);
    const startIndex = Math.max(0, elapsedTicks);

    this.tubeRenderer.updateBounceAndGroundAnchors(
      this.predictedPoints,
      this.predictionCount,
      startIndex,
      this.sampler.bounceMarkersBuffer,
      this.sampler.bounceCount,
      tubeParams
    );

    const phaseOffset = dynamicMode ? 0 : patternElapsedTicks;
    return this.tubeRenderer.updateTubeGeometry(
      this.predictedPoints,
      this.predictionCount,
      startIndex,
      this.settings.solidTicks,
      this.settings.transparentTicks,
      phaseOffset,
      liveBallPosition,
      tubeParams
    );
  }

  private _maybePublishTelemetry(
    frameStartMs: number,
    geometryBuildTimeUs: number,
    remainingSlices: number,
    primitiveCount: number,
    ballSpeedUu: number
  ): void {
    if (!this.onTelemetry) return;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : 0;
    if (!shouldPublishTrajectoryTelemetry(nowMs, this._lastTelemetryPublishMs)) return;
    this._lastTelemetryPublishMs = nowMs;

    this.onTelemetry(
      buildBallTrajectoryTelemetrySnapshot({
        frameStartMs,
        nowMs,
        geometryBuildTimeUs,
        remainingSlices,
        primitiveCount,
        ballSpeedUu,
        samplerMetrics: this.sampler,
        anomalySummary: this.sampler.anomalyRecorder.getSummary(),
      })
    );
  }

  public update(
    currentTick: number,
    liveBallPosition: LiveBallPositionLike | null = null,
    _renderWidth: number | null = null,
    _renderHeight: number | null = null,
    physics: TrajectoryPhysicsPort | null = null
  ): void {
    const frameStartMs = typeof performance !== 'undefined' ? performance.now() : 0;
    const activation = this.isPredictionAllowed();
    if (!activation.allowed) {
      if (activation.suppressedByOverride && this.isActive) {
        this.clear();
      } else {
        this._hideMeshes();
      }
      return;
    }

    const phys = physics || this.physics;

    if (this.staticPreviewActive && this.isActive && this.predictionCount > 1) {
      const scrollOffset = computeStaticPreviewScrollOffset(frameStartMs);
      const tGeom0 = typeof performance !== 'undefined' ? performance.now() : 0;
      const prims = this._renderTrajectoryGeometry(0, -scrollOffset, false, liveBallPosition);
      const geomUs =
        ((typeof performance !== 'undefined' ? performance.now() : 0) - tGeom0) * 1000.0;
      this.sampler.markStaticPreviewUpdate();
      this._maybePublishTelemetry(frameStartMs, geomUs, this.predictionCount, prims, 0);
      return;
    }

    if (!phys) return;

    const stateBuf = phys.state;
    const isSleeping = phys.isBallSleeping?.() ?? false;
    if (isSleeping || !stateBuf) {
      if (this.isActive) this.clear();
      this.sampler.markSleeping();
      this._maybePublishTelemetry(frameStartMs, 0, 0, 0, 0);
      return;
    }

    const ballSpeedUu = Math.hypot(stateBuf[16], stateBuf[17], stateBuf[18]);
    const awake = this.sampler.stepLivePrediction(
      phys,
      stateBuf,
      currentTick,
      this.forcePredictAnyMovement,
      this.settings
    );
    if (!awake) {
      this._hideMeshes();
      this._maybePublishTelemetry(frameStartMs, 0, 0, 0, ballSpeedUu);
      return;
    }

    if (!this.isActive || this.predictionCount <= 1) {
      this._hideMeshes();
      return;
    }

    const elapsed = Math.floor(currentTick - this.impactTick);
    if (elapsed >= this.predictionCount) {
      this.clear();
      return;
    }
    if (elapsed < 0) {
      this._hideMeshes();
      return;
    }

    const patternElapsed = resolvePatternElapsedTicks(currentTick, this.patternAnchorTick, elapsed);

    const tGeom0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const prims = this._renderTrajectoryGeometry(
      elapsed,
      patternElapsed,
      Boolean(this.settings.dynamicMode),
      liveBallPosition
    );
    const geomUs = ((typeof performance !== 'undefined' ? performance.now() : 0) - tGeom0) * 1000.0;

    this._maybePublishTelemetry(
      frameStartMs,
      geomUs,
      Math.max(0, this.predictionCount - elapsed),
      prims,
      ballSpeedUu
    );
  }

  public clear(): void {
    this.sampler.clear();
    this._hideMeshes();
  }

  public dispose(): void {
    this.clear();
    this._suppressionSources.clear();
    if (this.tubeRenderer) {
      this.tubeRenderer.dispose(this.scene);
      this.tubeRenderer = null;
    }
  }
}

export default BallTrajectoryPredictor;
