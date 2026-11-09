/**
 * src/loader/LoadingOrchestrator.ts
 * Central Task Tracker & Loading Pipeline Orchestrator.
 *
 * Responsibilities:
 * 1. Coordinates asynchronous and synchronous task execution graphs.
 * 2. Bridges "Download First, Parse/Load Later" stages across decoupled modules.
 * 3. Aggregates determinate weighted progress (0..100%, step X/Y) across all stages.
 * 4. Dispatches standardized progress snapshots to observers (Console, UI Progress Bar).
 * 5. Provides shared in-memory data store for passing assets between pipeline stages.
 */

import {
  TaskStatus,
  LOADING_STAGES,
  getStageMeta,
  type LoadingStageChangeEvent,
  type LoadingTaskStartEvent,
  type LoadingTaskProgressEvent,
  type LoadingTaskCompleteEvent,
  type LoadingErrorEvent,
  type LoadingCompleteEvent,
  type LoadingProgressObserver,
  type StreamDownloadProgressInfo,
} from './types.ts';
import {
  LoadingTask,
  type LoadingTaskConfig,
  type LoadingTaskOrchestratorContext,
} from './LoadingTask.ts';
import { StreamDownloadTracker } from './StreamDownloadTracker.ts';

export class LoadingOrchestrator {
  _runtimeExceptionPromise: Promise<never> | null;
  activeTask: LoadingTask | null;
  currentStageIndex: number;
  currentStep: number;
  downloadTracker: StreamDownloadTracker;
  fatalError: Error | null;
  isCompleted: boolean;
  isRunning: boolean;
  observers: Set<LoadingProgressObserver>;
  options: Record<string, unknown>;
  overallRatio: number;
  sharedData: Map<string, unknown>;
  startTime: number;
  taskMap: Map<string, LoadingTask>;
  tasks: LoadingTask[];
  totalSteps: number;

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    this.tasks = [];
    this.taskMap = new Map<string, LoadingTask>();
    this.observers = new Set<LoadingProgressObserver>();
    this.sharedData = new Map<string, unknown>();
    this.downloadTracker = new StreamDownloadTracker((update) =>
      this._handleDownloadProgress(update)
    );

