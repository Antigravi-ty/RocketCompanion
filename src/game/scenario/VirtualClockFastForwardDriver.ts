/**
 * VirtualClockFastForwardDriver.ts
 * Stateful SubController driving GameRuntime's 7-stage FramePipeline using a
 * deterministic 120Hz monotonic virtual clock with configurable fast-forward speed
 * (1x/10x/20x/50x), zero-escape runtime error interception, and SceneGraph probes.
 */

import type { CarControlsInput } from '../../network/protocol/InputPacketCodec.ts';
import {
  buildAllStageTimingDistributions, buildKeyframeRenderSample, buildStepsByTickMap,
  evaluateCameraSmoothness, extractCameraPoseSample, extractTopHitchFrames,
  normalizeCarControls, PIPELINE_STAGE_NAMES, queryCompiledShaderProgramCount,
  queryWebGlContextAttributesSummary, queryWebGlError, resolveRuntimeCameraMode,
  resolveSpeedPacingConfig, roundMetric, type CameraPoseSample, type RawTickTimingSample,
} from './scenarioMetricsPipeline.ts';
import {
  attachRuntimeErrorInterceptors, buildGoldenBaselineDiffSummary,
  captureVehicleRigGeometryProbe, diffVehicleRigProbeAgainstGolden65f1538d,
} from './scenarioRigProbeAndGoldenDiffPipeline.ts';
import { MultiClientLoopbackSimulator } from './MultiClientLoopbackSimulator.ts';
import type {
  KeyframeRenderSample, PipelineStageName, ScenarioAssertionResult, ScenarioDriverRunOptions,
  ScenarioRunReport, ScenarioScript, ScenarioStepContext,
  VehicleRigGeometryProbeSnapshot, VehicleRigGoldenDiffReport,
} from './ScenarioTypes.ts';

const FIXED_TICK_DT_SEC = 1 / 120;
const FIXED_TICK_DT_MS = 1000 / 120;

export const NEUTRAL_CONTROLS: Readonly<CarControlsInput> = Object.freeze({
  throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false,
});

export class VirtualClockFastForwardDriver {
  public readonly runtime: any;
  public readonly loopbackSimulator: MultiClientLoopbackSimulator;
  private readonly realNow: () => number;
  private virtualNowMs = 1000;
  private overrideLocalControls: CarControlsInput | null = null;
  private pendingKeyframeReason: string | null = null;
  private isRunningScenario = false;
  private defaultOptions: ScenarioDriverRunOptions = {
    speed: '20x', failOnConsoleError: true, includeGoldenDiff: true,
  };

  constructor(runtime: any, defaultOptions?: ScenarioDriverRunOptions) {
    this.runtime = runtime;
    this.loopbackSimulator = new MultiClientLoopbackSimulator(runtime);
    this.realNow = performance.now.bind(performance);
    if (defaultOptions) this.defaultOptions = { ...this.defaultOptions, ...defaultOptions };
  }

  public setDefaultOptions(opts: ScenarioDriverRunOptions): void {
    this.defaultOptions = { ...this.defaultOptions, ...opts };
  }
  public getCompiledShaderProgramCount(): number { return queryCompiledShaderProgramCount(this.runtime?.renderer); }
  public getWebGlContextAttributesSummary(): { renderer: string; vendor: string } { return queryWebGlContextAttributesSummary(this.runtime?.renderer); }
  public captureVehicleRigProbe(carIndex = 0): VehicleRigGeometryProbeSnapshot | null { return captureVehicleRigGeometryProbe(this.runtime?.arena, carIndex); }
  public diffVehicleRigAgainstGolden(carIndex = 0, toleranceUu?: number): VehicleRigGoldenDiffReport | null {
    const probe = this.captureVehicleRigProbe(carIndex);
    return probe ? diffVehicleRigProbeAgainstGolden65f1538d(probe, toleranceUu) : null;
  }

