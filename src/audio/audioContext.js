import { AudioMixer } from './AudioMixer.js';
import { AudioSlotPool } from './AudioSlotPool.js';
import { audioConfig } from '../ui-core/config/audioConfig.js';
import { listenerManager } from './SpatialAudioSource.js';

export const subsystemState = {
  context: null,
  masterMixer: null,
  slotPool: null,
  buffers: new Map(),
  loading: null,
  loaded: false,
  audioEngine: null,
  runtime: null,
  lastTelemetry: {
    updatedAt: 0,
    contextCurrentTime: 0,
    isMatchActive: false,
    hasBlockingOverlay: false,
    blockingOverlays: [],
    continueOnBlur: false,
    isHidden: false,
    isAudibleActive: false,
    activeCar: 0,
    effectiveNumCars: 0,
    engineSynthsCount: 0,
    activeEngineSynths: 0
  },
  lifecycleHistory: []
};

export function recordAudioLifecycleEvent(eventType, details = {}) {
  const ctx = subsystemState.context;
  const entry = {
    timeIso: new Date().toISOString().slice(11, 23),
    perfMs: Math.round(typeof performance !== 'undefined' ? performance.now() : 0),
    event: eventType,
    ctxState: ctx ? ctx.state : 'uninitialized',
    ctxTime: ctx ? Number(ctx.currentTime.toFixed(3)) : 0,
    masterActive: Boolean(subsystemState.masterMixer?.active),
    masterConnected: Boolean(subsystemState.masterMixer?.connected),
    masterGain: subsystemState.masterMixer?.output?.gain?.value !== undefined
      ? Number(subsystemState.masterMixer.output.gain.value.toFixed(4))
      : null,
    poolMuted: Boolean(subsystemState.slotPool?.isMuted),
    docHidden: typeof document !== 'undefined' ? Boolean(document.hidden) : false,
    docFocus: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? Boolean(document.hasFocus()) : true,
    ...details
  };
  subsystemState.lifecycleHistory.push(entry);
  if (subsystemState.lifecycleHistory.length > 40) {
    subsystemState.lifecycleHistory.shift();
  }
  if (audioConfig.get('audioDebugMode')) {
    console.info(`[AudioDebug:Lifecycle] ${eventType}`, entry);
  }
  return entry;
}

export function registerAudioEngine(engine) {
  subsystemState.audioEngine = engine;
}

export function registerAudioRuntime(runtime) {
  subsystemState.runtime = runtime;
}

