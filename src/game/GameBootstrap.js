import * as THREE from 'three';
import { applyThreeMonkeyPatches } from '../utils/ThreeMonkeyPatches.js';
import { DualProgressUIAdapter } from '../loader/DualProgressUIAdapter.js';
import {
  ConsoleProgressObserver,
  isVerboseLogEnabled
} from '../loader/ConsoleProgressObserver.js';
import {
  buildEngineLoadingPipeline,
  startBackgroundAssetPipeline
} from '../loader/engineLoadingPipeline.js';
import { GameRuntime } from './GameRuntime.js';

let activeGameRuntime = null;
let activeBootstrapPromise = null;

export function setupInputMethodDetection(container) {
  if (!container) return () => {};

  const setMethod = (method) => {
    if (container.dataset && container.dataset.inputMethod !== method) {
      container.dataset.inputMethod = method;
    }
  };

  const hasTouch =
    (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0) ||
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(any-pointer: coarse)').matches);

  setMethod(hasTouch ? 'touch' : 'mouse');

  if (typeof window === 'undefined') return () => {};

  const onKeyDown = (e) => {
    if (!e.repeat) setMethod('keyboard');
  };

  const onPointerDown = (e) => {
    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    setMethod(isTouch ? 'touch' : 'mouse');
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  };
}

export class GameBootstrap {
  constructor(container, options = {}) {
    this.container = container || (typeof document !== 'undefined' ? document.querySelector('#app') : null);
    this.options = options;
    this.cleanupInput = null;
    this.runtime = null;
    this.customProgressBar = options.customProgressBar || null;
  }

  registerCustomProgressBar(customUI) {
    this.customProgressBar = customUI;
  }

  prepareDOM() {
    if (this.container) {
      this.cleanupInput = setupInputMethodDetection(this.container);
    }
  }

  async start() {
    applyThreeMonkeyPatches(THREE);
    this.prepareDOM();

    const uiAdapter = new DualProgressUIAdapter(this.container, this.options.loader || null);
    if (this.customProgressBar) {
      uiAdapter.registerCustomUI(this.customProgressBar);
    }

    const verbose = isVerboseLogEnabled();
    const consoleObserver = new ConsoleProgressObserver({ verbose });
    const isTouchHeadless =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('touch') === '2';

    if (isTouchHeadless) {
      console.warn(
        '%c[Bootstrap] Headless Parameter Detected (?touch=2)%c WebGL / Three.js 3D scene rendering is exempted. Running React-only UI + 120Hz Physics Headless Mode.',
        'background:#d97706;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
        'color:#fbbf24;font-weight:bold'
      );
    }

    try {
      this.runtime = new GameRuntime(this.container, this.options);
      const orchestrator = buildEngineLoadingPipeline(this.runtime, this.options);

      orchestrator.subscribe(consoleObserver);
      orchestrator.subscribe(uiAdapter);

      await orchestrator.run();

      if (isTouchHeadless) {
        console.info(
          '[Bootstrap] Headless Parameter Detected (?touch=2): Engine bootstrap & 120Hz clock ignition completed without WebGL.'
        );
        import('../ui-core/stores/quickNotificationStore')
          .then(({ useQuickNotificationStore }) => {
            useQuickNotificationStore.getState().pushNotification({
              id: 'headless-touch-mode-detected',
              type: 'temporary',
              tone: 'warning',
              icon: 'Sliders',
              duration: 6000,
              content: 'Headless Parameter Detected (?touch=2) · Three.js 3D rendering is disabled.',
            });
          })
          .catch(() => {});
      }

      if (verbose) {
        console.log('[Loading] ══════════════ [Training Mode] Essential Pipeline Complete ══════════════');
        console.log('[Loading] Training Mode Essential Resources ready — Player can now play.');
      }

      import('../ui-core/stores/quickNotificationStore')
        .then(({ useQuickNotificationStore }) =>
          startBackgroundAssetPipeline(this.runtime, null, {
            notifyStore: useQuickNotificationStore.getState(),
          })
        )
        .catch((err) => {
          console.warn('[Loading] Background asset pipeline unhandled rejection:', err);
        });

      return this.runtime;
    } catch (err) {
      uiAdapter.onError({
        taskId: 'bootstrap',
        taskName: 'Engine Lifecycle Bootstrap',
        error: err,
        isCritical: true
      });
      console.error('[Bootstrap Error]', err);
      throw err;
    }
  }

  stop() {
    if (this.runtime) {
      this.runtime.stop();
    }
    if (this.cleanupInput) {
      this.cleanupInput();
      this.cleanupInput = null;
    }
  }

  renderFrame(timestamp) {
    if (this.runtime) {
      this.runtime.renderFrame(timestamp);
    }
  }
}

export async function bootstrapGameEngine(container, options = {}) {
  const bootstrap = new GameBootstrap(container, options);
  return await bootstrap.start();
}

export async function bootstrapEngine(options = {}) {
  if (activeGameRuntime) {
    return activeGameRuntime;
  }
  if (activeBootstrapPromise) {
    return activeBootstrapPromise;
  }

  activeBootstrapPromise = (async () => {
    const host = options.container || (typeof document !== 'undefined' ? document.querySelector('#app') : null);
    const loader = options.loader || host?.__minimumProgressLoader || null;

    if (loader) {
      loader.onTaskProgress({
        overallPercent: 4,
        detail: 'Initializing Three.js WebGL core & entity factories...'
      });
    }

    activeGameRuntime = await bootstrapGameEngine(host, {
      ...options,
      loader
    });
    return activeGameRuntime;
  })();

  try {
    return await activeBootstrapPromise;
  } finally {
    activeBootstrapPromise = null;
  }
}

export function renderGameFrame(timestamp) {
  if (activeGameRuntime) {
    activeGameRuntime.renderFrame(timestamp);
  }
}

export function destroyEngine() {
  if (activeGameRuntime) {
    activeGameRuntime.destroy();
    activeGameRuntime = null;
  }
}

export { activeGameRuntime };