  public async runScenario(
    script: ScenarioScript,
    runOptions?: ScenarioDriverRunOptions,
  ): Promise<ScenarioRunReport> {
    if (this.isRunningScenario) {
      throw new Error('[VirtualClockFastForwardDriver] A scenario is already running.');
    }
    this.isRunningScenario = true;

    const pacing = resolveSpeedPacingConfig(script.renderStride, script.batchYieldTicks, {
      ...this.defaultOptions, ...runOptions,
    });

    const r = this.runtime;
    const wasRunning = Boolean(r?.running);
    if (wasRunning) r.stop();

    const origPerfNow = performance.now;
    const origKeyboardRead = r?.keyboard?.read ? r.keyboard.read.bind(r.keyboard) : null;

    const assertions: ScenarioAssertionResult[] = [];
    const tickSamples: RawTickTimingSample[] = [];
    const keyframeSamples: KeyframeRenderSample[] = [];
    const cameraPoses: CameraPoseSample[] = [];
    const capturedProbes: VehicleRigGeometryProbeSnapshot[] = [];
    const stepsByTick = buildStepsByTickMap(script.steps);

    let currentTick = 0;
    const baseVirtualMs = Math.max(1000, this.realNow());
    this.virtualNowMs = baseVirtualMs;
    this.overrideLocalControls = null;
    this.pendingKeyframeReason = 'scenario_initial_frame';

    const errorInterceptor = attachRuntimeErrorInterceptors(() => ({
      tick: currentTick,
      virtualOffsetMs: this.virtualNowMs - baseVirtualMs,
    }));

    const stepContext: ScenarioStepContext = {
      get tick() { return currentTick; },
      get virtualTimeMs() { return baseVirtualMs + currentTick * FIXED_TICK_DT_MS; },
      runtime: r,
      loopbackSimulator: this.loopbackSimulator,
      setLocalCarControls: (c) => { this.overrideLocalControls = normalizeCarControls<CarControlsInput>(c); },
      setBallState: (state) => {
        r?.physics?.setBallState?.(state); r?.authoritativeServer?.fallbackSim?.setBallState?.(state);
        r?.interpolator?.sync?.(this.virtualNowMs);
      },
      setCarState: (carIndex, state) => {
        r?.physics?.setCarState?.(carIndex, state); r?.authoritativeServer?.fallbackSim?.setCarState?.(carIndex, state);
        r?.interpolator?.sync?.(this.virtualNowMs);
      },
      captureVehicleRigProbe: (carIndex = 0) => {
        const probe = captureVehicleRigGeometryProbe(r?.arena, carIndex);
        if (probe) capturedProbes.push(probe);
        return probe;
      },
      diffVehicleRigAgainstGolden: (carIndex = 0, toleranceUu) => {
        const probe = captureVehicleRigGeometryProbe(r?.arena, carIndex);
        if (!probe) return null;
        capturedProbes.push(probe);
        return diffVehicleRigProbeAgainstGolden65f1538d(probe, toleranceUu);
      },
      markKeyframe: (reason) => { this.pendingKeyframeReason = reason; },
      recordAssertion: (label, passed, detail) => {
        assertions.push({ tick: currentTick, label, passed: Boolean(passed), detail });
      },
    };

    try {
      if (r?.keyboard && origKeyboardRead) {
        r.keyboard.read = () =>
          this.overrideLocalControls ? { ...this.overrideLocalControls } : origKeyboardRead();
      }

      performance.now = () => this.virtualNowMs;
      if (script.setup) await script.setup(stepContext);

      const totalTicks = Math.max(1, script.totalTicks);
      const forceKeyframes = script.forceRenderOnKeyframes !== false;
      let prevPhase = String(r?.match?.state?.phase || 'freeplay');
      let prevMode = String(r?.match?.state?.mode || 'freeplay');
      let prevCam = resolveRuntimeCameraMode(r);
      let renderedFramesCount = 0;
      let skippedRenderFramesCount = 0;

      const scenarioWallStartMs = this.realNow();

      for (let tick = 0; tick < totalTicks; tick++) {
        currentTick = tick;
        this.virtualNowMs = baseVirtualMs + tick * FIXED_TICK_DT_MS;

        const scheduledSteps = stepsByTick.get(tick);
        if (scheduledSteps) {
          for (const st of scheduledSteps) {
            if (st.forceKeyframeRender) {
              this.pendingKeyframeReason = st.keyframeReason || st.description || `step_${tick}`;
            }
            if (st.action) await st.action(stepContext);
          }
        }

        if (script.perTick) script.perTick(stepContext);
        const ov = this.overrideLocalControls as CarControlsInput | null;
        if (ov?.jump && (r?.match?.state?.phase === 'replay' || r?.networkReconciler?.replayPlaybackMode)) {
          r._localSkipReplayReady = true;
          if (r.networkReconciler) r.networkReconciler.localSkipReplayReady = true;
        }
        if (this.loopbackSimulator.isActive()) {
          this.loopbackSimulator.stepVirtualPeers(tick, this.virtualNowMs);
        }

        const prePhase = String(r?.match?.state?.phase || 'freeplay');
        const preMode = String(r?.match?.state?.mode || 'freeplay');
        const preCam = resolveRuntimeCameraMode(r);
        if (forceKeyframes) {
          if (prePhase !== prevPhase) this.pendingKeyframeReason = `phase_${prevPhase}_to_${prePhase}`;
          else if (preMode !== prevMode) this.pendingKeyframeReason = `mode_${prevMode}_to_${preMode}`;
          else if (preCam !== prevCam) this.pendingKeyframeReason = `camera_${prevCam}_to_${preCam}`;
        }

        const isKeyframeTick = Boolean(this.pendingKeyframeReason);
        const shouldRenderGpu = tick % pacing.renderStride === 0 || tick === totalTicks - 1 || isKeyframeTick;
        const tickResult = this.executeSingleVirtualTick(this.virtualNowMs, shouldRenderGpu, isKeyframeTick);

        const postPhase = String(r?.match?.state?.phase || 'freeplay');
        const postMode = String(r?.match?.state?.mode || 'freeplay');
        const postCam = resolveRuntimeCameraMode(r);

        if (forceKeyframes && !shouldRenderGpu && (postPhase !== prePhase || postMode !== preMode || postCam !== preCam)) {
          this.pendingKeyframeReason =
            postPhase !== prePhase ? `phase_${prePhase}_to_${postPhase}`
            : postMode !== preMode ? `mode_${preMode}_to_${postMode}`
            : `camera_${preCam}_to_${postCam}`;
          this.executeForcedKeyframeRenderPass(tickResult);
        }

        if (tickResult.didGpuRender) renderedFramesCount++;
        else skippedRenderFramesCount++;

        if (this.pendingKeyframeReason && tickResult.didGpuRender) {
          keyframeSamples.push(
            buildKeyframeRenderSample(
              tick, this.virtualNowMs - baseVirtualMs, this.pendingKeyframeReason,
              postPhase, postMode, postCam, tickResult.stageDurationsMs.RenderStage,
              tickResult.totalFrameWallMs, tickResult.shaderProgramsBefore,
              tickResult.shaderProgramsAfter, tickResult.shaderProgramsDelta,
              tickResult.glError, r?.renderer?.info,
            ),
          );
          this.pendingKeyframeReason = null;
        }

        prevPhase = postPhase;
        prevMode = postMode;
        prevCam = postCam;

        tickSamples.push({
          tick, virtualTimeMs: this.virtualNowMs - baseVirtualMs,
          phase: postPhase, cameraMode: postCam,
          didGpuRender: tickResult.didGpuRender,
          shaderProgramsDelta: tickResult.shaderProgramsDelta,
          stageDurationsMs: tickResult.stageDurationsMs,
          totalFrameWallMs: tickResult.totalFrameWallMs,
        });

        const pose = extractCameraPoseSample(tick, postPhase, postCam, r?.camera?.camera);
        if (pose) cameraPoses.push(pose);

        if (tick === 1 && capturedProbes.length === 0) {
          const initialProbe = captureVehicleRigGeometryProbe(r?.arena, 0);
          if (initialProbe) capturedProbes.push(initialProbe);
        }

        if ((tick + 1) % pacing.batchYieldTicks === 0) {
          performance.now = origPerfNow;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          performance.now = () => this.virtualNowMs;
        }
      }

      const wallClockDurationMs = Math.max(0.001, this.realNow() - scenarioWallStartMs);
      const multiplayerLoopback = this.loopbackSimulator.isActive() ? this.loopbackSimulator.collectTelemetry() : null;
      if (script.teardown) await script.teardown(stepContext);

      const stageTimings = buildAllStageTimingDistributions(tickSamples);
      const topHitchFrames = extractTopHitchFrames(tickSamples, 5);
      const cameraSmoothness = evaluateCameraSmoothness(cameraPoses, keyframeSamples);
      const goldenDiff = pacing.includeGoldenDiff ? buildGoldenBaselineDiffSummary(r?.arena, capturedProbes) : null;
      const runtimeErrors = errorInterceptor.buildSummary();

      assertions.push({
        tick: totalTicks - 1, label: 'camera_no_nan_poses', passed: cameraSmoothness.nanFrameCount === 0,
        detail: cameraSmoothness.nanFrameCount > 0 ? `Detected ${cameraSmoothness.nanFrameCount} NaN camera poses` : `All ${cameraSmoothness.sampleCount} camera poses finite`,
      });

      if (pacing.failOnConsoleError) {
        const e0 = runtimeErrors.entries[0];
        const loc = e0?.fileName ? ` (${e0.fileName}:${e0.lineNumber ?? 0})` : '';
        assertions.push({
          tick: e0?.tick ?? totalTicks - 1, label: 'zero_runtime_and_console_errors',
          passed: runtimeErrors.totalErrorCount === 0,
          detail: runtimeErrors.totalErrorCount === 0
            ? 'window.onerror=0, unhandledrejection=0, console.error=0'
            : `Captured ${runtimeErrors.totalErrorCount} error(s): [${e0?.source}] ${e0?.message}${loc}`,
        });
      }

      const simulatedDurationSeconds = roundMetric(totalTicks * FIXED_TICK_DT_SEC, 3);
      const effectiveTickRateHz = roundMetric((totalTicks / wallClockDurationMs) * 1000, 1);

      return {
        scenarioId: script.id, title: script.title, description: script.description,
        passed: assertions.every((a) => a.passed), configuredSpeedPreset: pacing.presetLabel,
        totalTicks, simulatedDurationSeconds, wallClockDurationMs: roundMetric(wallClockDurationMs, 2),
        effectiveTickRateHz, speedupFactorVsRealtime: roundMetric(effectiveTickRateHz / 120, 2),
        renderedFramesCount, skippedRenderFramesCount, stageTimings, topHitchFrames,
        keyframeRenders: keyframeSamples, cameraSmoothness, multiplayerLoopback,
        runtimeErrors, vehicleRigProbes: capturedProbes, goldenDiff, assertions,
      };
    } finally {
      errorInterceptor.dispose();
      performance.now = origPerfNow;
      if (r?.keyboard && origKeyboardRead) r.keyboard.read = origKeyboardRead;
      this.overrideLocalControls = null;
      this.isRunningScenario = false;
      if (wasRunning && r) {
        r.lastTimestamp = performance.now();
        r.interpolator?.sync?.(r.lastTimestamp);
        r.start();
      }
    }
  }

