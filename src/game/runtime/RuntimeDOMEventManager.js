import { useAppStore } from '../../ui-core/stores/appStore';
import { determinismStore } from '../../ui-core/stores/determinismStore';
import { networkDiagnosticsStore } from '../../ui-core/stores/networkDiagnosticsStore';
import { toggleFloatingPreset } from '../../ui-core/stores/floatingStore';
import { NETWORK_MONITOR_PRESET } from '../../ui-core/stores/floatingPresets';
import { loadInputBindings } from '../../ui-core/config/InputBindings.js';
import { audioConfig } from '../../ui-core/config/audioConfig.js';
import { gameAudioEngine } from '../../audio/GameAudioEngineFacade.js';
import { getAudioSlotPool } from '../../audio/audioContext.js';
import { createRuntimeWindowKeyDownHandler } from './RuntimeWindowHotkeys.js';

/**
 * RuntimeDOMEventManager
 * Handles DOM resize, canvas interaction, keyboard shortcuts, HUD events, and blur/focus state.
 */
export class RuntimeDOMEventManager {
  constructor(runtime) {
    this.runtime = runtime;
  }

  updateViewport(graphics = null) {
    const r = this.runtime;
    if (typeof window === 'undefined' || !r.renderer || !r.camera) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    r.camera.camera.aspect = width / height;
    r.camera.camera.updateProjectionMatrix();

    const currentGraphics = graphics || (useAppStore && typeof useAppStore.getState === 'function' ? useAppStore.getState().graphics : null);
    const scale = ((currentGraphics?.renderScale) ?? 50) / 100;
    const basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const effectivePixelRatio = Math.max(0.1, basePixelRatio * scale);

    r.renderer.setPixelRatio(effectivePixelRatio);
    r.renderer.setSize(width, height);

    if (r.composer) {
      r.composer.setPixelRatio(effectivePixelRatio);
      r.composer.setSize(width, height);
    }
    if (r.boostBloom) {
      r.boostBloom.setSize(width, height, effectivePixelRatio);
    }
    if (r.speedLinesPass) {
      if (typeof r.speedLinesPass.setSize === 'function') {
        r.speedLinesPass.setSize(width, height);
      } else if (r.speedLinesPass.pass && typeof r.speedLinesPass.pass.setSize === 'function') {
        r.speedLinesPass.pass.setSize(width, height);
      }
    }
  }

  handleOverlayChange(name, isOpen) {
    const r = this.runtime;
    if (isOpen) {
      r.openOverlays.add(name);
      r.isCursorBrowsing = true;
    } else {
      r.openOverlays.delete(name);
      if (r.openOverlays.size === 0 && !(r.gameUI && useAppStore.getState().isOpen)) {
        r.isCursorBrowsing = false;
      }
    }
    this.syncPausedAndInputState();
  }

  syncPausedAndInputState(graphicsOverride = null) {
    const r = this.runtime;
    const appState = useAppStore.getState();
    const isLivePreviewDockCollapsed =
      appState.isOpen &&
      appState.isLivePreviewCollapsed &&
      (appState.activeRoute === 'trajectory' || appState.activeRoute === 'camera');
    const isUiOpen =
      ((r.gameUI && appState.isOpen) && !isLivePreviewDockCollapsed) ||
      (r.openOverlays.size > 0 && !isLivePreviewDockCollapsed);
    const isPaused = isUiOpen;

    const isOnlineSession = Boolean(r.networkReconciler || r.authoritativeServer);
    r.isPaused = isOnlineSession ? Boolean(r.match?.state?.paused) : isPaused;
    if (!isOnlineSession) {
      const shouldPauseMatch = (r.match?.state?.mode === 'match' || r.match?.state?.mode === 'exp-multi-bots') && isPaused;
      if (r.match) {
        r.match.state.paused = shouldPauseMatch;
      }
    }

    const allowInputs = !isUiOpen;
    if (r.keyboard) {
      r.keyboard.enabled = allowInputs;
      if (!allowInputs) {
        r.keyboard.resetInputs?.();
      }
    }
    if (r.gamepad) {
      r.gamepad.enabled = allowInputs;
    }

    const gfx = graphicsOverride || useAppStore?.getState?.()?.graphics || r.activeGraphicsSettings;
    const powerSave = gfx?.menuPowerSave || '30';
    if (r.clockScheduler) {
      if (isUiOpen && powerSave === '15') {
        r.clockScheduler.setFpsLimit(15);
      } else if (isUiOpen && (powerSave === '30' || powerSave === 'freeze')) {
        r.clockScheduler.setFpsLimit(30);
      } else {
        r.clockScheduler.setFpsLimit(gfx?.limitFps ? gfx.maxFps : null);
      }
    }

    if (r.container) {
      const isPlaying = !isUiOpen;
      r.container.dataset.cursorBrowsing = r.isCursorBrowsing ? 'true' : 'false';
      r.container.classList.toggle('game-playing', isPlaying && !r.isCursorBrowsing);
      r.container.classList.toggle('cursor-browsing', isPlaying && Boolean(r.isCursorBrowsing));
    }

    this.updateCursorHint();
  }

