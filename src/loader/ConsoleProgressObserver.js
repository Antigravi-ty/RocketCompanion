export function isVerboseLogEnabled() {
  if (typeof window === 'undefined' || !window.location?.search) return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const val = (params.get('log') || '').trim().toLowerCase();
    return val === 'verbose' || val === 'verbos' || val === '1' || val === 'true';
  } catch {
    return false;
  }
}

export class ConsoleProgressObserver {
  constructor(options = {}) {
    this.prefix = options.prefix || '[Loading]';
    this.verbose = options.verbose ?? isVerboseLogEnabled();
    this.minIntervalMs = options.minIntervalMs ?? 120;
    this.lastLogTime = 0;
    this.lastLoggedPercent = -1;
  }

  onStageChange({ stageIndex, totalStages, stageTitle, stageDescription }) {
    if (!this.verbose) return;
    console.log(
      `${this.prefix} ══════════════ [Stage ${stageIndex}/${totalStages}] ${stageTitle} ══════════════\n` +
      `${this.prefix} ${stageDescription}`
    );
  }

  onTaskStart({ taskId, taskName, step, totalSteps, stageIndex, totalStages, overallPercent }) {
    if (!this.verbose) return;
    console.log(
      `${this.prefix}[Stage ${stageIndex}/${totalStages}][Step ${step}/${totalSteps}][${overallPercent.toFixed(1)}%] > Started: ${taskName}`
    );
  }

  onTaskProgress({ taskId, taskName, step, totalSteps, stageIndex, totalStages, overallPercent, taskProgress, detail, bytes }) {
    if (!this.verbose) return;
    const now = performance.now();
    const currentPct = Math.floor(overallPercent);

    if (now - this.lastLogTime < this.minIntervalMs && currentPct === this.lastLoggedPercent) {
      return;
    }
    this.lastLogTime = now;
    this.lastLoggedPercent = currentPct;

    let extra = '';
    if (bytes && bytes.totalBytes > 0) {
      const loadedMB = (bytes.loadedBytes / (1024 * 1024)).toFixed(2);
      const totalMB = (bytes.totalBytes / (1024 * 1024)).toFixed(2);
      extra = ` (${loadedMB} MB / ${totalMB} MB)`;
    } else if (detail) {
      extra = ` (${detail})`;
    }

    console.log(
      `${this.prefix}[Stage ${stageIndex}/${totalStages}][Step ${step}/${totalSteps}][${overallPercent.toFixed(1)}%]   -> ${taskName}: ${(taskProgress * 100).toFixed(0)}%${extra}`
    );
  }

  onTaskComplete({ taskId, taskName, step, totalSteps, stageIndex, totalStages, overallPercent, durationMs, status }) {
    if (!this.verbose) return;
    const dur = durationMs ? `${durationMs.toFixed(0)}ms` : '';
    const statusMark = status === 'skipped' ? '[WARN] Skipped' : '[OK] Done';
    console.log(
      `${this.prefix}[Stage ${stageIndex}/${totalStages}][Step ${step}/${totalSteps}][${overallPercent.toFixed(1)}%] ${statusMark}: ${taskName} ${dur ? `(${dur})` : ''}`
    );
  }

  onError({ taskId, taskName, error, isCritical }) {
    if (isCritical) {
      console.error(
        `${this.prefix} [FATAL] Error in "${taskName}" (${taskId}):`,
        error
      );
    } else {
      console.warn(
        `${this.prefix} [WARN] Non-fatal issue in "${taskName}" (${taskId}), continuing with fallback:`,
        error?.message || error
      );
    }
  }

  onComplete({ totalDurationMs, totalSteps }) {
    if (!this.verbose) return;
    console.log(
      `${this.prefix} All ${totalSteps} loading steps complete in ${(totalDurationMs / 1000).toFixed(2)}s. Launching game!`
    );
  }
}
