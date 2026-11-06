/**
 * VirtualClockFastForwardDriver.ts
 * Stateful SubController driving GameRuntime's 7-stage FramePipeline at maximum
 * machine rate using a deterministic 120Hz monotonic virtual clock while profiling
 * real CPU/GPU wall-clock execution times per stage and capturing keyframe shader
 * compilation and WebGL render metrics.
 */

import type { CarControlsInput } from '../../network/protocol/InputPacketCodec.ts';
import {
  buildAllStageTimingDistributions,
  evaluateCameraSmoothness,
  extractTopHitchFrames,
  PIPELINE_STAGE_NAMES,
  roundMetric,
  type CameraPoseSample,
  type RawTickTimingSample,
} from './scenarioMetricsPipeline.ts';
import { MultiClientLoopbackSimulator } from './MultiClientLoopbackSimulator.ts';
import type {
  KeyframeRenderSample,
  PipelineStageName,
  ScenarioAssertionResult,
  ScenarioRunReport,
  ScenarioScript,
  ScenarioStepContext,
  ScenarioTickStep,
} from './ScenarioTypes.ts';

const FIXED_TICK_DT_SEC = 1 / 120;
const FIXED_TICK_DT_MS = 1000 / 120;

const NEUTRAL_CONTROLS: Readonly<CarControlsInput> = Object.freeze({
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
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
    const programs = this.runtime?.renderer?.info?.programs;
    return Array.isArray(programs) ? programs.length : 0;
  }

  public getWebGlContextAttributesSummary(): { renderer: string; vendor: string } {
    try {
      const gl = this.runtime?.renderer?.getContext?.() as WebGLRenderingContext | null;
      if (!gl) return { renderer: 'unavailable', vendor: 'unavailable' };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg
        ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || gl.getParameter(gl.RENDERER))
        : String(gl.getParameter(gl.RENDERER) || 'WebGL');
      const vendor = dbg
        ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || gl.getParameter(gl.VENDOR))
        : String(gl.getParameter(gl.VENDOR) || 'WebGL');
      return { renderer, vendor };
    } catch {
      return { renderer: 'error', vendor: 'error' };
    }
  }

  public async runScenario(script: ScenarioScript): Promise<ScenarioRunReport> {
    if (this.isRunningScenario) {
      throw new Error('[VirtualClockFastForwardDriver] A scenario is already running.');
    }
    this.isRunningScenario = true;

    const r = this.runtime;
    const wasRunning = Boolean(r?.running);
    if (wasRunning) {
      r.stop();
    }

    const origPerfNow = performance.now;
    const origKeyboardRead = r?.keyboard?.read ? r.keyboard.read.bind(r.keyboard) : null;
    const origHasFocus =
      typeof document !== 'undefined' && typeof document.hasFocus === 'function'
        ? document.hasFocus.bind(document)
        : null;
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

    const stepContext: ScenarioStepContext = {
      get tick() {
        return currentTick;
      },
      get virtualTimeMs() {
        return baseVirtualMs + currentTick * FIXED_TICK_DT_MS;
      },
      runtime: r,
      loopbackSimulator: this.loopbackSimulator,
      setLocalCarControls: (controls) => {
        if (!controls) {
          this.overrideLocalControls = null;
          return;
        }
        this.overrideLocalControls = {
          throttle: controls.throttle ?? 0,
          steer: controls.steer ?? 0,
          pitch: controls.pitch ?? 0,
          yaw: controls.yaw ?? 0,
          roll: controls.roll ?? 0,
          jump: Boolean(controls.jump),
          boost: Boolean(controls.boost),
          handbrake: Boolean(controls.handbrake),
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
      markKeyframe: (reason) => {
        this.pendingKeyframeReason = reason;
      },
      recordAssertion: (label, passed, detail) => {
        assertions.push({
          tick: currentTick,
          label,
          passed: Boolean(passed),
          detail,
        });
      },
    };

    try {
      if (typeof document !== 'undefined') {
        try {
          Object.defineProperty(document, 'hidden', {
            configurable: true,
            get: () => false,
          });
          document.hasFocus = () => true;
        } catch {
          // Ignore if read-only in environment
        }
      }

      if (r?.keyboard && origKeyboardRead) {
        r.keyboard.read = () => {
          if (this.overrideLocalControls) {
            return { ...this.overrideLocalControls };
          }
          return origKeyboardRead();
        };
      }

      performance.now = () => this.virtualNowMs;

      if (script.setup) {
        await script.setup(stepContext);
      }

      const totalTicks = Math.max(1, script.totalTicks);
      const renderStride = Math.max(1, script.renderStride || 15);
      const batchYieldTicks = Math.max(10, script.batchYieldTicks || 60);
      const forceKeyframes = script.forceRenderOnKeyframes !== false;

      let prevPhase = String(r?.match?.state?.phase || 'freeplay');
      let prevMode = String(r?.match?.state?.mode || 'freeplay');
      let prevCameraMode = this.resolveCurrentCameraMode();
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
            if (st.action) {
              await st.action(stepContext);
            }
          }
        }

        if (script.perTick) {
          script.perTick(stepContext);
        }

        if (this.loopbackSimulator.isActive()) {
          this.loopbackSimulator.stepVirtualPeers(tick, this.virtualNowMs);
        }

        const prePhase = String(r?.match?.state?.phase || 'freeplay');
        const preMode = String(r?.match?.state?.mode || 'freeplay');
        const preCam = this.resolveCurrentCameraMode();
        if (forceKeyframes) {
          if (prePhase !== prevPhase) {
            this.pendingKeyframeReason = `phase_${prevPhase}_to_${prePhase}`;
          } else if (preMode !== prevMode) {
            this.pendingKeyframeReason = `mode_${prevMode}_to_${preMode}`;
          } else if (preCam !== prevCameraMode) {
            this.pendingKeyframeReason = `camera_${prevCameraMode}_to_${preCam}`;
          }
        }

        const isKeyframeTick = Boolean(this.pendingKeyframeReason);
        const isStrideTick = tick % renderStride === 0 || tick === totalTicks - 1;
        const shouldRenderGpu = isStrideTick || isKeyframeTick;

        const tickResult = this.executeSingleVirtualTick(
          tick,
          this.virtualNowMs,
          shouldRenderGpu,
          isKeyframeTick,
        );

        const postPhase = String(r?.match?.state?.phase || 'freeplay');
        const postMode = String(r?.match?.state?.mode || 'freeplay');
        const postCam = this.resolveCurrentCameraMode();

        if (
          forceKeyframes &&
          !shouldRenderGpu &&
          (postPhase !== prePhase || postMode !== preMode || postCam !== preCam)
        ) {
          const transitionReason =
            postPhase !== prePhase
              ? `phase_${prePhase}_to_${postPhase}`
              : postMode !== preMode
                ? `mode_${preMode}_to_${postMode}`
                : `camera_${preCam}_to_${postCam}`;
          this.pendingKeyframeReason = transitionReason;
          const forcedRenderResult = this.executeForcedKeyframeRenderPass(
            tickResult.stageDurationsMs,
          );
          tickResult.didGpuRender = true;
          tickResult.shaderProgramsBefore = forcedRenderResult.shaderProgramsBefore;
          tickResult.shaderProgramsAfter = forcedRenderResult.shaderProgramsAfter;
          tickResult.shaderProgramsDelta = forcedRenderResult.shaderProgramsDelta;
          tickResult.glError = forcedRenderResult.glError;
          tickResult.totalFrameWallMs += forcedRenderResult.extraWallMs;
        }

        if (tickResult.didGpuRender) {
          renderedFramesCount++;
        } else {
          skippedRenderFramesCount++;
        }

        if (this.pendingKeyframeReason && tickResult.didGpuRender) {
          const renderInfo = r?.renderer?.info;
          keyframeSamples.push({
            tick,
            virtualTimeMs: roundMetric(this.virtualNowMs - baseVirtualMs, 2),
            reason: this.pendingKeyframeReason,
            phase: postPhase,
            gameMode: postMode,
            cameraMode: postCam,
            renderStageWallMs: roundMetric(tickResult.stageDurationsMs.RenderStage, 4),
            totalFrameWallMs: roundMetric(tickResult.totalFrameWallMs, 4),
            shaderProgramsBefore: tickResult.shaderProgramsBefore,
            shaderProgramsAfter: tickResult.shaderProgramsAfter,
            shaderProgramsDelta: tickResult.shaderProgramsDelta,
            glError: tickResult.glError,
            drawCalls: renderInfo?.render?.calls ?? 0,
            triangles: renderInfo?.render?.triangles ?? 0,
            geometries: renderInfo?.memory?.geometries ?? 0,
            textures: renderInfo?.memory?.textures ?? 0,
          });
          this.pendingKeyframeReason = null;
        }

        prevPhase = postPhase;
        prevMode = postMode;
        prevCameraMode = postCam;

        tickSamples.push({
          tick,
          virtualTimeMs: this.virtualNowMs - baseVirtualMs,
          phase: postPhase,
          cameraMode: postCam,
          didGpuRender: tickResult.didGpuRender,
          shaderProgramsDelta: tickResult.shaderProgramsDelta,
          stageDurationsMs: tickResult.stageDurationsMs,
          totalFrameWallMs: tickResult.totalFrameWallMs,
        });

        const camObj = r?.camera?.camera;
        if (camObj?.position && camObj?.quaternion) {
          cameraPoses.push({
            tick,
            phase: postPhase,
            cameraMode: postCam,
            px: camObj.position.x,
            py: camObj.position.y,
            pz: camObj.position.z,
            qx: camObj.quaternion.x,
            qy: camObj.quaternion.y,
            qz: camObj.quaternion.z,
            qw: camObj.quaternion.w,
          });
        }

        if ((tick + 1) % batchYieldTicks === 0) {
          performance.now = origPerfNow;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          performance.now = () => this.virtualNowMs;
        }
      }

      const wallClockDurationMs = Math.max(0.001, this.realNow() - scenarioWallStartMs);
      const multiplayerLoopback = this.loopbackSimulator.isActive()
        ? this.loopbackSimulator.collectTelemetry()
        : null;

      if (script.teardown) {
        await script.teardown(stepContext);
      }

      const stageTimings = buildAllStageTimingDistributions(tickSamples);
      const topHitchFrames = extractTopHitchFrames(tickSamples, 5);
      const cameraSmoothness = evaluateCameraSmoothness(cameraPoses, keyframeSamples);

      if (cameraSmoothness.nanFrameCount > 0) {
        assertions.push({
          tick: totalTicks - 1,
          label: 'camera_no_nan_poses',
          passed: false,
          detail: `Detected ${cameraSmoothness.nanFrameCount} NaN camera pose frames`,
        });
      } else {
        assertions.push({
          tick: totalTicks - 1,
          label: 'camera_no_nan_poses',
          passed: true,
          detail: `All ${cameraSmoothness.sampleCount} camera poses finite`,
        });
      }

      const simulatedDurationSeconds = roundMetric(totalTicks * FIXED_TICK_DT_SEC, 3);
      const effectiveTickRateHz = roundMetric((totalTicks / wallClockDurationMs) * 1000, 1);
      const speedupFactorVsRealtime = roundMetric(effectiveTickRateHz / 120, 2);
      const allAssertionsPassed = assertions.every((a) => a.passed);

      return {
        scenarioId: script.id,
        title: script.title,
        description: script.description,
        passed: allAssertionsPassed,
        totalTicks,
        simulatedDurationSeconds,
        wallClockDurationMs: roundMetric(wallClockDurationMs, 2),
        effectiveTickRateHz,
        speedupFactorVsRealtime,
        renderedFramesCount,
        skippedRenderFramesCount,
        stageTimings,
        topHitchFrames,
        keyframeRenders: keyframeSamples,
        cameraSmoothness,
        multiplayerLoopback,
        assertions,
      };
    } finally {
      performance.now = origPerfNow;
      if (r?.keyboard && origKeyboardRead) {
        r.keyboard.read = origKeyboardRead;
      }
      if (typeof document !== 'undefined') {
        try {
          if (origHasFocus) document.hasFocus = origHasFocus;
          if (origHiddenDescriptor) {
            Object.defineProperty(document, 'hidden', origHiddenDescriptor);
          }
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

  private resolveCurrentCameraMode(): string {
    const r = this.runtime;
    if (r?.isGoalReplayCameraOverrideActive?.()) {
      const activeMode = r?.modeManager?.getActiveMode?.();
      const replayCamMode =
        activeMode?.directorPreview?.replayCameraMode ||
        activeMode?.replaySession?.replayCameraMode;
      if (replayCamMode) return String(replayCamMode);
      return 'director';
    }
    if (r?.camera?.isFreeCam) return 'freecam';
    return r?.camera?.mode || 'ball';
  }

  private executeSingleVirtualTick(
    _tick: number,
    virtualTimestamp: number,
    shouldRenderGpu: boolean,
    checkGlErrorOnKeyframe = false,
  ): {
    didGpuRender: boolean;
    shaderProgramsBefore: number;
    shaderProgramsAfter: number;
    shaderProgramsDelta: number;
    glError: number;
    stageDurationsMs: Record<PipelineStageName, number>;
    totalFrameWallMs: number;
  } {
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
      InputStage: 0,
      SimulationStage: 0,
      GameplayModeStage: 0,
      PresentationStage: 0,
      AudioStage: 0,
      RenderStage: 0,
      TelemetryStage: 0,
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

    let glError = 0;
    if (checkGlErrorOnKeyframe && !ctx.shouldSkipGpuRender && r?.renderer) {
      try {
        const gl = r.renderer.getContext?.() as WebGLRenderingContext | null;
        if (gl) {
          glError = gl.getError();
        }
      } catch {
        glError = 0;
      }
    }

    const shaderProgramsAfter = this.getCompiledShaderProgramCount();

    return {
      didGpuRender: !ctx.shouldSkipGpuRender,
      shaderProgramsBefore,
      shaderProgramsAfter,
      shaderProgramsDelta: Math.max(0, shaderProgramsAfter - shaderProgramsBefore),
      glError,
      stageDurationsMs,
      totalFrameWallMs,
    };
  }

  private executeForcedKeyframeRenderPass(
    stageDurationsMs: Record<PipelineStageName, number>,
  ): {
    shaderProgramsBefore: number;
    shaderProgramsAfter: number;
    shaderProgramsDelta: number;
    glError: number;
    extraWallMs: number;
  } {
    const r = this.runtime;
    const ctx = r.pipeline.context;
    ctx.shouldSkipGpuRender = false;
    const shaderProgramsBefore = this.getCompiledShaderProgramCount();
    const t0 = this.realNow();
    r.renderSubsystem?.update?.(ctx);
    const extraWallMs = this.realNow() - t0;
    let glError = 0;
    try {
      const gl = r?.renderer?.getContext?.() as WebGLRenderingContext | null;
      if (gl) glError = gl.getError();
    } catch {
      glError = 0;
    }
    stageDurationsMs.RenderStage += extraWallMs;
    const shaderProgramsAfter = this.getCompiledShaderProgramCount();
    return {
      shaderProgramsBefore,
      shaderProgramsAfter,
      shaderProgramsDelta: Math.max(0, shaderProgramsAfter - shaderProgramsBefore),
      glError,
      extraWallMs,
    };
  }
}

export { NEUTRAL_CONTROLS };