  updateInteractionState() {
    const r = this.runtime;
    const hasFocus = typeof document !== 'undefined' ? (!document.hidden && (typeof document.hasFocus === 'function' ? document.hasFocus() : true)) : true;
    r.isWindowFocused = hasFocus;
    this.syncPausedAndInputState();
  }

  updateCursorHint() {
    const r = this.runtime;
    if (!r.cursorHintButton) return;
    const isUiOpen = (r.gameUI && useAppStore.getState().isOpen) || r.openOverlays.size > 0;
    if (isUiOpen || !r.isCursorBrowsing) {
      r.cursorHintButton.style.display = 'none';
    } else {
      r.cursorHintButton.style.display = 'block';
    }
  }

  setupHudButtons() {
    const r = this.runtime;
    if (!r.container || typeof document === 'undefined') return;
    const hudTools = r.container.querySelector('.hud-tools');
    if (hudTools && r.cursorHintButton) {
      hudTools.appendChild(r.cursorHintButton);
    }
  }

  setupWindowEvents() {
    const r = this.runtime;
    if (typeof window === 'undefined') return;

    window.addEventListener('resize', () => {
      this.updateViewport();
    });

    const onSettingsToggle = () => {
      if (r.gameUI) {
        r.gameUI.toggleMenu();
        return;
      }
      useAppStore?.getState?.()?.toggleMenu?.();
    };
    if (r.gamepad) {
      r.gamepad.onSettingsToggle = onSettingsToggle;
    }

    const onDismissCursor = () => {
      r.isCursorBrowsing = false;
      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      this.syncPausedAndInputState();
    };

    const onCursorToggle = () => {
      const isUiOpen = (r.gameUI && useAppStore.getState().isOpen) || r.openOverlays.size > 0;
      if (isUiOpen) {
        r.isCursorBrowsing = true;
        onSettingsToggle();
      } else if (r.isCursorBrowsing) {
        onDismissCursor();
      } else {
        r.isCursorBrowsing = true;
        this.syncPausedAndInputState();
      }
    };
    if (r.keyboard) {
      r.keyboard.onSettingsToggle = onSettingsToggle;
    }
    if (r.cursorHintButton) {
      r.cursorHintButton.addEventListener('click', onSettingsToggle);
    }

    if (r.container) {
      const settingsBtn = r.container.querySelector('#settings-button');
      if (settingsBtn) settingsBtn.setAttribute('title', 'Settings');

      r._onContainerPointerDown = (evt) => {
        if (
          evt.pointerType !== 'mouse' ||
          !(evt.target instanceof Element) ||
          evt.target.closest(
            '#settings-button, #car-button, #match-button, #online-button, #trajectory-button, .online-tab-btn, .online-overlay, .online-modal, .net-hud, .hud-tools, .trajectory-overlay, .trajectory-panel, #game-ui-root, #game-ui-viewport-host, #game-root'
          )
        ) {
          r.isCursorBrowsing = true;
          this.syncPausedAndInputState();
        }
      };
      r.container.addEventListener('pointerdown', r._onContainerPointerDown, true);
    }

    if (r.gamepad) {
      r.gamepad.onActivity = () => {
        if (r.container) r.container.dataset.inputMethod = 'gamepad';
        if (r.isCursorBrowsing) {
          r.isCursorBrowsing = false;
          this.syncPausedAndInputState();
        }
      };
    }

    r._onToggleNetworkHUD = async () => {
      if (!r.networkReconciler) {
        await r.enableNetworkPrediction(false);
      }
      networkDiagnosticsStore.setSession(r.networkReconciler, r.networkChannel, r);
      await r.spawnHeadlessCarEntity();
      toggleFloatingPreset(NETWORK_MONITOR_PRESET);
    };

    window.dumpNextNetworkPacket = () => r.dumpNextNetworkPacket();
    window.dumpLatestNetworkPacket = (p) => r.dumpLatestNetworkPacket(p);
    window.toggleNetworkControlPanel = () => r._onToggleNetworkHUD?.();

    r._onWindowKeyDown = createRuntimeWindowKeyDownHandler(r);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', r._onWindowKeyDown, true);
    }

