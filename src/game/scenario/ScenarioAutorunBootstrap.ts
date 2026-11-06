/**
 * ScenarioAutorunBootstrap.ts
 * Stateful SubController capturing Stage 1~6 engine bootstrap telemetry via
 * LoadingProgressObserver and orchestrating ?autorunScenario=... baseline suites.
 */

import {
  getStageMeta,
  type LoadingCompleteEvent,
  type LoadingErrorEvent,
  type LoadingProgressObserver,
  type LoadingStageChangeEvent,
  type LoadingTaskCompleteEvent,
} from '../../loader/types.ts';
import { resolveRequestedScenarios } from './builtinBaselineScenarios.ts';
import { roundMetric } from './scenarioMetricsPipeline.ts';
import type {
  BaselineSuiteTelemetryReport,
  BootstrapStageSummary,
  BootstrapTaskTelemetry,
  BootstrapTelemetrySnapshot,
  ScenarioRunReport,
  ScenarioRuntimePort,
} from './ScenarioTypes.ts';
import { VirtualClockFastForwardDriver } from './VirtualClockFastForwardDriver.ts';

declare global {
  interface Window {
    __rcScenarioDriver?: ScenarioAutorunController;
    __rcScenarioReport?: BaselineSuiteTelemetryReport;
    __rcScenarioError?: string;
  }
}

export function getAutorunScenarioParam(): string | null {
  if (typeof window === 'undefined' || !window.location?.search) return null;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('autorunScenario');
  } catch {
    return null;
  }
}

export class ScenarioBootstrapTelemetryObserver implements LoadingProgressObserver {
  private readonly stageTitles = new Map<number, string>();
  private readonly tasks: BootstrapTaskTelemetry[] = [];
  private totalDurationMs = 0;
  private totalSteps = 0;
  private backgroundAssetsDurationMs = 0;

  public onStageChange(event: LoadingStageChangeEvent): void {
    this.stageTitles.set(event.stageIndex, event.stageTitle);
  }

  public onTaskComplete(event: LoadingTaskCompleteEvent): void {
    const stageTitle =
      this.stageTitles.get(event.stageIndex) || getStageMeta(event.stageIndex).title;
    this.tasks.push({
      stageIndex: event.stageIndex,
      stageTitle,
      step: event.step,
      totalSteps: event.totalSteps,
      taskId: event.taskId,
      taskName: event.taskName,
      durationMs: roundMetric(event.durationMs ?? 0, 2),
      status: event.status === 'skipped' ? 'skipped' : 'completed',
    });
  }

  public onError(event: LoadingErrorEvent): void {
    this.tasks.push({
      stageIndex: 0,
      stageTitle: 'Error',
      step: 0,
      totalSteps: this.totalSteps,
      taskId: event.taskId || 'unknown',
      taskName: event.taskName || 'Unknown Task',
      durationMs: 0,
      status: 'error',
    });
  }

  public onComplete(event: LoadingCompleteEvent = {}): void {
    this.totalDurationMs = roundMetric(event.totalDurationMs ?? 0, 2);
    this.totalSteps = event.totalSteps ?? this.tasks.length;
  }

  public setBackgroundAssetsDurationMs(durationMs: number): void {
    this.backgroundAssetsDurationMs = roundMetric(durationMs, 2);
  }

  public buildSnapshot(initialCompiledShaderPrograms: number): BootstrapTelemetrySnapshot {
    const stageMap = new Map<number, BootstrapStageSummary>();
    for (const task of this.tasks) {
      let group = stageMap.get(task.stageIndex);
      if (!group) {
        group = {
          stageIndex: task.stageIndex,
          stageTitle: task.stageTitle,
          totalDurationMs: 0,
          taskCount: 0,
          tasks: [],
        };
        stageMap.set(task.stageIndex, group);
      }
      group.tasks.push(task);
      group.taskCount++;
      group.totalDurationMs = roundMetric(group.totalDurationMs + task.durationMs, 2);
    }

    const stages = Array.from(stageMap.values()).sort((a, b) => a.stageIndex - b.stageIndex);
    return {
      totalDurationMs: this.totalDurationMs,
      totalSteps: this.totalSteps,
      backgroundAssetsDurationMs: this.backgroundAssetsDurationMs,
      initialCompiledShaderPrograms,
      stages,
    };
  }
}

