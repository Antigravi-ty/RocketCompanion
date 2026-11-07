/**
 * VirtualClockFastForwardDriver.ts
 * Stateful SubController driving GameRuntime's 7-stage FramePipeline at maximum
 * machine rate using a deterministic 120Hz monotonic virtual clock while profiling
 * real CPU/GPU wall-clock execution times per stage, intercepting uncaught runtime
 * and console errors, and capturing keyframe shader/WebGL/rig geometry metrics.
 */

import type { CarControlsInput } from '../../network/protocol/InputPacketCodec.ts';
import {
  buildAllStageTimingDistributions, buildKeyframeRenderSample, evaluateCameraSmoothness,
  extractCameraPoseSample, extractTopHitchFrames, PIPELINE_STAGE_NAMES,
  queryCompiledShaderProgramCount, queryWebGlContextAttributesSummary, queryWebGlError,
  resolveRuntimeCameraMode, roundMetric, type CameraPoseSample, type RawTickTimingSample,
} from './scenarioMetricsPipeline.ts';
import { MultiClientLoopbackSimulator } from './MultiClientLoopbackSimulator.ts';
import {
  captureAllActiveVehicleRigProbes, captureVehicleRigGeometryProbe,
  resolveScenarioSpeedConfig, ScenarioRuntimeErrorInterceptor,
} from './ScenarioRuntimeProbeAndErrorGuard.ts';
import type {
  KeyframeRenderSample, PipelineStageName, ScenarioAssertionResult,
  ScenarioRunReport, ScenarioScript, ScenarioStepContext, ScenarioTickStep, VehicleRigGeometryProbe,
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

  constructor(runtime: any) {
    this.runtime = runtime;
    this.loopbackSimulator = new MultiClientLoopbackSimulator(runtime);
    this.realNow = performance.now.bind(performance);
  }

  public getCompiledShaderProgramCount(): number {
    return queryCompiledShaderProgramCount(this.runtime?.renderer);
  }

  public getWebGlContextAttributesSummary(): { renderer: string; vendor: string } {
    return queryWebGlContextAttributesSummary(this.runtime?.renderer);
  }

  public probeVehicleRig(carIndex = 0): VehicleRigGeometryProbe | null {
    return captureVehicleRigGeometryProbe(this.runtime?.arena, carIndex);
  }

  public async runScenario(script: ScenarioScript): Promise<ScenarioRunReport> {
    if (this.isRunningScenario) {
      throw new Error('[VirtualClockFastForwardDriver] A scenario is already running.');
    }
    this.isRunningScenario = true;

    const r = this.runtime;
    const wasRunning = Boolean(r?.running);
    if (wasRunning) r.stop();

    const origPerfNow = performance.now;
    const origKeyboardRead = r?.keyboard?.read ? r.keyboard.read.bind(r.keyboard) : null;
    const origHasFocus =
      typeof document !== 'undefined' && typeof document.hasFocus === 'function'
        ? document.hasFocus.bind(document) : null;
    const origHiddenDescriptor =
      typeof document !== 'undefined'
        ? Object.getOwnPropertyDescriptor(Document.prototype, 'hidden') ||
          Object.getOwnPropertyDescriptor(document, 'hidden')
        : undefined;

    const assertions: ScenarioAssertionResult[] = [];
    const tickSamples: RawTickTimingSample[] = [];
    const keyframeSamples: KeyframeRenderSample[] = [];
    const cameraPoses: CameraPoseSample[] = [];
    const stepsByTick = new Map<number, ScenarioTickStep[]>();
    for (const step of script.steps) {
      const list = stepsByTick.get(step.tick) || [];
      list.push(step);
      stepsByTick.set(step.tick, list);
    }

    let currentTick = 0;
    const baseVirtualMs = Math.max(1000, this.realNow());
    this.virtualNowMs = baseVirtualMs;
    this.overrideLocalControls = null;
    this.pendingKeyframeReason = 'scenario_initial_frame';
    const errorInterceptor = new ScenarioRuntimeErrorInterceptor(() => currentTick);

    const stepContext: ScenarioStepContext = {
      get tick() { return currentTick; },
      get virtualTimeMs() { return baseVirtualMs + currentTick * FIXED_TICK_DT_MS; },
      runtime: r,
      loopbackSimulator: this.loopbackSimulator,
      setLocalCarControls: (controls) => {
        if (!controls) { this.overrideLocalControls = null; return; }
        this.overrideLocalControls = {
          throttle: controls.throttle ?? 0, steer: controls.steer ?? 0,
          pitch: controls.pitch ?? 0, yaw: controls.yaw ?? 0, roll: controls.roll ?? 0,
          jump: Boolean(controls.jump), boost: Boolean(controls.boost), handbrake: Boolean(controls.handbrake),
        };
      },
      setBallState: (state) => {
        r?.physics?.setBallState?.(state);
        r?.authoritativeServer?.fallbackSim?.setBallState?.(state);
        r?.interpolator?.sync?.(this.virtualNowMs);
      },
      setCarState: (carIndex, state) => {
        r?.physics?.setCarState?.(carIndex, state);
        r?.authoritativeServer?.fallbackSim?.setCarState?.(carIndex, state);
        r?.interpolator?.sync?.(this.virtualNowMs);
      },
      markKeyframe: (reason) => { this.pendingKeyframeReason = reason; },
      recordAssertion: (label, passed, detail) => {
        assertions.push({ tick: currentTick, label, passed: Boolean(passed), detail });
      },
    };

    try {
      errorInterceptor.install();
      if (typeof document !== 'undefined') {
        try {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          document.hasFocus = () => true;
        } catch {
          // Ignore if read-only
        }
      }
      if (r?.keyboard && origKeyboardRead) {
        r.keyboard.read = () =>
          this.overrideLocalControls ? { ...this.overrideLocalControls } : origKeyboardRead();
      }

      performance.now = () => this.virtualNowMs;
      if (script.setup) await script.setup(stepContext);

      const totalTicks = Math.max(1, script.totalTicks);
      const speedCfg = resolveScenarioSpeedConfig(script.renderStride || 15, script.batchYieldTicks || 60);
      const { renderStride, batchYieldTicks } = speedCfg;
      const forceKeyframes = script.forceRenderOnKeyframes !== false;

      let prevPhase = String(r?.match?.state?.phase || 'freeplay');
      let prevMode = String(r?.match?.state?.mode || 'freeplay');
      let prevCameraMode = resolveRuntimeCameraMode(r);
      let renderedFramesCount = 0;
      let skippedRenderFramesCount = 0;
      const scenarioWallStartMs = this.realNow();

      for (let tick = 0; tick < totalTicks; tick++) {
        currentTick = tick;
        this.virtualNowMs = baseVirtualMs + tick * FIXED_TICK_DT_MS;

        const scheduledSteps = stepsByTick.get(tick);
        if (scheduledSteps) {
          for (let s = 0; s < scheduledSteps.length; s++) {
            const st = scheduledSteps[s];
            if (st.forceKeyframeRender) {
              this.pendingKeyframeReason = st.keyframeReason || st.description || `step_${tick}`;
            }
            if (st.action) await st.action(stepContext);
          }
        }

        if (script.perTick) script.perTick(stepContext);
        if (this.loopbackSimulator.isActive()) {
          this.loopbackSimulator.stepVirtualPeers(tick, this.virtualNowMs);
        }

        const prePhase = String(r?.match?.state?.phase || 'freeplay');
        const preMode = String(r?.match?.state?.mode || 'freeplay');
        const preCam = resolveRuntimeCameraMode(r);
        if (forceKeyframes) {
          if (prePhase !== prevPhase) this.pendingKeyframeReason = `phase_${prevPhase}_to_${prePhase}`;
          else if (preMode !== prevMode) this.pendingKeyframeReason = `mode_${prevMode}_to_${preMode}`;
          else if (preCam !== prevCameraMode) this.pendingKeyframeReason = `camera_${prevCameraMode}_to_${preCam}`;
        }

        const isKeyframeTick = Boolean(this.pendingKeyframeReason);
        const isStrideTick = tick % renderStride === 0 || tick === totalTicks - 1;
        const shouldRenderGpu = isStrideTick || isKeyframeTick;
        const tickResult = this.executeSingleVirtualTick(this.virtualNowMs, shouldRenderGpu, isKeyframeTick);

        const postPhase = String(r?.match?.state?.phase || 'freeplay');
        const postMode = String(r?.match?.state?.mode || 'freeplay');
        const postCam = resolveRuntimeCameraMode(r);

        if (
          forceKeyframes && !shouldRenderGpu &&
          (postPhase !== prePhase || postMode !== preMode || postCam !== preCam)
        ) {
          this.pendingKeyframeReason =
            postPhase !== prePhase ? `phase_${prePhase}_to_${postPhase}`
            : postMode !== preMode ? `mode_${preMode}_to_${postMode}` : `camera_${preCam}_to_${postCam}`;
          const forced = this.executeForcedKeyframeRenderPass(tickResult.stageDurationsMs);
          tickResult.didGpuRender = true;
          tickResult.shaderProgramsBefore = forced.shaderProgramsBefore;
          tickResult.shaderProgramsAfter = forced.shaderProgramsAfter;
          tickResult.shaderProgramsDelta = forced.shaderProgramsDelta;
          tickResult.glError = forced.glError;
          tickResult.totalFrameWallMs += forced.extraWallMs;
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
        prevCameraMode = postCam;

        tickSamples.push({
          tick, virtualTimeMs: this.virtualNowMs - baseVirtualMs,
          phase: postPhase, cameraMode: postCam,
          didGpuRender: tickResult.didGpuRender, shaderProgramsDelta: tickResult.shaderProgramsDelta,
          stageDurationsMs: tickResult.stageDurationsMs, totalFrameWallMs: tickResult.totalFrameWallMs,
        });

        const pose = extractCameraPoseSample(tick, postPhase, postCam, r?.camera?.camera);
        if (pose) cameraPoses.push(pose);

        if ((tick + 1) % batchYieldTicks === 0) {
          performance.now = origPerfNow;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          performance.now = () => this.virtualNowMs;
        }
      }

      const wallClockDurationMs = Math.max(0.001, this.realNow() - scenarioWallStartMs);
      const multiplayerLoopback = this.loopbackSimulator.isActive()
        ? this.loopbackSimulator.collectTelemetry() : null;
      const vehicleRigProbes = captureAllActiveVehicleRigProbes(r?.arena);

      if (script.teardown) await script.teardown(stepContext);

      const capturedRuntimeErrors = errorInterceptor.uninstall();
      const stageTimings = buildAllStageTimingDistributions(tickSamples);
      const topHitchFrames = extractTopHitchFrames(tickSamples, 5);
      const cameraSmoothness = evaluateCameraSmoothness(cameraPoses, keyframeSamples);

      assertions.push({
        tick: totalTicks - 1, label: 'camera_no_nan_poses',
        passed: cameraSmoothness.nanFrameCount === 0,
        detail: cameraSmoothness.nanFrameCount > 0
          ? `Detected ${cameraSmoothness.nanFrameCount} NaN camera pose frames`
          : `All ${cameraSmoothness.sampleCount} camera poses finite`,
      });
      assertions.push({
        tick: totalTicks - 1, label: 'runtime_zero_uncaught_or_console_errors',
        passed: capturedRuntimeErrors.length === 0,
        detail: capturedRuntimeErrors.length === 0
          ? '0 uncaught errors or console.error emissions'
          : `Captured ${capturedRuntimeErrors.length} error(s): ${capturedRuntimeErrors[0].message}`,
      });

      const simulatedDurationSeconds = roundMetric(totalTicks * FIXED_TICK_DT_SEC, 3);
      const effectiveTickRateHz = roundMetric((totalTicks / wallClockDurationMs) * 1000, 1);

      return {
        scenarioId: script.id, title: script.title, description: script.description,
        passed: assertions.every((a) => a.passed), totalTicks, simulatedDurationSeconds,
        wallClockDurationMs: roundMetric(wallClockDurationMs, 2), effectiveTickRateHz,
        speedupFactorVsRealtime: roundMetric(effectiveTickRateHz / 120, 2),
        fastForwardSpeedPreset: speedCfg.speedPreset,
        renderedFramesCount, skippedRenderFramesCount, stageTimings, topHitchFrames,
        keyframeRenders: keyframeSamples, cameraSmoothness, multiplayerLoopback,
        capturedRuntimeErrors, vehicleRigProbes, assertions,
      };
    } finally {
      errorInterceptor.uninstall();
      performance.now = origPerfNow;
      if (r?.keyboard && origKeyboardRead) r.keyboard.read = origKeyboardRead;
      if (typeof document !== 'undefined') {
        try {
          if (origHasFocus) document.hasFocus = origHasFocus;
          if (origHiddenDescriptor) Object.defineProperty(document, 'hidden', origHiddenDescriptor);
        } catch {
          // Ignore restore errors
        }
      }
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
    virtualTimestamp: number, shouldRenderGpu: boolean, checkGlErrorOnKeyframe = false,
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

    const glError = checkGlErrorOnKeyframe && !ctx.shouldSkipGpuRender ? queryWebGlError(r?.renderer) : 0;
    const shaderProgramsAfter = this.getCompiledShaderProgramCount();

    return {
      didGpuRender: !ctx.shouldSkipGpuRender, shaderProgramsBefore, shaderProgramsAfter,
      shaderProgramsDelta: Math.max(0, shaderProgramsAfter - shaderProgramsBefore),
      glError, stageDurationsMs, totalFrameWallMs,
    };
  }

  private executeForcedKeyframeRenderPass(stageDurationsMs: Record<PipelineStageName, number>) {
    const r = this.runtime;
    const ctx = r.pipeline.context;
    ctx.shouldSkipGpuRender = false;
    const shaderProgramsBefore = this.getCompiledShaderProgramCount();
    const t0 = this.realNow();
    r.renderSubsystem?.update?.(ctx);
    const extraWallMs = this.realNow() - t0;
    const glError = queryWebGlError(r?.renderer);
    stageDurationsMs.RenderStage += extraWallMs;
    const shaderProgramsAfter = this.getCompiledShaderProgramCount();
    return {
      shaderProgramsBefore, shaderProgramsAfter,
      shaderProgramsDelta: Math.max(0, shaderProgramsAfter - shaderProgramsBefore),
      glError, extraWallMs,
    };
  }
}
