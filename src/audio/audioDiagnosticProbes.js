import { audioConfig } from '../ui-core/config/audioConfig.js';
import {
  subsystemState,
  getAudioContext,
  getAudioSlotPool,
  recordAudioLifecycleEvent,
} from './audioContext.js';

/**
 * Plays a clean 440Hz -> 660Hz two-tone diagnostic beep through the MasterMixer
 * (and optionally directly to ctx.destination if master is muted) and measures actual RMS output.
 */
export async function playAudioDiagnosticTestTone({ bypassMixer = false } = {}) {
  const ctx = getAudioContext();
  if (!ctx) {
    console.error('[AudioDebug:TestTone] Cannot play test tone: AudioContext unavailable.');
    return { ok: false, reason: 'No AudioContext' };
  }

  recordAudioLifecycleEvent('diagnostic_test_tone_start', { bypassMixer });

  if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
    try {
      await ctx.resume();
    } catch (e) {
      console.warn('[AudioDebug:TestTone] ctx.resume() failed:', e);
    }
  }

  const master = subsystemState.masterMixer;
  if (master && !bypassMixer) {
    master.setActive(true);
    master.apply();
  }

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(440, now);
  osc.frequency.setValueAtTime(660, now + 0.12);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.25, now + 0.02);
  gain.gain.setValueAtTime(0.25, now + 0.22);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.30);

  osc.connect(gain);
  const targetDest = !bypassMixer && master?.input ? master.input : ctx.destination;
  gain.connect(targetDest);

  osc.start(now);
  osc.stop(now + 0.32);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const metricsMidTone = master
    ? master.sampleOutputMetrics()
    : { rms: 0, peak: 0, dbfs: -120, silent: true };
  const result = {
    ok: ctx.state === 'running' && (!metricsMidTone.silent || bypassMixer),
    contextState: ctx.state,
    bypassMixer,
    masterConnected: Boolean(master?.connected),
    masterGain: master?.output?.gain?.value ?? null,
    measuredOutput: metricsMidTone,
  };

  console.info('[AudioDebug:TestTone] 440Hz/660Hz Probe Result:', result);
  return result;
}

/**
 * Forces AudioContext resume, unmutes AudioSlotPool, reconnects MasterMixer,
 * and restarts continuous state loops. Useful for recovering from stuck audio states.
 */
export async function forceAudioRecovery(dumpToConsole = null) {
  const ctx = getAudioContext();
  if (!ctx) return { ok: false, reason: 'No AudioContext' };

  recordAudioLifecycleEvent('force_audio_recovery_invoked');

  try {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      await ctx.resume();
    }
  } catch (e) {
    console.warn('[AudioDebug:ForceRecovery] ctx.resume() error:', e);
  }

  const master = subsystemState.masterMixer;
  if (master) {
    master.setVolume(audioConfig.get('masterVolume') ?? 1.0);
    master.setActive(true);
    master.apply();
  }

  const pool = getAudioSlotPool();
  if (pool) {
    pool.isMuted = false;
  }

  subsystemState.audioEngine?.stateEngine?._startLoops?.();
  if (subsystemState.audioEngine?.vehicleManager?.emitters) {
    for (const emitter of subsystemState.audioEngine.vehicleManager.emitters.values()) {
      emitter._startLoops?.();
    }
  }

  const report = typeof dumpToConsole === 'function'
    ? dumpToConsole('After Force Audio Recovery')
    : null;
  return {
    ok: ctx.state === 'running' && Boolean(master?.connected),
    report,
  };
}

export class AudioDebugMonitorController {
  constructor({ collectReport, dumpToConsole } = {}) {
    this.intervalId = null;
    this.enabled = false;
    this.collectReport = collectReport;
    this.dumpToConsole = dumpToConsole;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.enabled && typeof window !== 'undefined') {
      console.info(
        '%c[AudioDebug] Audio Debug Mode ENABLED — Periodic telemetry & anomaly detector active (window.__audioDebug available).',
        'color:#10b981;font-weight:bold;'
      );
      this.dumpToConsole?.('Audio Debug Mode Enabled');
      this.intervalId = setInterval(() => {
        if (!this.enabled || typeof this.collectReport !== 'function') return;
        const r = this.collectReport();
        const isSilentAnomaly =
          r.gameAudioState.isAudibleActive &&
          r.masterMixer.realtimeOutput.silent &&
          r.engineSynths.some((s) => s.active && s.outputGain > 0.005);

        if (!r.verdict.code.startsWith('HEALTHY') || isSilentAnomaly) {
          console.warn(
            `[AudioDebug:Monitor] Anomaly detected (${r.verdict.code}): ${r.verdict.summary}`,
            {
              ctxState: r.audioContext.state,
              ctxTime: r.audioContext.currentTime,
              masterGain: r.masterMixer.outputGainValue,
              masterConnected: r.masterMixer.connected,
              poolMuted: r.slotPool.isMuted,
              rms: r.masterMixer.realtimeOutput.rms,
              dbfs: r.masterMixer.realtimeOutput.dbfs,
            }
          );
        } else {
          console.debug(
            `[AudioDebug:Heartbeat] state=${r.audioContext.state} t=${r.audioContext.currentTime}s | masterGain=${r.masterMixer.outputGainValue} connected=${r.masterMixer.connected} | output=${r.masterMixer.realtimeOutput.dbfs}dBFS (peak=${r.masterMixer.realtimeOutput.peak}) | synths=${r.gameAudioState.activeEngineSynths}/${r.gameAudioState.engineSynthsCount} | poolVoices=${r.slotPool.activeSlots}/${r.slotPool.maxSlots}`
          );
        }
      }, 2500);
    } else if (!this.enabled) {
      console.info('%c[AudioDebug] Audio Debug Mode DISABLED.', 'color:#94a3b8;');
    }
  }
}