export class ScenarioAutorunController {
  public readonly runtime: ScenarioRuntimePort;
  public readonly bootstrapObserver: ScenarioBootstrapTelemetryObserver;
  public readonly driver: VirtualClockFastForwardDriver;
  private readonly initialShaderPrograms: number;

  constructor(runtime: ScenarioRuntimePort, bootstrapObserver: ScenarioBootstrapTelemetryObserver) {
    this.runtime = runtime;
    this.bootstrapObserver = bootstrapObserver;
    this.driver = new VirtualClockFastForwardDriver(runtime);
    this.initialShaderPrograms = this.driver.getCompiledShaderProgramCount();
  }

  public async runBaselineSuite(queryValue = 'all'): Promise<BaselineSuiteTelemetryReport> {
    const scripts = resolveRequestedScenarios(queryValue);
    const scenarioReports: ScenarioRunReport[] = [];

    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      console.info(
        `[ScenarioBaseline] Starting scenario (${i + 1}/${scripts.length}): ${script.id} (${script.totalTicks} ticks)...`,
      );
      const report = await this.driver.runScenario(script);
      scenarioReports.push(report);
      console.info(
        `[ScenarioBaseline] Completed ${script.id}: passed=${report.passed}, wall=${report.wallClockDurationMs}ms, rate=${report.effectiveTickRateHz}Hz (${report.speedupFactorVsRealtime}x realtime)`,
      );
    }

    const glSummary = this.driver.getWebGlContextAttributesSummary();
    const overallPassed = scenarioReports.every((r) => r.passed);
    const suiteReport: BaselineSuiteTelemetryReport = {
      schemaVersion: '1.0.0',
      generatedAtIso: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'headless',
      webglRenderer: glSummary.renderer,
      webglVendor: glSummary.vendor,
      bootstrap: this.bootstrapObserver.buildSnapshot(this.initialShaderPrograms),
      scenarios: scenarioReports,
      overallPassed,
    };

    if (typeof window !== 'undefined') {
      window.__rcScenarioReport = suiteReport;
    }
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.dataset.rcScenarioStatus = overallPassed ? 'passed' : 'failed';
    }
    console.info(`[ScenarioBaselineReport:JSON] ${JSON.stringify(suiteReport)}`);
    if (typeof fetch === 'function') {
      try {
        await fetch('/__rc_scenario_report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(suiteReport),
        });
      } catch {
        // Ignore when running without CLI report receiver middleware
      }
    }
    return suiteReport;
  }
}

export function attachScenarioAutorunController(
  runtime: ScenarioRuntimePort,
  bootstrapObserver: ScenarioBootstrapTelemetryObserver,
  backgroundAssetsPromise: Promise<unknown>,
): ScenarioAutorunController {
  const controller = new ScenarioAutorunController(runtime, bootstrapObserver);
  if (typeof window !== 'undefined') {
    window.__rcScenarioDriver = controller;
  }

  const autorunQuery = getAutorunScenarioParam();
  if (autorunQuery) {
    const bgStart = performance.now();
    void backgroundAssetsPromise
      .then(() => {
        bootstrapObserver.setBackgroundAssetsDurationMs(performance.now() - bgStart);
      })
      .catch(() => {
        bootstrapObserver.setBackgroundAssetsDurationMs(performance.now() - bgStart);
      })
      .then(() => controller.runBaselineSuite(autorunQuery))
      .catch(async (err) => {
        const msg = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err);
        if (typeof window !== 'undefined') {
          window.__rcScenarioError = msg;
        }
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.dataset.rcScenarioStatus = 'error';
        }
        console.error('[ScenarioBaseline] Fatal error in autorun suite:', err);
        if (typeof fetch === 'function') {
          try {
            await fetch('/__rc_scenario_report', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fatalError: msg }),
            });
          } catch {
            // Ignore
          }
        }
      });
  }

  return controller;
}
