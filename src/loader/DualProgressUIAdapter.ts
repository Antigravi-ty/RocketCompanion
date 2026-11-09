/**
 * src/loader/DualProgressUIAdapter.ts
 * Bridges LoadingOrchestrator events to the MinimumProgressLoader and custom UI hooks.
 *
 * Implements Apple Human Interface Guidelines (HIG) Determinate & Indeterminate Progress:
 * 1. Stage Progress (Top indicator): Overall system lifecycle milestones (0% -> 100%).
 * 2. Active Micro-Task (Bottom indicator):
 *    - Determinate: Real-time network bytes, stream chunks, bandwidth metrics.
 *    - Indeterminate: Shimmer wave animations with explicit technical diagnostic hints.
 * 3. Pluggable UI: Supports external custom UI hooks via registerCustomUI().
 */

import { MinimumProgressLoader, type MinimumLoaderDomContainer } from './MinimumProgressLoader.ts';
import type {
  LoadingStageChangeEvent,
  LoadingTaskStartEvent,
  LoadingTaskProgressEvent,
  StreamDownloadProgressInfo,
  LoadingTaskCompleteEvent,
  LoadingErrorEvent,
  LoadingCompleteEvent,
  LoadingProgressObserver,
} from './types.ts';

export interface CustomLoadingProgressUI {
  onStageChange?: (data: LoadingStageChangeEvent) => void;
  onTaskStart?: (data: LoadingTaskStartEvent) => void;
  onProgress?: (data: LoadingTaskProgressEvent) => void;
  onByteStream?: (data: StreamDownloadProgressInfo) => void;
  onTaskComplete?: (data: LoadingTaskCompleteEvent) => void;
  onError?: (data: LoadingErrorEvent) => void;
  onComplete?: (data: LoadingCompleteEvent) => void;
}

export class DualProgressUIAdapter implements LoadingProgressObserver {
  container: MinimumLoaderDomContainer | null;
  customUI: CustomLoadingProgressUI | null;
  loader: MinimumProgressLoader;

  /**
   * @param {HTMLElement} [container] Host DOM container (#app)
   * @param {MinimumProgressLoader} [existingLoader] Pre-mounted loader instance
   */
  constructor(
    container: Element | null = null,
    existingLoader: MinimumProgressLoader | null = null
  ) {
    this.container = (container ||
      (typeof document !== 'undefined'
        ? document.querySelector('#app')
        : null)) as MinimumLoaderDomContainer | null;
    this.customUI = null;
    this.loader =
      existingLoader ||
      this.container?.__minimumProgressLoader ||
      new MinimumProgressLoader(this.container);
    this.loader.mount();
  }

  /**
   * Allows external custom UI modules to register and receive structured progress events.
   * @param {object} customUI Custom UI progress bar component
   */
  registerCustomUI(customUI: CustomLoadingProgressUI | null): void {
    this.customUI = customUI;
  }

  onStageChange(data: LoadingStageChangeEvent): void {
    if (this.customUI?.onStageChange) {
      this.customUI.onStageChange(data);
    }
    this.loader?.onStageChange(data);
  }

  onTaskStart(data: LoadingTaskStartEvent): void {
    if (this.customUI?.onTaskStart) {
      this.customUI.onTaskStart(data);
    }
    this.loader?.onTaskStart(data);
  }

  onTaskProgress(data: LoadingTaskProgressEvent): void {
    if (this.customUI?.onProgress) {
      this.customUI.onProgress(data);
    }
    this.loader?.onTaskProgress(data);
  }

  onByteStreamProgress(data: StreamDownloadProgressInfo): void {
    if (this.customUI?.onByteStream) {
      this.customUI.onByteStream(data);
    }
    this.loader?.onByteStreamProgress(data);
  }

  onTaskComplete(data: LoadingTaskCompleteEvent): void {
    if (this.customUI?.onTaskComplete) {
      this.customUI.onTaskComplete(data);
    }
  }

  onError(data: LoadingErrorEvent): void {
    if (this.customUI?.onError) {
      this.customUI.onError(data);
    }
    this.loader?.onError(data);
  }

  onComplete(data: LoadingCompleteEvent): void {
    if (this.customUI?.onComplete) {
      this.customUI.onComplete(data);
    }
    this.loader?.onComplete(data);
  }
}
