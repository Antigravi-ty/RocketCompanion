/**
 * src/loader/DualProgressUIAdapter.js
 * Bridges LoadingOrchestrator events to the MinimumProgressLoader and custom UI hooks.
 *
 * Implements Apple Human Interface Guidelines (HIG) Determinate & Indeterminate Progress:
 * 1. Stage Progress (Top indicator): Overall system lifecycle milestones (0% -> 100%).
 * 2. Active Micro-Task (Bottom indicator):
 *    - Determinate: Real-time network bytes, stream chunks, bandwidth metrics.
 *    - Indeterminate: Shimmer wave animations with explicit technical diagnostic hints.
 * 3. Pluggable UI: Supports external custom UI hooks via registerCustomUI().
 */

import { MinimumProgressLoader } from './MinimumProgressLoader.js';

export class DualProgressUIAdapter {
  /**
   * @param {HTMLElement} [container] Host DOM container (#app)
   * @param {MinimumProgressLoader} [existingLoader] Pre-mounted loader instance
   */
  constructor(container = null, existingLoader = null) {
    this.container = container || (typeof document !== 'undefined' ? document.querySelector('#app') : null);
    this.customUI = null;
    this.loader = existingLoader || this.container?.__minimumProgressLoader || new MinimumProgressLoader(this.container);
    this.loader.mount();
  }

  /**
   * Allows external custom UI modules to register and receive structured progress events.
   * @param {object} customUI Custom UI progress bar component
   */
  registerCustomUI(customUI) {
    this.customUI = customUI;
  }

  onStageChange(data) {
    if (this.customUI?.onStageChange) {
      this.customUI.onStageChange(data);
    }
    this.loader?.onStageChange(data);
  }

  onTaskStart(data) {
    if (this.customUI?.onTaskStart) {
      this.customUI.onTaskStart(data);
    }
    this.loader?.onTaskStart(data);
  }

  onTaskProgress(data) {
    if (this.customUI?.onProgress) {
      this.customUI.onProgress(data);
    }
    this.loader?.onTaskProgress(data);
  }

  onByteStreamProgress(data) {
    if (this.customUI?.onByteStream) {
      this.customUI.onByteStream(data);
    }
    this.loader?.onByteStreamProgress(data);
  }

  onTaskComplete(data) {
    if (this.customUI?.onTaskComplete) {
      this.customUI.onTaskComplete(data);
    }
  }

  onError(data) {
    if (this.customUI?.onError) {
      this.customUI.onError(data);
    }
    this.loader?.onError(data);
  }

  onComplete(data) {
    if (this.customUI?.onComplete) {
      this.customUI.onComplete(data);
    }
    this.loader?.onComplete(data);


  }
}
