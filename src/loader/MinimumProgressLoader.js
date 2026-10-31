/**
 * src/loader/MinimumProgressLoader.js
 * Ultra-lightweight, zero-dependency, Apple HIG-compliant Dual Progress Bar Loader.
 */
import { MINIMUM_LOADER_HTML, MINIMUM_LOADER_CSS } from './minimumLoaderTemplate.js';
import { resolveAssetPath } from '../utils/AssetResponseValidator.js';

export class MinimumProgressLoader {
  /**
   * @param {HTMLElement} [container] Host DOM container (defaults to #app)
   * @param {object} [options]
   */
  constructor(container = null, options = {}) {
    this.container = container || (typeof document !== 'undefined' ? document.querySelector('#app') : null);
    this.options = options;
    this.element = null;
    this.isMounted = false;
    this.isCompleted = false;
    this.hasError = false;

    // State tracking
    this.stageIndex = 1;
    this.totalStages = 6;
    this.stageTitle = 'System Preflight';
    this.currentStep = 0;
    this.totalSteps = 10;
    this.overallPercent = 0;
    this.activeTaskId = 'bootstrap';
    this.activeTaskName = 'Initializing Engine Runtime...';
    this.activeTaskType = 'indeterminate';
    this.activeTaskCategory = 'Bootstrap Core';
    this.activeTaskHint = 'Verifying browser environment and hardware capabilities...';

    // Stream telemetry
    this.loadedBytes = 0;
    this.totalBytes = 0;
    this.speedBps = 0;
    this.lastByteTime = 0;
    this.lastByteCount = 0;

    // Cache DOM references
    this.refs = {};

    this._initFontAsync();
  }

  /**
   * Non-blocking progressive font enhancement.
   * Leverages SF Mono natively on Apple devices; async-loads JetBrains Mono on others.
   */
  _initFontAsync() {
    if (typeof document === 'undefined' || !('fonts' in document)) return;
    try {
      const fontUrl = resolveAssetPath('/assets/fonts/jetbrains-mono-400.woff2');
      const font = new FontFace(
        'JetBrains Mono',
        `url('${fontUrl}') format('woff2')`,
        { style: 'normal', weight: '400', display: 'swap' }
      );
      font.load().then((loaded) => {
        document.fonts.add(loaded);
      }).catch((err) => {
        console.warn('[MinimumProgressLoader] Failed to load JetBrains Mono font, fallback to system monospace:', err);
      });
    } catch (err) {
      console.warn('[MinimumProgressLoader] FontFace API error or unsupported browser:', err);
    }
  }

  /**
   * Mounts the minimal dual progress loader into the DOM container.
   */
  mount() {
    if (this.isMounted || typeof document === 'undefined' || !this.container) return;

    this._injectStyles();

    let loaderEl = this.container.querySelector('#minimum-engine-loader');
    if (!loaderEl) {
      loaderEl = document.createElement('div');
      loaderEl.id = 'minimum-engine-loader';
      loaderEl.className = 'hig-loader-shell';
      loaderEl.setAttribute('data-ui-layer', 'minimum-loading-screen');
      loaderEl.innerHTML = MINIMUM_LOADER_HTML;
      this.container.appendChild(loaderEl);
    }

    this.element = loaderEl;
    this.isMounted = true;
    this.container.__minimumProgressLoader = this;

    this.refs = {
      stageIndicator: loaderEl.querySelector('#hig-stage-indicator'),
      stageTitle: loaderEl.querySelector('#hig-stage-title'),
      overallPercent: loaderEl.querySelector('#hig-overall-percent'),
      primaryFill: loaderEl.querySelector('#hig-primary-fill'),
      taskName: loaderEl.querySelector('#hig-task-name'),
      taskStatusBadge: loaderEl.querySelector('#hig-task-status-badge'),
      secondaryTrack: loaderEl.querySelector('#hig-secondary-track'),
      secondaryFill: loaderEl.querySelector('#hig-secondary-fill'),
      microDetail: loaderEl.querySelector('#hig-micro-detail'),
      microRate: loaderEl.querySelector('#hig-micro-rate'),
      errorCard: loaderEl.querySelector('#hig-error-card'),
      errorCode: loaderEl.querySelector('#hig-error-code'),
      errorTitle: loaderEl.querySelector('#hig-error-title'),
      errorMessage: loaderEl.querySelector('#hig-error-message'),
      errorHint: loaderEl.querySelector('#hig-error-hint'),
      errorTech: loaderEl.querySelector('#hig-error-tech'),
      errorReloadBtn: loaderEl.querySelector('#hig-error-reload-btn'),
      telemetryDot: loaderEl.querySelector('#hig-telemetry-dot'),
      telemetryLabel: loaderEl.querySelector('#hig-telemetry-label')
    };

    if (this.refs.errorReloadBtn && typeof window !== 'undefined') {
      this.refs.errorReloadBtn.onclick = () => {
        window.location.reload();
      };
    }
  }

