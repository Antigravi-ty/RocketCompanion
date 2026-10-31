import { audioConfig, registerAudioDiagnosticsProvider } from '../ui-core/config/audioConfig.js';
import {
  subsystemState,
  getAudioContext,
} from './audioContext.js';
import { listenerManager } from './SpatialAudioSource.js';
import {
  playAudioDiagnosticTestTone,
  forceAudioRecovery as runForceAudioRecovery,
  AudioDebugMonitorController,
} from './audioDiagnosticProbes.js';

export { playAudioDiagnosticTestTone };

export function forceAudioRecovery() {
  return runForceAudioRecovery(dumpAudioDiagnosticsToConsole);
}

export function applySurfaceTaxonomyColoring(arenaWorld, enabled = true, floorNz = 0.8, netNz = 0.05, THREE = null) {
  if (!arenaWorld) return;
  const contextThree = THREE || globalThis.THREE;

  const targetMeshes = [];
  if (arenaWorld.boundary) arenaWorld.boundary.traverse(child => { if (child.isMesh) targetMeshes.push(child); });
  if (arenaWorld.stadium) arenaWorld.stadium.traverse(child => { if (child.isMesh) targetMeshes.push(child); });

  for (const mesh of targetMeshes) {
    if (enabled) {
      if (!mesh.userData._originalMaterial) {
        mesh.userData._originalMaterial = mesh.material;
      }
      if (!contextThree) continue;

      const geom = mesh.geometry;
      if (!geom || !geom.attributes.position || !geom.attributes.normal) continue;

      const count = geom.attributes.position.count;
      const normals = geom.attributes.normal.array;
      const positions = geom.attributes.position.array;

      const colors = new Float32Array(count * 3);

      for (let i = 0; i < count; i++) {
        const ny = normals[i * 3 + 1];
        const py = positions[i * 3 + 1];
        const px = positions[i * 3 + 0];
        const pz = positions[i * 3 + 2];

        const isNearGoal = Math.abs(pz) >= 4950;
        const isGoalpost = isNearGoal && ((Math.abs(py - 642) < 80 && Math.abs(px) <= 950) || (Math.abs(Math.abs(px) - 893) < 80 && py <= 700));

        if (isGoalpost) {
          // Crimson Red (#ff4757)
          colors[i * 3 + 0] = 1.0;
          colors[i * 3 + 1] = 0.28;
          colors[i * 3 + 2] = 0.34;
        } else if (ny >= floorNz) {
          // Floor: Emerald Green (#2ecc71)
          colors[i * 3 + 0] = 0.18;
          colors[i * 3 + 1] = 0.80;
          colors[i * 3 + 2] = 0.44;
        } else if (ny <= netNz) {
          // Field Net / Ceiling / Sidewall: Neon Cyan (#00d2ff)
          colors[i * 3 + 0] = 0.0;
          colors[i * 3 + 1] = 0.82;
          colors[i * 3 + 2] = 1.0;
        } else {
          // Ramps / Transition Curves: Warm Orange (#ff9f43)
          colors[i * 3 + 0] = 1.0;
          colors[i * 3 + 1] = 0.62;
          colors[i * 3 + 2] = 0.26;
        }
      }

      geom.setAttribute('color', new contextThree.BufferAttribute(colors, 3));
      mesh.material = new contextThree.MeshBasicMaterial({
        vertexColors: true,
        wireframe: false,
        side: contextThree.DoubleSide
      });
    } else {
      if (mesh.userData._originalMaterial) {
        mesh.material = mesh.userData._originalMaterial;
        delete mesh.userData._originalMaterial;
      }
      if (mesh.geometry?.getAttribute('color')) {
        mesh.geometry.deleteAttribute('color');
      }
    }
  }
}

let _lastSampledContextTime = -1;
let _lastSampledPerfTime = 0;

/**
 * Collects a full diagnostic snapshot of the Web Audio subsystem, browser state,
 * master mixer, voice slot pool, continuous loops, EMotorSynth, and root-cause analysis.
 */