  private executeSingleVirtualTick(
    virtualTimestamp: number,
    shouldRenderGpu: boolean,
    checkGlErrorOnKeyframe = false,
  ) {
    const r = this.runtime;
    const pipeline = r.pipeline;
    const ctx = pipeline.context;

    r.lastTimestamp = virtualTimestamp - FIXED_TICK_DT_MS;
    if (r.interpolator) {
      r.interpolator.lastTime = virtualTimestamp - FIXED_TICK_DT_MS;
      r.interpolator.accumulator = 1e-6;
    }

    ctx.reset(virtualTimestamp, FIXED_TICK_DT_SEC);
    ctx.shouldSkipGpuRender = !shouldRenderGpu;

    const shaderProgramsBefore = this.getCompiledShaderProgramCount();
    const stageDurationsMs = {
      InputStage: 0, SimulationStage: 0, GameplayModeStage: 0, PresentationStage: 0,
      AudioStage: 0, RenderStage: 0, TelemetryStage: 0,
    } as Record<PipelineStageName, number>;

    const stages = pipeline.stages;
    let totalFrameWallMs = 0;

    for (let i = 0; i < stages.length; i++) {
      const stageName = PIPELINE_STAGE_NAMES[i] || ('TelemetryStage' as PipelineStageName);
      const t0 = this.realNow();
      stages[i].execute(ctx);
      const dur = this.realNow() - t0;
      stageDurationsMs[stageName] = dur;
      totalFrameWallMs += dur;
    }

    const glError =
      checkGlErrorOnKeyframe && !ctx.shouldSkipGpuRender ? queryWebGlError(r?.renderer) : 0;
    const shaderProgramsAfter = this.getCompiledShaderProgramCount();

    return {
      didGpuRender: !ctx.shouldSkipGpuRender,
      shaderProgramsBefore, shaderProgramsAfter,
      shaderProgramsDelta: Math.max(0, shaderProgramsAfter - shaderProgramsBefore),
      glError, stageDurationsMs, totalFrameWallMs,
    };
  }

  private executeForcedKeyframeRenderPass(
    res: ReturnType<VirtualClockFastForwardDriver['executeSingleVirtualTick']>,
  ): void {
    const r = this.runtime;
    const ctx = r.pipeline.context;
    ctx.shouldSkipGpuRender = false;
    res.shaderProgramsBefore = this.getCompiledShaderProgramCount();
    const t0 = this.realNow();
    r.renderSubsystem?.update?.(ctx);
    const extraWallMs = this.realNow() - t0;
    res.glError = queryWebGlError(r?.renderer);
    res.stageDurationsMs.RenderStage += extraWallMs;
    res.shaderProgramsAfter = this.getCompiledShaderProgramCount();
    res.shaderProgramsDelta = Math.max(0, res.shaderProgramsAfter - res.shaderProgramsBefore);
    res.didGpuRender = true;
    res.totalFrameWallMs += extraWallMs;
  }
}