  /**
   * Injects inline CSS styles.
   */
  _injectStyles() {
    if (document.getElementById('hig-minimum-loader-styles')) return;

    const style = document.createElement('style');
    style.id = 'hig-minimum-loader-styles';
    style.textContent = MINIMUM_LOADER_CSS;
    document.head.appendChild(style);
  }

  /**
   * Helper: formats bytes into human-readable string.
   */
  _formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /**
   * Lifecycle callback: Stage transition.
   */
  onStageChange({ stageIndex, totalStages, stageTitle, stageDescription }) {
    if (this.hasError || this.isCompleted) return;
    this.stageIndex = stageIndex || this.stageIndex;
    this.totalStages = totalStages || this.totalStages;
    this.stageTitle = stageTitle || this.stageTitle;

    if (!this.refs.stageIndicator) return;
    this.refs.stageIndicator.textContent = `STAGE ${this.stageIndex} OF ${this.totalStages}`;
    this.refs.stageTitle.textContent = this.stageTitle;
    if (stageDescription && this.refs.microDetail) {
      this.refs.microDetail.textContent = stageDescription;
    }
  }

  /**
   * Lifecycle callback: Task start.
   */
  onTaskStart({ taskId, taskName, step, totalSteps, stageIndex, totalStages, overallPercent, taskType, hint, category }) {
    if (this.hasError || this.isCompleted) return;
    this.currentStep = step || this.currentStep;
    this.totalSteps = totalSteps || this.totalSteps;
    this.activeTaskId = taskId || this.activeTaskId;
    this.activeTaskName = taskName || this.activeTaskName;
    this.activeTaskType = taskType || 'indeterminate';
    this.activeTaskCategory = category || this.activeTaskCategory;

    if (overallPercent !== undefined) {
      this.overallPercent = overallPercent;
    }

    if (!this.refs.taskName) return;
    this.refs.taskName.textContent = this.activeTaskName;

    if (this.activeTaskType === 'determinate') {
      this.refs.taskStatusBadge.textContent = 'STREAMING';
      this.refs.taskStatusBadge.className = 'hig-task-status-badge determinate';
      this.refs.secondaryFill.className = 'hig-fill hig-fill-secondary';
      this.refs.secondaryFill.style.width = '0%';
    } else {
      const mode = taskName.includes('Compil') ? 'COMPILING' :
                   taskName.includes('Verify') || taskName.includes('Audit') ? 'VERIFYING' :
                   taskName.includes('Init') || taskName.includes('Ignite') ? 'INITIALIZING' : 'PROCESSING';
      this.refs.taskStatusBadge.textContent = mode;
      this.refs.taskStatusBadge.className = 'hig-task-status-badge';
      this.refs.secondaryFill.className = 'hig-fill hig-fill-secondary hig-shimmer';
      this.refs.secondaryFill.style.width = '100%';
    }

    if (hint) {
      this.refs.microDetail.textContent = hint;
    }
    this.refs.microRate.textContent = '';
  }

  /**
   * Lifecycle callback: Task progress update.
   */
  onTaskProgress({ overallPercent, taskProgress, detail, bytes }) {
    if (this.hasError || this.isCompleted) return;
    if (overallPercent !== undefined) {
      this.overallPercent = overallPercent;
      if (this.refs.overallPercent) {
        this.refs.overallPercent.textContent = `${Math.round(overallPercent)}%`;
      }
      if (this.refs.primaryFill) {
        this.refs.primaryFill.style.width = `${Math.min(100, Math.max(0, overallPercent)).toFixed(1)}%`;
      }
    }

    if (detail && this.refs.microDetail) {
      this.refs.microDetail.textContent = detail;
    }

    if (this.activeTaskType === 'determinate' && taskProgress !== undefined && this.refs.secondaryFill) {
      this.refs.secondaryFill.style.width = `${Math.min(100, Math.max(0, taskProgress * 100)).toFixed(1)}%`;
    }
  }

  /**
   * Lifecycle callback: High-precision byte stream updates.
   */
  onByteStreamProgress({ overallRatio, loadedBytes, totalBytes, activeUrl }) {
    if (this.hasError || this.isCompleted) return;
    this.loadedBytes = loadedBytes || 0;
    this.totalBytes = totalBytes || 0;

    const now = performance.now();
    if (this.lastByteTime > 0 && now > this.lastByteTime) {
      const deltaBytes = loadedBytes - this.lastByteCount;
      const deltaSec = (now - this.lastByteTime) / 1000;
      if (deltaSec > 0.2) {
        this.speedBps = Math.max(0, deltaBytes / deltaSec);
        this.lastByteTime = now;
        this.lastByteCount = loadedBytes;
      }
    } else {
      this.lastByteTime = now;
      this.lastByteCount = loadedBytes;
    }

    if (this.refs.secondaryFill && this.activeTaskType === 'determinate') {
      this.refs.secondaryFill.style.width = `${Math.min(100, Math.max(0, overallRatio * 100)).toFixed(1)}%`;
    }

    if (this.refs.microDetail) {
      const filename = activeUrl ? activeUrl.split('/').pop() : '';
      const loadedStr = this._formatBytes(this.loadedBytes);
      const totalStr = this.totalBytes > 0 ? this._formatBytes(this.totalBytes) : 'Stream';
      this.refs.microDetail.textContent = filename ? `Streaming ${filename} (${loadedStr} / ${totalStr})` : `Streamed ${loadedStr} / ${totalStr}`;
    }

    if (this.refs.microRate && this.speedBps > 0) {
      this.refs.microRate.textContent = `${this._formatBytes(this.speedBps)}/s`;
    }
  }