export function collectAudioDiagnosticReport() {
  const ctx = subsystemState.context || getAudioContext();
  const master = subsystemState.masterMixer;
  const pool = subsystemState.slotPool;
  const engine = subsystemState.audioEngine;
  const runtime = subsystemState.runtime;
  const telemetry = subsystemState.lastTelemetry || {};

  const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const ctxTime = ctx ? ctx.currentTime : 0;
  let clockAdvancing = true;
  if (_lastSampledPerfTime > 0 && nowPerf - _lastSampledPerfTime > 150 && ctx && ctx.state === 'running') {
    clockAdvancing = (ctxTime - _lastSampledContextTime) > 0.001;
  }
  _lastSampledContextTime = ctxTime;
  _lastSampledPerfTime = nowPerf;

  const docHidden = typeof document !== 'undefined' ? Boolean(document.hidden) : false;
  const visibilityState = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
  const docHasFocus = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? Boolean(document.hasFocus()) : true;

  const outputMetrics = master ? master.sampleOutputMetrics() : { rms: 0, peak: 0, dbfs: -120, silent: true };

  // Inspect SlotPool
  const slotsSummary = pool && Array.isArray(pool.slots)
    ? pool.slots.map((s) => ({
        id: s.id,
        inUse: Boolean(s.inUse),
        mode: s.currentMode || 'none',
        priority: s.priority,
        gain: s.gainNode?.gain?.value !== undefined ? Number(s.gainNode.gain.value.toFixed(4)) : 0,
        ageMs: s.inUse && s.startTime > 0 ? Math.round(nowPerf - s.startTime) : 0
      }))
    : [];
  const activeSlotCount = slotsSummary.filter((s) => s.inUse).length;

  // Inspect StateEngine & BallEmitter
  const stateEng = engine?.stateEngine;
  const ballEmit = engine?.ballEngine;
  const stateLoopInfo = {
    initialized: Boolean(stateEng?.initialized),
    isPlaying: Boolean(stateEng?.isPlaying),
    boostLoopSourceActive: Boolean(stateEng?.boostSource),
    boostGain: stateEng?.boostGain?.gain?.value !== undefined ? Number(stateEng.boostGain.gain.value.toFixed(4)) : 0,
    supersonicLoopSourceActive: Boolean(stateEng?.supersonicSource),
    supersonicGain: stateEng?.supersonicGain?.gain?.value !== undefined ? Number(stateEng.supersonicGain.gain.value.toFixed(4)) : 0,
    ballRollingSourceActive: Boolean(ballEmit?.rollingSource),
    ballRollingGain: ballEmit?.rollingGain?.gain?.value !== undefined ? Number(ballEmit.rollingGain.gain.value.toFixed(4)) : 0,
    ballFlyingSourceActive: Boolean(ballEmit?.flyingSource),
    ballFlyingGain: ballEmit?.flyingGain?.gain?.value !== undefined ? Number(ballEmit.flyingGain.gain.value.toFixed(4)) : 0
  };

  // Inspect Vehicle Emitters
  const vehicleEmitters = [];
  if (engine?.vehicleManager?.emitters) {
    for (const [carIdx, em] of engine.vehicleManager.emitters.entries()) {
      vehicleEmitters.push({
        carIndex: carIdx,
        isSelf: Boolean(em.isSelf),
        isAlive: Boolean(em.isAlive),
        audible: Boolean(em.audible),
        isBoosting: Boolean(em.isBoosting),
        isSupersonic: Boolean(em.isSupersonic),
        boostLoopActive: Boolean(em.boostLoopSource),
        boostGain: em.boostLoopGain?.gain?.value !== undefined ? Number(em.boostLoopGain.gain.value.toFixed(4)) : 0,
        supersonicLoopActive: Boolean(em.supersonicLoopSource),
        supersonicGain: em.supersonicLoopGain?.gain?.value !== undefined ? Number(em.supersonicLoopGain.gain.value.toFixed(4)) : 0,
        activeOneShots: em.activeSources ? em.activeSources.size : 0
      });
    }
  }

  // Inspect EMotorSynths
  const engineSynths = [];
  const synthsList = runtime?.engineSynths || [];
  for (let i = 0; i < synthsList.length; i++) {
    const entry = synthsList[i];
    const s = entry?.synth;
    engineSynths.push({
      carIndex: i,
      spatial: Boolean(entry?.spatial),
      spatialEnabled: Boolean(entry?.spatialBus?.enabled),
      spatialTargetGain: entry?.spatialBus?.targetGain !== undefined ? Number(entry.spatialBus.targetGain.toFixed(4)) : null,
      active: Boolean(s?.active),
      alive: Boolean(s?.alive),
      audible: Boolean(s?.audible),
      engineVolume: s?.engineVolume !== undefined ? Number(s.engineVolume.toFixed(4)) : 0,
      outputGain: s?.outputNode?.gain?.value !== undefined ? Number(s.outputNode.gain.value.toFixed(4)) : 0,
      baseFreqHz: s?.baseOsc?.frequency?.value !== undefined ? Number(s.baseOsc.frequency.value.toFixed(1)) : 0
    });
  }

  // Inspect Listener
  const listenerPos = listenerManager?.position || { x: 0, y: 0, z: 0 };
  const listenerValid =
    Boolean(listenerManager?.hasListener) &&
    Number.isFinite(listenerPos.x) &&
    Number.isFinite(listenerPos.y) &&
    Number.isFinite(listenerPos.z);

  // Loaded Buffers count
  let loadedBuffersCount = 0;
  if (subsystemState.buffers) {
    for (const v of subsystemState.buffers.values()) {
      if (v) loadedBuffersCount++;
    }
  }

  // Automated Root-Cause Verdict Engine
  const anomalies = [];
  let rootCauseCode = 'HEALTHY_ACTIVE';
  let rootCauseVerdict = 'Web Audio engine is healthy and actively outputting audio signals (RMS > 0).';

  const masterVol = Number(audioConfig.get('masterVolume') ?? 1.0);
  const engineVol = Number(audioConfig.get('engineVolume') ?? 0.8);
  const continueOnBlur = Boolean(audioConfig.get('continueAudioOnLostFocus'));
  const masterOutputGain = master?.output?.gain?.value ?? 0;

  if (!ctx) {
    rootCauseCode = 'NO_AUDIO_CONTEXT';
    rootCauseVerdict = 'AudioContext is not yet initialized or Web Audio API is unsupported by the browser.';
    anomalies.push(rootCauseVerdict);
  } else if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
    rootCauseCode = 'BROWSER_CONTEXT_SUSPENDED';
    rootCauseVerdict = `Browser blocked audio: AudioContext.state is "${ctx.state}" (likely autoplay policy or suspended audio focus; click page or Force Resume to unlock).`;
    anomalies.push(rootCauseVerdict);
  } else if (ctx.state === 'closed') {
    rootCauseCode = 'BROWSER_CONTEXT_CLOSED';
    rootCauseVerdict = 'AudioContext is closed and cannot output any sound.';
    anomalies.push(rootCauseVerdict);
  } else if (!clockAdvancing) {
    rootCauseCode = 'BROWSER_AUDIO_CLOCK_STALLED';
    rootCauseVerdict = 'Browser/audio driver stall: AudioContext.state is "running", but hardware currentTime stopped advancing.';
    anomalies.push(rootCauseVerdict);
  }

  if (masterVol <= 0.001) {
    anomalies.push('Configuration mute: Master Volume is set to 0%.');
    if (rootCauseCode === 'HEALTHY_ACTIVE') {
      rootCauseCode = 'CONFIG_MASTER_VOLUME_ZERO';
      rootCauseVerdict = 'Configuration mute: Master Volume is 0%, muting all audio output gain.';
    }
  }

  if (master && (!master.active || !master.connected || masterOutputGain <= 0.0001)) {
    const reason = (!docHasFocus || docHidden) && !continueOnBlur
      ? 'Window lost focus and Play Audio in Background is disabled'
      : 'MasterMixer is not in an active connected state';
    anomalies.push(`MasterMixer muted: master.active=${master.active}, master.connected=${master.connected}, gain=${masterOutputGain.toFixed(4)} (${reason}).`);
    if (rootCauseCode === 'HEALTHY_ACTIVE') {
      rootCauseCode = 'MASTER_MIXER_DISCONNECTED_OR_MUTED';
      rootCauseVerdict = `MasterMixer muted: gain=${masterOutputGain.toFixed(4)} / connected=${master.connected} (${reason}).`;
    }
  }

  if (pool?.isMuted) {
    anomalies.push('SlotPool muted: AudioSlotPool.isMuted = true, blocking one-shot collision/signal sounds.');
    if (rootCauseCode === 'HEALTHY_ACTIVE') {
      rootCauseCode = 'SLOT_POOL_MUTED';
      rootCauseVerdict = 'AudioSlotPool.isMuted is true (typically triggered by window blur mute).';
    }
  }

  if (telemetry.hasBlockingOverlay) {
    anomalies.push(`UI overlay mute: Blocking overlay open (${(telemetry.blockingOverlays || []).join(', ') || 'Menu Open'}), muting continuous engine synths and loops.`);
    if (rootCauseCode === 'HEALTHY_ACTIVE' && outputMetrics.silent) {
      rootCauseCode = 'GAME_STATE_OVERLAY_MUTED';
      rootCauseVerdict = 'Game state mute: Menu/overlay is open (hasBlockingOverlay=true); continuous engine and vehicle loops are paused until returning to match.';
    }
  } else if (telemetry.updatedAt > 0 && !telemetry.isAudibleActive) {
    anomalies.push(`Match not audible: isMatchActive=${telemetry.isMatchActive}, isHidden=${telemetry.isHidden}, continueOnBlur=${telemetry.continueOnBlur} -> isAudibleActive=false.`);
    if (rootCauseCode === 'HEALTHY_ACTIVE' && outputMetrics.silent) {
      rootCauseCode = 'GAME_STATE_NOT_AUDIBLE';
      rootCauseVerdict = 'Game state mute: Match is inactive or window is muted on blur (isAudibleActive=false).';
    }
  }

  if (!listenerValid) {
    anomalies.push(`Spatial listener invalid: hasListener=${listenerManager?.hasListener}, pos=(${listenerPos.x}, ${listenerPos.y}, ${listenerPos.z}).`);
  }

  if (outputMetrics.nanCount > 0) {
    anomalies.push(`DSP NaN anomaly: Master output detected ${outputMetrics.nanCount} NaN/Infinity samples!`);
    rootCauseCode = 'DSP_NAN_CORRUPTION';
    rootCauseVerdict = 'DSP pipeline error: MasterMixer output contains NaN/Infinity samples.';
  }

  if (rootCauseCode === 'HEALTHY_ACTIVE' && outputMetrics.silent) {
    const anySynthActive = engineSynths.some((s) => s.active && s.outputGain > 0.001);
    const anyLoopActive =
      stateLoopInfo.boostGain > 0.001 ||
      stateLoopInfo.supersonicGain > 0.001 ||
      stateLoopInfo.ballRollingGain > 0.001 ||
      stateLoopInfo.ballFlyingGain > 0.001 ||
      activeSlotCount > 0;

    if (anySynthActive || anyLoopActive) {
      rootCauseCode = 'CLIENT_GHOST_PLAYBACK';
      rootCauseVerdict = 'Client/Browser playback anomaly: Audio nodes are active with Gain > 0, but Master bus Analyser reads silence. Click Force Resume / Rebuild to recover.';
    } else {
      rootCauseCode = 'HEALTHY_IDLE_SILENT';
      rootCauseVerdict = 'Web Audio pipeline is healthy and ready (AudioContext running, MasterMixer connected), currently idle in silent standby.';
    }
  } else if (rootCauseCode === 'HEALTHY_ACTIVE' && !outputMetrics.silent) {
    rootCauseVerdict = `Web Audio is actively outputting sound (Realtime Level: ${outputMetrics.dbfs} dBFS, Peak: ${outputMetrics.peak}). If no sound is heard, check browser tab mute or OS output device.`;
  }

  return {
    timestamp: new Date().toISOString(),
    verdict: {
      code: rootCauseCode,
      summary: rootCauseVerdict,
      anomalies
    },
    audioContext: {
      exists: Boolean(ctx),
      state: ctx ? ctx.state : 'none',
      currentTime: ctx ? Number(ctx.currentTime.toFixed(3)) : 0,
      clockAdvancing,
      sampleRate: ctx ? ctx.sampleRate : 0,
      baseLatency: ctx?.baseLatency ?? null,
      outputLatency: ctx?.outputLatency ?? null,
      destinationMaxChannels: ctx?.destination?.maxChannelCount ?? null
    },
    masterMixer: {
      active: Boolean(master?.active),
      connected: Boolean(master?.connected),
      configuredVolume: masterVol,
      outputGainValue: Number(masterOutputGain.toFixed(4)),
      realtimeOutput: outputMetrics
    },
    focusAndVisibility: {
      documentHidden: docHidden,
      visibilityState,
      documentHasFocus: docHasFocus,
      runtimeWindowFocused: Boolean(runtime?.isWindowFocused ?? docHasFocus),
      continueAudioOnLostFocus: continueOnBlur
    },
    gameAudioState: {
      ...telemetry,
      engineVolumeConfig: engineVol,
      boostVolumeConfig: Number(audioConfig.get('boostVolume') ?? 0.8),
      loadedBuffersCount,
      totalRegisteredBufferKeys: subsystemState.buffers ? subsystemState.buffers.size : 0
    },
    slotPool: {
      initialized: Boolean(pool?._initialized),
      isMuted: Boolean(pool?.isMuted),
      activeSlots: activeSlotCount,
      maxSlots: pool?.maxSlots ?? 10,
      slots: slotsSummary
    },
    continuousLoops: stateLoopInfo,
    vehicleEmitters,
    engineSynths,
    spatialListener: {
      hasListener: Boolean(listenerManager?.hasListener),
      valid: listenerValid,
      positionUU: {
        x: Number((listenerPos.x || 0).toFixed(1)),
        y: Number((listenerPos.y || 0).toFixed(1)),
        z: Number((listenerPos.z || 0).toFixed(1))
      }
    },
    recentLifecycleEvents: subsystemState.lifecycleHistory.slice(-15)
  };
}