    this.currentStep = 0;
    this.totalSteps = 0;
    this.currentStageIndex = 1;
    this.overallRatio = 0.0;
    this.activeTask = null;
    this.isRunning = false;
    this.isCompleted = false;
    this.fatalError = null;
    this.startTime = 0;
    this._runtimeExceptionPromise = null;
  }

  /**
   * Registers a task into the pipeline.
   * @param {LoadingTask|object} taskConfig
   * @returns {LoadingTask}
   */
  registerTask(taskConfig: LoadingTask | LoadingTaskConfig): LoadingTask {
    const task = taskConfig instanceof LoadingTask ? taskConfig : new LoadingTask(taskConfig);
    if (this.taskMap.has(task.id)) {
      throw new Error(`[LoadingOrchestrator] Duplicate task id: "${task.id}"`);
    }
    this.tasks.push(task);
    this.taskMap.set(task.id, task);
    this.totalSteps = this.tasks.length;
    return task;
  }

  /**
   * Retrieves a task by its unique ID.
   * @param {string} id
   * @returns {LoadingTask|undefined}
   */
  getTask(id: string): LoadingTask | undefined {
    return this.taskMap.get(id);
  }

  /**
   * Subscribes an observer to receive loading lifecycle events.
   * @param {object} observer
   * @returns {() => void} Unsubscribe function
   */
  subscribe(observer: LoadingProgressObserver | null | undefined): () => void {
    if (observer && typeof observer === 'object') {
      this.observers.add(observer);
    }
    return () => {
      if (observer) {
        this.observers.delete(observer);
      }
    };
  }

  /**
   * Shared memory store for pipeline stages.
   * Allows pre-downloaded ArrayBuffers or configs to be shared with downstream initializers.
   */
  getShared<T = unknown>(key: string): T | undefined {
    return this.sharedData.get(key) as T | undefined;
  }

  setShared<T = unknown>(key: string, value: T): T {
    this.sharedData.set(key, value);
    return value;
  }

  hasShared(key: string): boolean {
    return this.sharedData.has(key);
  }

  /**
   * Calculates overall weighted determinate progress in [0.0, 1.0].
   * @returns {number}
   */
  calculateOverallProgress(): number {
    let accumulated = 0.0;
    const stageGroups = this._groupTasksByStage();

    for (const stageMeta of LOADING_STAGES) {
      const stageTasks = stageGroups.get(stageMeta.index) || [];
      if (stageTasks.length === 0) continue;

      const totalStageTaskWeight = stageTasks.reduce((acc, t) => acc + t.weight, 0);
      let stageCompletedWeight = 0;

      for (const task of stageTasks) {
        if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.SKIPPED) {
          stageCompletedWeight += task.weight;
        } else if (task.status === TaskStatus.RUNNING) {
          stageCompletedWeight += task.weight * task.progress;
        }
      }

      const stageRatio = totalStageTaskWeight > 0 ? stageCompletedWeight / totalStageTaskWeight : 0;
      accumulated += stageMeta.weight * stageRatio;
    }

    this.overallRatio = Math.max(0.0, Math.min(1.0, accumulated));
    return this.overallRatio;
  }

  /**
   * Executes the complete loading pipeline stage by stage.
   * @returns {Promise<LoadingOrchestrator>}
   */
  async run(): Promise<LoadingOrchestrator> {
    if (this.isRunning) {
      throw new Error('[LoadingOrchestrator] Pipeline is already running.');
    }
    this.isRunning = true;
    this.fatalError = null;
    this.startTime = performance.now();
    this.totalSteps = this.tasks.length;
    this.currentStep = 0;

    let rejectRuntimeException: ((reason?: unknown) => void) | null = null;
    this._runtimeExceptionPromise = new Promise<never>((_, reject) => {
      rejectRuntimeException = reject;
    });
    this._runtimeExceptionPromise.catch(() => {});

    const triggerFatalException = (rawErr: unknown, fallbackMessage: string) => {
      if (!this.isRunning || this.isCompleted || this.fatalError) return;
      const err =
        rawErr instanceof Error
          ? rawErr
          : new Error(typeof rawErr === 'string' && rawErr.length > 0 ? rawErr : fallbackMessage);
      this.fatalError = err;
      if (rejectRuntimeException) {
        rejectRuntimeException(err);
      }
    };

    const onWindowError = (event: ErrorEvent | Event) => {
      if (!event) return;
      if (
        event.target &&
        typeof window !== 'undefined' &&
        event.target !== window &&
        !(event instanceof ErrorEvent)
      ) {
        return;
      }
      const errEvent = event instanceof ErrorEvent ? event : null;
      const err =
        errEvent?.error instanceof Error
          ? errEvent.error
          : new Error(errEvent?.message || 'Uncaught runtime exception during bootstrap');
      if (!err.stack && errEvent?.filename) {
        err.stack = `${err.message}\n    at ${errEvent.filename}:${errEvent.lineno || 0}:${errEvent.colno || 0}`;
      }
      triggerFatalException(err, 'Uncaught runtime exception during bootstrap');
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (!event) return;
      const reason: unknown = event.reason;
      const err =
        reason instanceof Error
          ? reason
          : new Error(
              typeof reason === 'string' ? reason : 'Unhandled promise rejection during bootstrap'
            );
      triggerFatalException(err, 'Unhandled promise rejection during bootstrap');
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('error', onWindowError);
      window.addEventListener('unhandledrejection', onUnhandledRejection);
    }

    const stageGroups = this._groupTasksByStage();
    const sortedStages = Array.from(stageGroups.keys()).sort((a, b) => a - b);

    try {
      for (const stageIndex of sortedStages) {
        this.currentStageIndex = stageIndex;
        const stageMeta = getStageMeta(stageIndex);
        const stageTasks = stageGroups.get(stageIndex) || [];

        this._emitStageChange({
          stageIndex,
          totalStages: LOADING_STAGES.length,
          stageTitle: stageMeta.title,
          stageDescription: stageMeta.description,
        });

        await this._executeStageTasks(stageTasks);
      }

      this.isCompleted = true;
      this.isRunning = false;
      this.overallRatio = 1.0;
      const totalDurationMs = performance.now() - this.startTime;

      this._emitComplete({
        totalDurationMs,
        totalSteps: this.totalSteps,
      });

      return this;
    } catch (err) {
      this.isRunning = false;
      throw err;
    } finally {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('error', onWindowError);
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
      }
    }
  }

  /**
   * Internal execution of all tasks within a single stage.
   * Resolves internal dependency chains, executing independent tasks concurrently.
   * @param {LoadingTask[]} tasks
   */
  async _executeStageTasks(tasks: LoadingTask[]): Promise<void> {
    const pending = new Set<LoadingTask>(tasks);
    const completedInStage = new Set<string>();

    while (pending.size > 0) {
      if (this.fatalError) {
        throw this.fatalError;
      }

      // Find tasks whose dependencies are satisfied
      const readyTasks = Array.from(pending).filter((task) => {
        return task.dependencies.every((depId) => {
          const depTask = this.taskMap.get(depId);
          return (
            depTask &&
            (depTask.status === TaskStatus.COMPLETED || depTask.status === TaskStatus.SKIPPED)
          );
        });
      });

      if (readyTasks.length === 0) {
        // Dependency cycle or unfulfilled external dependency
        const unresolved = Array.from(pending).map(
          (t) => `${t.id} -> [${t.dependencies.join(', ')}]`
        );
        throw new Error(
          `[LoadingOrchestrator] Unresolved task dependencies in Stage ${this.currentStageIndex}: ${unresolved.join('; ')}`
        );
      }

      // Execute ready tasks in parallel
      await Promise.all(
        readyTasks.map(async (task) => {
          pending.delete(task);
          this.currentStep++;
          this.activeTask = task;

          const stepInfo: LoadingTaskStartEvent = {
            taskId: task.id,
            taskName: task.name,
            step: this.currentStep,
            totalSteps: this.totalSteps,
            stageIndex: this.currentStageIndex,
            totalStages: LOADING_STAGES.length,
            overallPercent: this.calculateOverallProgress() * 100,
            taskType: task.type,
            category: task.category,
            hint: task.hint,
          };

          this._emitTaskStart(stepInfo);

          const context: LoadingTaskOrchestratorContext = {
            downloadTracker: this.downloadTracker,
            getShared: <T = unknown>(key: string) => this.getShared<T>(key),
            setShared: <T = unknown>(key: string, val: T) => this.setShared<T>(key, val),
            hasShared: (key: string) => this.hasShared(key),
            reportTaskProgress: (taskId: string, progress: number, detail: string) => {
              this._handleTaskProgress(taskId, progress, detail);
            },
          };

          try {
            if (this._runtimeExceptionPromise) {
              await Promise.race([task.execute(context), this._runtimeExceptionPromise]);
            } else {
              await task.execute(context);
            }
            completedInStage.add(task.id);

            const completeInfo: LoadingTaskCompleteEvent = {
              ...stepInfo,
              overallPercent: this.calculateOverallProgress() * 100,
              durationMs: task.durationMs,
              status: task.status,
            };
            this._emitTaskComplete(completeInfo);
          } catch (err) {
            task.status = TaskStatus.FAILED;
            task.error = err;
            const isCriticalFailure = Boolean(task.critical || this.fatalError);
            this._emitError({
              taskId: task.id,
              taskName: task.name,
              error: err,
              isCritical: isCriticalFailure,
            });
            if (isCriticalFailure) {
              throw err;
            }
          }
        })
      );
    }
  }

  _groupTasksByStage(): Map<number, LoadingTask[]> {
    const map = new Map<number, LoadingTask[]>();
    for (const task of this.tasks) {
      let group = map.get(task.stage);
      if (!group) {
        group = [];
        map.set(task.stage, group);
      }
      group.push(task);
    }
    return map;
  }

  _handleTaskProgress(taskId: string, taskProgress: number, detail: string): void {
    const task = this.taskMap.get(taskId);
    if (!task) return;

    const overallPercent = this.calculateOverallProgress() * 100;

    const progressEvent: LoadingTaskProgressEvent = {
      taskId: task.id,
      taskName: task.name,
      step: this.currentStep,
      totalSteps: this.totalSteps,
      stageIndex: this.currentStageIndex,
      totalStages: LOADING_STAGES.length,
      taskProgress,
      detail,
      overallPercent,
      bytes: {
        loadedBytes: this.downloadTracker.loadedBytes,
        totalBytes: this.downloadTracker.totalBytes,
      },
    };

    for (const obs of this.observers) {
      if (typeof obs.onTaskProgress === 'function') {
        obs.onTaskProgress(progressEvent);
      }
      if (typeof obs.onOverallProgress === 'function') {
        obs.onOverallProgress({
          overallRatio: this.overallRatio,
          currentStep: this.currentStep,
          totalSteps: this.totalSteps,
          activeTaskName: task.name,
          stageTitle: getStageMeta(this.currentStageIndex).title,
        });
      }
    }
  }

  _handleDownloadProgress(streamUpdate: StreamDownloadProgressInfo): void {
    for (const obs of this.observers) {
      if (typeof obs.onByteStreamProgress === 'function') {
        obs.onByteStreamProgress(streamUpdate);
      }
    }
  }

  _emitStageChange(data: LoadingStageChangeEvent): void {
    for (const obs of this.observers) {
      if (typeof obs.onStageChange === 'function') {
        obs.onStageChange(data);
      }
    }
  }

  _emitTaskStart(data: LoadingTaskStartEvent): void {
    for (const obs of this.observers) {
      if (typeof obs.onTaskStart === 'function') {
        obs.onTaskStart(data);
      }
    }
  }

  _emitTaskComplete(data: LoadingTaskCompleteEvent): void {
    for (const obs of this.observers) {
      if (typeof obs.onTaskComplete === 'function') {
        obs.onTaskComplete(data);
      }
    }
  }

  _emitError(data: LoadingErrorEvent): void {
    for (const obs of this.observers) {
      if (typeof obs.onError === 'function') {
        obs.onError(data);
      }
    }
  }

  _emitComplete(data: LoadingCompleteEvent): void {
    for (const obs of this.observers) {
      if (typeof obs.onComplete === 'function') {
        obs.onComplete(data);
      }
    }
  }
}