    r._onWindowBlurFocus = () => {
      r.pendingClickToPlay = false;
      this.updateInteractionState();
      if (r.interpolator) r.interpolator.sync();
      const hasFocus = typeof document !== 'undefined' ? (!document.hidden && (typeof document.hasFocus === 'function' ? document.hasFocus() : true)) : true;
      if (!audioConfig.get('continueAudioOnLostFocus')) {
        if (!hasFocus) {
          gameAudioEngine.silenceAll?.();
          if (r.engineSynths) {
            for (const entry of r.engineSynths) entry.synth?.silence?.();
          }
          const pool = getAudioSlotPool?.();
          if (pool) {
            pool.isMuted = true;
            pool.silenceAll?.();
          }
        } else {
          const pool = getAudioSlotPool?.();
          if (pool) {
            pool.silenceAll?.();
            pool.isMuted = false;
          }
          gameAudioEngine.stateEngine?._startLoops?.();
        }
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('blur', r._onWindowBlurFocus);
      window.addEventListener('focus', r._onWindowBlurFocus);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', r._onWindowBlurFocus);
    }

    if (r.renderer?.domElement) {
      r._onCanvasMouseDown = (evt) => {
        const appState = useAppStore?.getState?.();
        if (appState?.touchMode) {
          r.pendingClickToPlay = false;
          return;
        }
        r.pendingClickToPlay = r.isCursorBrowsing && r.openOverlays.size === 0 && evt.button === 0;
        const bindings = loadInputBindings();
        if (
          r.isCursorBrowsing &&
          r.openOverlays.size === 0 &&
          bindings.keyboard.toggleSettings.some((b) => b.kind === 'mouse' && b.button === evt.button)
        ) {
          evt.preventDefault();
          evt.stopPropagation();
          onCursorToggle();
        }
      };
      r.renderer.domElement.addEventListener('mousedown', r._onCanvasMouseDown);

      r._onCanvasClick = (evt) => {
        const appState = useAppStore?.getState?.();
        if (appState?.touchMode) {
          r.pendingClickToPlay = false;
          if (!appState.isOpen && r.openOverlays.size === 0) {
            evt.preventDefault();
            evt.stopPropagation();
            r.isCursorBrowsing = true;
            this.syncPausedAndInputState();
            appState.bridge?.onRequestTouchOpenMenuConfirm?.();
          }
          return;
        }

        const wasPending = r.pendingClickToPlay;
        r.pendingClickToPlay = false;
        if (wasPending && r.isCursorBrowsing && r.openOverlays.size === 0 && evt.button === 0) {
          evt.preventDefault();
          evt.stopPropagation();
          onDismissCursor();
        }
      };
      r.renderer.domElement.addEventListener('click', r._onCanvasClick);
    }
  }

  destroy() {
    const r = this.runtime;
    if (r.container && r._onContainerPointerDown) {
      r.container.removeEventListener('pointerdown', r._onContainerPointerDown, true);
      r._onContainerPointerDown = null;
    }
    if (typeof window !== 'undefined') {
      if (this._onWindowResize) {
        window.removeEventListener('resize', this._onWindowResize);
        this._onWindowResize = null;
      }
      if (r._onWindowKeyDown) {
        window.removeEventListener('keydown', r._onWindowKeyDown, true);
        r._onWindowKeyDown = null;
      }
      if (r._onWindowBlurFocus) {
        window.removeEventListener('blur', r._onWindowBlurFocus);
        window.removeEventListener('focus', r._onWindowBlurFocus);
      }
    }
    if (typeof document !== 'undefined' && r._onWindowBlurFocus) {
      document.removeEventListener('visibilitychange', r._onWindowBlurFocus);
    }
    r._onWindowBlurFocus = null;
    if (r.renderer?.domElement) {
      if (r._onCanvasMouseDown) {
        r.renderer.domElement.removeEventListener('mousedown', r._onCanvasMouseDown);
        r._onCanvasMouseDown = null;
      }
      if (r._onCanvasClick) {
        r.renderer.domElement.removeEventListener('click', r._onCanvasClick);
        r._onCanvasClick = null;
      }
    }
  }
}
