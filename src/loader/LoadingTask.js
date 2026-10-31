/**
 * src/loader/LoadingTask.js
 * Atomic unit of execution within the loading orchestrator pipeline.
 */

import { TaskStatus } from './types.js';

export class LoadingTask {
  /**
   * @param {object} config
   * @param {string} config.id Unique task identifier
   * @param {string} config.name User-facing task name
   * @param {number} [config.stage=1] Lifecycle stage index (1..7)
   * @param {string} [config.stageName] Stage name
   * @param {number} [config.weight=1.0] Relative weight within the stage
   * @param {string[]} [config.dependencies=[]] Task IDs that must complete before this runs
   * @param {boolean} [config.critical=true] Whether failure terminates loading or allows fallback
   * @param {number} [config.timeoutMs] Optional timeout in milliseconds
   * @param {(ctx: TaskExecutionContext) => Promise<any>} config.run Main task execution function
   */
  constructor(config) {
    if (!config || !config.id) {
      throw new Error('[LoadingTask] Task id is required');
    }
    this.id = config.id;
    this.name = config.name || config.id;
    this.stage = config.stage || 1;
    this.stageName = config.stageName || `Stage ${this.stage}`;
    this.type = config.type || 'indeterminate';
    this.category = config.category || '';
    this.hint = config.hint || '';
    this.weight = typeof config.weight === 'number' && config.weight > 0 ? config.weight : 1.0;
    this.dependencies = Array.isArray(config.dependencies) ? [...config.dependencies] : [];
    this.critical = config.critical !== false;
    this.timeoutMs = typeof config.timeoutMs === 'number'
      ? config.timeoutMs
      : (this.type === 'indeterminate' ? 30000 : 60000);
    this.runFn = config.run || (async () => {});

    this.status = TaskStatus.IDLE;
    this.progress = 0.0;
    this.detail = '';
    this.error = null;
    this.durationMs = 0;
    this.result = null;
  }

  /**
   * Executes this task within the provided orchestrator context.
   * @param {object} context
   * @returns {Promise<any>}
   */
  async execute(context) {
    this.status = TaskStatus.RUNNING;
    this.progress = 0.0;
    const startTime = performance.now();

    const taskCtx = {
      ...context,
      taskId: this.id,
      taskName: this.name,
      stage: this.stage,
      reportProgress: (ratio, detail = '') => {
        this.progress = Math.max(0.0, Math.min(1.0, ratio));
        if (detail) this.detail = detail;
        context.reportTaskProgress(this.id, this.progress, this.detail);
      }
    };

    try {
      if (this.timeoutMs > 0) {
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`[LoadingTask] Task "${this.name}" (${this.id}) timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs);
        });

        this.result = await Promise.race([
          this.runFn(taskCtx),
          timeoutPromise
        ]);
        if (timer) clearTimeout(timer);
      } else {
        this.result = await this.runFn(taskCtx);
      }

      this.status = TaskStatus.COMPLETED;
      this.progress = 1.0;
      this.durationMs = performance.now() - startTime;
      return this.result;
    } catch (err) {
      this.durationMs = performance.now() - startTime;
      this.error = err;
      if (!this.critical) {
        this.status = TaskStatus.SKIPPED;
        console.warn(`[LoadingTask] Non-critical task "${this.name}" skipped or degraded:`, err.message || err);
        return null;
      }
      this.status = TaskStatus.FAILED;
      throw err;
    }
  }
}
