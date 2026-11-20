/**
 * scripts/lib/softTimeoutWatchdog.mjs
 *
 * Unified 4.5-minute (270,000ms) soft-timeout watchdog & streaming logger for
 * RocketCompanion test/repro/bootstrap scripts.
 *
 * Container hard limit is 300s; defaulting RC_SOFT_LIMIT_MS=270000 leaves a 30s
 * safety margin to flush partial telemetry/reports and tear down Chrome/Vite
 * cleanly before SIGKILL.
 */

export const DEFAULT_SOFT_LIMIT_MS = 270_000;

export function resolveSoftLimitMs(
  explicitMs,
  envNames = ['RC_SOFT_LIMIT_MS', 'RC_SUITE_WATCHDOG_MS']
) {
  if (explicitMs !== undefined && explicitMs !== null && explicitMs !== '') {
    const parsed = Number(explicitMs);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(1_000, Math.floor(parsed));
    }
  }
  for (const envName of envNames) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.max(1_000, Math.floor(parsed));
      }
    }
  }
  return DEFAULT_SOFT_LIMIT_MS;
}

export function streamLine(line, stream = process.stdout) {
  try {
    stream.write(`${line}\n`);
  } catch {
    // Ignore EPIPE / closed stream during shutdown
  }
}

export function createSoftTimeoutWatchdog(options = {}) {
  const label = options.label || 'Watchdog';
  const softLimitMs = resolveSoftLimitMs(options.softLimitMs, options.envNames);
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 1;
  const shouldUnref = options.unref !== false;
  const autoExitOnTimeout = options.autoExitOnTimeout !== false;
  const cleanupGraceMs = Math.max(500, Number(options.cleanupGraceMs) || 3_000);
  const startedAt = Date.now();

  let disposed = false;
  let triggered = false;
  let activeStage = null;
  const completedStages = [];

  const elapsedMs = () => Date.now() - startedAt;

  const log = (msg) => {
    streamLine(`[${label}] ${msg}`, process.stdout);
  };

  const warn = (msg) => {
    streamLine(`[${label}] ${msg}`, process.stderr);
  };

  const streamEvent = (event) => {
    streamLine(`[${label}:Stream] ${JSON.stringify(event)}`, process.stdout);
  };

  const stageStart = (name, meta) => {
    activeStage = { name, startedAt: Date.now() };
    const suffix = meta !== undefined ? ` ${JSON.stringify(meta)}` : '';
    log(`[START] ${name}${suffix}`);
  };

  const stagePass = (name, durationMs, detail) => {
    if (activeStage?.name === name) activeStage = null;
    completedStages.push({ name, passed: true, durationMs });
    const suffix = detail !== undefined ? ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
    log(`[PASS] ${name} (${durationMs}ms)${suffix}`);
  };

  const stageFail = (name, durationMs, err) => {
    if (activeStage?.name === name) activeStage = null;
    completedStages.push({ name, passed: false, durationMs });
    const message = err instanceof Error ? err.message : String(err);
    warn(`[FAIL] ${name} (${durationMs}ms): ${message}`);
  };

  const runStage = async (name, fn) => {
    const t0 = Date.now();
    stageStart(name);
    try {
      const result = await fn();
      stagePass(name, Date.now() - t0);
      return result;
    } catch (err) {
      stageFail(name, Date.now() - t0, err);
      throw err;
    }
  };

  const triggerCleanupAndExit = async (reason, signal, targetExitCode) => {
    if (triggered || disposed) return;
    triggered = true;
    clearTimeout(timer);

    const activeInfo = activeStage
      ? ` activeStage="${activeStage.name}" (${Date.now() - activeStage.startedAt}ms)`
      : '';
    warn(
      `${reason} (limit=${softLimitMs}ms, elapsed=${elapsedMs()}ms, completed=${completedStages.length}${activeInfo}). Flushing telemetry & cleaning up...`
    );

    const shouldExit = reason.startsWith('Received ') || autoExitOnTimeout;
    let graceTimer = null;
    if (shouldExit) {
      graceTimer = setTimeout(() => {
        warn(`Cleanup grace (${cleanupGraceMs}ms) exceeded; forcing exit(${targetExitCode}).`);
        process.exit(targetExitCode);
      }, cleanupGraceMs);
      graceTimer.unref();
    }

    try {
      const handler =
        reason.startsWith('Received ') && typeof options.onSignal === 'function'
          ? options.onSignal
          : options.onTimeout;
      if (typeof handler === 'function') {
        await handler({
          reason,
          signal,
          elapsedMs: elapsedMs(),
          softLimitMs,
          activeStage,
          completedStages: [...completedStages],
        });
      }
    } catch (err) {
      warn(`Cleanup handler error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
      removeSignalListeners();
      if (shouldExit) {
        process.exit(targetExitCode);
      }
    }
  };

  const onSigInt = () => {
    void triggerCleanupAndExit('Received SIGINT', 'SIGINT', 130);
  };
  const onSigTerm = () => {
    void triggerCleanupAndExit('Received SIGTERM', 'SIGTERM', 143);
  };

  const removeSignalListeners = () => {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
  };

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  const timer = setTimeout(() => {
    void triggerCleanupAndExit('Soft timeout watchdog reached', null, exitCode);
  }, softLimitMs);

  if (shouldUnref) {
    timer.unref();
  }

  if (options.announceArm !== false) {
    log(`Soft timeout watchdog armed (limit=${softLimitMs}ms)`);
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    removeSignalListeners();
  };

  return {
    label,
    softLimitMs,
    startedAt,
    elapsedMs,
    log,
    warn,
    streamEvent,
    stageStart,
    stagePass,
    stageFail,
    runStage,
    dispose,
  };
}