export function getAudioContext() {
  if (typeof window === "undefined") return null;
  if (!subsystemState.context) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    let ctx;
    try {
      ctx = new AudioContextClass({ latencyHint: 0 });
    } catch (_) {
      console.warn('[AudioArchitecture:getAudioContext] Failed latencyHint 0, fallback to interactive:', _);
      try {
        ctx = new AudioContextClass({ latencyHint: "interactive" });
      } catch (__) {
        console.warn('[AudioArchitecture:getAudioContext] Failed latencyHint interactive, fallback to default:', __);
        ctx = new AudioContextClass();
      }
    }
    subsystemState.context = ctx;
    listenerManager.setContext(ctx);

    const master = new AudioMixer(ctx);
    master.setVolume(audioConfig.get('masterVolume'));
    master.setActive(true);
    subsystemState.masterMixer = master;

    subsystemState.slotPool = new AudioSlotPool(ctx, 10, master.input);
    subsystemState.slotPool.init(master.input);

    recordAudioLifecycleEvent('context_created', {
      sampleRate: ctx.sampleRate,
      baseLatency: ctx.baseLatency ?? null
    });

    const onAudioReady = () => {
      if (ctx.state === "running") {
        master.setActive(true);
        master.apply();
        subsystemState.audioEngine?.stateEngine?._startLoops?.();
        recordAudioLifecycleEvent('audio_ready_running');
      }
    };

    // User interaction audio unlock
    const unlock = (evt) => {
      if (ctx.state === "suspended" || ctx.state === "interrupted") {
        recordAudioLifecycleEvent('user_unlock_attempt', { trigger: evt?.type || 'gesture' });
        ctx.resume().then(onAudioReady).catch((err) => {
          recordAudioLifecycleEvent('user_unlock_failed', { error: err?.message || String(err) });
          console.warn('[AudioArchitecture] AudioContext unlock resume failed/blocked:', err);
        });
      } else if (ctx.state === "running") {
        if (!master.active || !master.connected) {
          onAudioReady();
        }
      }
    };
    window.addEventListener("pointerdown", unlock, { passive: true, capture: true });
    window.addEventListener("keydown", unlock, { passive: true, capture: true });
    window.addEventListener("touchstart", unlock, { passive: true, capture: true });
    window.addEventListener("click", unlock, { passive: true, capture: true });

    if (typeof document !== "undefined") {
      document.addEventListener("pointerdown", unlock, { passive: true, capture: true });
      document.addEventListener("keydown", unlock, { passive: true, capture: true });
      document.addEventListener("touchstart", unlock, { passive: true, capture: true });
      document.addEventListener("click", unlock, { passive: true, capture: true });
    }

    if (typeof ctx.addEventListener === "function") {
      ctx.addEventListener("statechange", () => {
        recordAudioLifecycleEvent('ctx_statechange', { newState: ctx.state });
        if (ctx.state === "running") {
          onAudioReady();
        } else if ((ctx.state === "suspended" || ctx.state === "interrupted") && typeof document !== "undefined" && !document.hidden && (document.hasFocus?.() ?? true)) {
          const continueOnBlur = audioConfig.get('continueAudioOnLostFocus');
          if (continueOnBlur || !document.hidden) {
            ctx.resume().then(onAudioReady).catch((err) => {
              recordAudioLifecycleEvent('statechange_auto_resume_failed', { error: err?.message || String(err) });
            });
          }
        }
      });
    }

    // Focus / Visibility shielding
    let isWindowCurrentlyFocused =
      typeof document !== "undefined"
        ? !document.hidden && (typeof document.hasFocus === "function" ? document.hasFocus() : true)
        : true;

    const handleFocus = (hasFocus, source = 'focus') => {
      const effectiveFocus =
        Boolean(hasFocus) && (typeof document === "undefined" || !document.hidden);
      const wasFocused = isWindowCurrentlyFocused;
      isWindowCurrentlyFocused = effectiveFocus;

      const continueOnBlur = audioConfig.get('continueAudioOnLostFocus');
      recordAudioLifecycleEvent(effectiveFocus ? 'window_focus_regained' : 'window_focus_lost', {
        source,
        continueOnBlur,
        wasFocused,
      });

      subsystemState.audioEngine?.stadiumSpatialEngine?.handleWindowFocusChange?.(
        effectiveFocus,
        Boolean(continueOnBlur)
      );

      if (continueOnBlur) {
        if (subsystemState.slotPool) subsystemState.slotPool.isMuted = false;
        master.setActive(true);
        if (ctx.state === "suspended" || ctx.state === "interrupted") {
          ctx.resume().then(onAudioReady).catch((err) => {
            recordAudioLifecycleEvent('focus_resume_failed', { error: err?.message || String(err) });
          });
        }
      } else {
        if (!effectiveFocus) {
          master.setActive(false);
          if (subsystemState.slotPool) {
            subsystemState.slotPool.isMuted = true;
            subsystemState.slotPool.silenceAll();
          }
          subsystemState.audioEngine?.silenceAll?.();
        } else {
          // Avoid redundant flush/pop if a duplicate focus event (e.g. visibilitychange + window.focus)
          // fires when the audio output is already active and running.
          if (wasFocused && master.active && master.connected && ctx.state === "running") {
            return;
          }
          // Regaining focus without background audio permitted:
          // Immediately flush output, unblock buffer reception, and clear all voice slots to avoid audio pops & latency
          master.flush();
          if (subsystemState.slotPool) {
            subsystemState.slotPool.silenceAll();
            subsystemState.slotPool.isMuted = false;
          }
          subsystemState.audioEngine?.silenceAll?.();
          master.setActive(true);
          if (ctx.state === "suspended" || ctx.state === "interrupted") {
            ctx.resume().then(onAudioReady).catch((err) => {
              recordAudioLifecycleEvent('regain_focus_resume_failed', { error: err?.message || String(err) });
            });
          } else {
            onAudioReady();
          }
        }
      }
    };
    window.addEventListener("focus", () => handleFocus(true, 'window.focus'));
    window.addEventListener("blur", () => handleFocus(false, 'window.blur'));
    document.addEventListener("visibilitychange", () => {
      handleFocus(!document.hidden, 'document.visibilitychange');
    });
    window.addEventListener("pageshow", () => {
      if (typeof document === "undefined" || !document.hidden) {
        handleFocus(true, 'window.pageshow');
      }
    });

    audioConfig.subscribe((cfg) => {
      master.setVolume(cfg.masterVolume ?? 1.0);
    });
  }
  return subsystemState.context;
}

export function getMasterAudioInput() {
  getAudioContext();
  return subsystemState.masterMixer ? subsystemState.masterMixer.input : null;
}

export function getAudioSlotPool() {
  getAudioContext();
  return subsystemState.slotPool;
}

export function setAudioSlotPool(pool) {
  subsystemState.slotPool = pool;
}