/**
 * Formats and prints the full Audio Diagnostic Report to the browser DevTools Console.
 */
export function dumpAudioDiagnosticsToConsole(reason = 'Manual Diagnostic Trigger') {
  const report = collectAudioDiagnosticReport();
  const styleHeader = 'color:#38bdf8;font-weight:bold;font-size:12px;';
  const styleVerdict = report.verdict.code.startsWith('HEALTHY')
    ? 'color:#10b981;font-weight:bold;'
    : 'color:#f59e0b;font-weight:bold;';

  console.group(`%c[AudioDebug] Diagnostic Snapshot — ${reason} (${report.timestamp})`, styleHeader);
  console.log(`%c[Verdict] (${report.verdict.code}): ${report.verdict.summary}`, styleVerdict);

  if (report.verdict.anomalies.length > 0) {
    console.warn('[Detected Anomalies]:', report.verdict.anomalies);
  }

  console.log('[1. Web AudioContext & Master Mixer]:', {
    contextState: report.audioContext.state,
    currentTime: report.audioContext.currentTime,
    clockAdvancing: report.audioContext.clockAdvancing,
    sampleRate: report.audioContext.sampleRate,
    baseLatency: report.audioContext.baseLatency,
    outputLatency: report.audioContext.outputLatency,
    masterActive: report.masterMixer.active,
    masterConnected: report.masterMixer.connected,
    masterGainValue: report.masterMixer.outputGainValue,
    realtimeRMS: report.masterMixer.realtimeOutput.rms,
    realtimePeak: report.masterMixer.realtimeOutput.peak,
    realtimeDbFS: `${report.masterMixer.realtimeOutput.dbfs} dBFS`,
    isOutputSilent: report.masterMixer.realtimeOutput.silent
  });

  console.log('[2. Focus, Visibility & Game Audibility Gate]:', {
    ...report.focusAndVisibility,
    isMatchActive: report.gameAudioState.isMatchActive,
    hasBlockingOverlay: report.gameAudioState.hasBlockingOverlay,
    blockingOverlays: report.gameAudioState.blockingOverlays,
    isAudibleActive: report.gameAudioState.isAudibleActive,
    loadedBuffers: `${report.gameAudioState.loadedBuffersCount}/${report.gameAudioState.totalRegisteredBufferKeys}`
  });

  console.log('[3. Continuous Loops (Ball / Boost / Supersonic) & Spatial Listener]:', {
    loops: report.continuousLoops,
    listener: report.spatialListener,
    slotPoolMuted: report.slotPool.isMuted,
    slotPoolActiveVoices: `${report.slotPool.activeSlots}/${report.slotPool.maxSlots}`
  });

  if (report.engineSynths.length > 0) {
    console.table(report.engineSynths);
  }
  if (report.vehicleEmitters.length > 0) {
    console.table(report.vehicleEmitters);
  }
  if (report.recentLifecycleEvents.length > 0) {
    console.log('[4. Recent Audio Lifecycle Events]:');
    console.table(report.recentLifecycleEvents);
  }
  console.groupEnd();

  return report;
}