  /**
   * Lifecycle callback: Failure presentation.
   */
  onError({ taskId, taskName, error, isCritical }) {
    this.hasError = true;
    if (!this.refs.errorCard) return;

    const resolvedTaskId = (taskId && taskId !== 'bootstrap')
      ? taskId
      : (this.activeTaskId || taskId || 'bootstrap');
    const resolvedTaskName = (taskName && taskName !== 'Engine Bootstrap' && taskName !== 'Engine Lifecycle Bootstrap')
      ? taskName
      : (this.activeTaskName || taskName || 'Engine Bootstrap');

    this.refs.errorCard.style.display = 'flex';
    if (this.refs.primaryFill) {
      this.refs.primaryFill.style.background = '#ef4444';
      this.refs.primaryFill.style.boxShadow = '0 0 16px rgba(239, 68, 68, 0.6)';
    }
    if (this.refs.overallPercent) {
      this.refs.overallPercent.style.color = '#f87171';
    }
    if (this.refs.secondaryFill) {
      this.refs.secondaryFill.className = 'hig-fill hig-fill-secondary';
      this.refs.secondaryFill.style.width = '100%';
      this.refs.secondaryFill.style.background = '#ef4444';
    }

    const errCode = error?.isMicrokernelError ? 'ERR_POV_MICROKERNEL_TAMPERED' :
                    error?.isAssetError ? 'ERR_REQUIRED_ASSET_MISSING' : 'ERR_BOOTSTRAP_FAILURE';

    this.refs.errorCode.textContent = errCode;
    this.refs.errorTitle.textContent = error?.isMicrokernelError
      ? 'Critical Security Preflight Failure'
      : error?.isAssetError
      ? 'Required Static Asset Missing'
      : 'Engine Bootstrap Exception — Please Refresh Page';
    this.refs.errorMessage.textContent = error instanceof Error ? error.message : String(error);

    const contextHeader = `Stage: ${this.stageIndex}/${this.totalStages} (${this.stageTitle})\nTask: ${resolvedTaskName} (${resolvedTaskId})`;
    const stackBody = error?.stack || `Timestamp: ${new Date().toISOString()}`;
    this.refs.errorTech.textContent = `${contextHeader}\n\n${stackBody}`;

    if (this.refs.taskStatusBadge) {
      this.refs.taskStatusBadge.textContent = 'FAILED';
      this.refs.taskStatusBadge.className = 'hig-task-status-badge error';
    }
    if (this.refs.microDetail) {
      this.refs.microDetail.textContent = 'Bootstrap halted due to an exception. Please refresh the page or open a new tab.';
      this.refs.microDetail.style.color = '#fca5a5';
    }
    if (this.refs.microRate) {
      this.refs.microRate.textContent = '';
    }
    if (this.refs.telemetryDot) {
      this.refs.telemetryDot.style.background = '#ef4444';
      this.refs.telemetryDot.style.boxShadow = '0 0 8px #ef4444';
    }
    if (this.refs.telemetryLabel) {
      this.refs.telemetryLabel.textContent = 'Bootstrap Halted • Refresh Page or Open New Tab to Recover';
      this.refs.telemetryLabel.style.color = '#fca5a5';
    }
  }

  /**
   * Lifecycle callback: Graceful exit & unmount.
   */
  onComplete({ totalDurationMs } = {}) {
    if (this.hasError) return;
    this.isCompleted = true;

    if (this.refs.overallPercent) this.refs.overallPercent.textContent = '100%';
    if (this.refs.primaryFill) this.refs.primaryFill.style.width = '100%';
    if (this.refs.secondaryFill) this.refs.secondaryFill.style.width = '100%';
    if (this.refs.taskName) this.refs.taskName.textContent = 'Engine Ignition Online — 120Hz Active';
    if (this.refs.taskStatusBadge) this.refs.taskStatusBadge.textContent = 'READY';

    if (this.element) {
      setTimeout(() => {
        if (!this.element || this.hasError) return;
        this.element.style.opacity = '0';
        this.element.style.pointerEvents = 'none';
        setTimeout(() => {
          if (!this.hasError) {
            this.destroy();
          }
        }, 360);
      }, 200);
    }
  }

  /**
   * Destroys loader DOM and cleans up all listeners.
   */
  destroy() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    if (this.container && this.container.__minimumProgressLoader === this) {
      delete this.container.__minimumProgressLoader;
    }
    this.element = null;
    this.refs = {};
    this.isMounted = false;
  }
}