export const audioDebugMonitor = new AudioDebugMonitorController({
  collectReport: collectAudioDiagnosticReport,
  dumpToConsole: dumpAudioDiagnosticsToConsole,
});

registerAudioDiagnosticsProvider({
  collectReport: collectAudioDiagnosticReport,
  dumpToConsole: dumpAudioDiagnosticsToConsole,
  playTestTone: playAudioDiagnosticTestTone,
  forceRecovery: forceAudioRecovery,
  previewBoostVariation: (variationId, phase) =>
    subsystemState.audioEngine?.previewBoostVariation?.(variationId, phase),
});

if (typeof window !== 'undefined') {
  window.__audioDebug = {
    getReport: collectAudioDiagnosticReport,
    dump: () => dumpAudioDiagnosticsToConsole('window.__audioDebug.dump()'),
    testTone: playAudioDiagnosticTestTone,
    recover: forceAudioRecovery,
    enableMonitor: (on = true) => {
      audioConfig.set('audioDebugMode', Boolean(on));
      audioDebugMonitor.setEnabled(Boolean(on));
    }
  };
}

audioConfig.subscribe((cfg) => {
  if (cfg && typeof cfg.audioDebugMode === 'boolean') {
    audioDebugMonitor.setEnabled(cfg.audioDebugMode);
  }
});
if (audioConfig.get('audioDebugMode')) {
  audioDebugMonitor.setEnabled(true);
}
