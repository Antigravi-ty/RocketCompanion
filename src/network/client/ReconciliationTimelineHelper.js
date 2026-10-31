import { evaluatePacingControllerStep } from '../../ui-core/stores/pacingTelemetryRecorder.js';
import { isDiagnosticProbeSlot } from '../../physics/RocketSimConstants.js';

const BALL_OFFSET = 4;       // SIM_OFFSETS.BALL
const BALL_VEL_OFFSET = 12;  // Within BallStatePod (0..2 pos, 3..11 rotMat, 12..14 vel)
const CAR_BASE_OFFSET = 22;  // SIM_OFFSETS.CARS
const CAR_STRIDE = 40;       // CAR_STATE_STRIDE

function recordEntryCompactSnapshot(reconciler, entry) {
  if (entry && typeof reconciler.sim?.saveCompactState === 'function') {
    entry.stateSnapshot = reconciler.sim.saveCompactState(entry.stateSnapshot);
  }
}

export function configureClientLobbyDiagnosticProbes(sim) {
  if (!sim) return;
  const hasSlot6 = typeof sim.isCarSlotActive === 'function' ? sim.isCarSlotActive(6) : sim.numCars > 6;
  if (hasSlot6) {
    sim.setCarLinearFactorAndGravity?.(6, 0, 0, 1, 1.0);
    sim.setCarUnlimitedBoost?.(6, true);
    sim.setCarCollisionMask?.(6, false, false);
  }
  const hasSlot7 = typeof sim.isCarSlotActive === 'function' ? sim.isCarSlotActive(7) : sim.numCars > 7;
  if (hasSlot7) {
    sim.setCarLinearFactorAndGravity?.(7, 0, 0, 0, 0.0);
    sim.setCarUnlimitedBoost?.(7, true);
    sim.setCarCollisionMask?.(7, false, false);
  }
}

export function saveClientLobbyLocalEntities(reconciler) {
  if (!reconciler?.lobbyDualWorldMode || !reconciler.sim) return null;
  const sim = reconciler.sim;
  const compactState = typeof sim.saveCompactState === 'function'
    ? sim.saveCompactState()
    : (sim.state ? new Float32Array(sim.state) : null);
  return { compactState };
}

export function restoreClientLobbyLocalEntities(reconciler, saved) {
  if (!reconciler?.lobbyDualWorldMode || !reconciler.sim || !saved) return;
  const sim = reconciler.sim;
  const localIdx = reconciler.localCarIndex ?? 1;

  if (saved.compactState && sim.state && sim.state.length >= CAR_BASE_OFFSET + 6 * CAR_STRIDE) {
    // Copy Ball (4..22) and Cars 0..5 (22..262) into sim.state while keeping Diagnostic Probes (6..7) from server
    const copyEnd = CAR_BASE_OFFSET + 6 * CAR_STRIDE;
    sim.state.subarray(BALL_OFFSET, copyEnd).set(saved.compactState.subarray(BALL_OFFSET, copyEnd));
    if (sim.state.length >= 440 && saved.compactState.length >= 440) {
      sim.state.subarray(416, 416 + 6 * 4).set(saved.compactState.subarray(416, 416 + 6 * 4));
    }
    if (typeof sim.restoreCompactState === 'function') {
      sim.restoreCompactState(sim.state, { preserveEngineTick: true });
    } else {
      sim.setBallState?.(saved.compactState.subarray(BALL_OFFSET, CAR_BASE_OFFSET));
      if (localIdx >= 0 && localIdx < 6) {
        const cOff = CAR_BASE_OFFSET + localIdx * CAR_STRIDE;
        sim.setCarState?.(localIdx, saved.compactState.subarray(cOff, cOff + CAR_STRIDE));
      }
    }
  }

  if (localIdx >= 0 && localIdx < 6 && typeof sim.getCarStateView === 'function') {
    const cv = sim.getCarStateView(localIdx);
    if (
      cv &&
      (!Number.isFinite(cv.posZ) ||
        cv.posZ < 10.0 ||
        Math.abs(cv.posX) > 4050 ||
        Math.abs(cv.posY) > 5100)
    ) {
      const isOrange = (localIdx % 2) === 1;
      const spawnX = isOrange ? 2048 : -2048;
      const spawnY = isOrange ? 2560 : -2560;
      const yaw = isOrange ? -0.75 * Math.PI : 0.25 * Math.PI;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      sim.setCarState?.(localIdx, {
        pos: [spawnX, spawnY, 17.0],
        forward: [cy, sy, 0],
        right: [-sy, cy, 0],
        up: [0, 0, 1],
        vel: [0, 0, 0],
        angVel: [0, 0, 0],
        boost: 100,
        isOnGround: true,
        isDemoed: false,
        hasFlipOrJump: true,
      });
    }
  }

  if (localIdx >= 0 && reconciler.lastLocalControls) {
    sim.setControls?.(localIdx, reconciler.lastLocalControls);
  }
  configureClientLobbyDiagnosticProbes(sim);
}

export function evaluateHistoricalSnapshotDelta(reconciler, authSnap, histSnap, numCars) {
  if (!authSnap || !histSnap || authSnap.length < CAR_BASE_OFFSET || histSnap.length < CAR_BASE_OFFSET) {
    return {
      canCompare: false,
      withinTier1: false,
      exceedsHardSnap: false,
      maxPosDelta: Infinity,
      localPosDelta: Infinity
    };
  }

  const isLobbyDualWorld = Boolean(reconciler.lobbyDualWorldMode);

  const ballPosDelta = isLobbyDualWorld
    ? 0
    : Math.hypot(
        authSnap[BALL_OFFSET + 0] - histSnap[BALL_OFFSET + 0],
        authSnap[BALL_OFFSET + 1] - histSnap[BALL_OFFSET + 1],
        authSnap[BALL_OFFSET + 2] - histSnap[BALL_OFFSET + 2]
      );
  const ballVelDelta = isLobbyDualWorld
    ? 0
    : Math.hypot(
        authSnap[BALL_OFFSET + BALL_VEL_OFFSET + 0] - histSnap[BALL_OFFSET + BALL_VEL_OFFSET + 0],
        authSnap[BALL_OFFSET + BALL_VEL_OFFSET + 1] - histSnap[BALL_OFFSET + BALL_VEL_OFFSET + 1],
        authSnap[BALL_OFFSET + BALL_VEL_OFFSET + 2] - histSnap[BALL_OFFSET + BALL_VEL_OFFSET + 2]
      );

  let maxCarPosDelta = 0;
  let localCarPosDelta = 0;
  let maxCarVelDelta = 0;
  let maxCarRotDelta = 0;
  let maxBoostDelta = 0;
  let discreteMismatch = false;

  const checkCars = Math.min(numCars, 8);
  const hasSlotCheck = typeof reconciler.sim?.isCarSlotActive === 'function';
  for (let c = 0; c < checkCars; c++) {
    if (isLobbyDualWorld && c < 6) continue;
    if (hasSlotCheck && !reconciler.sim.isCarSlotActive(c)) continue;
    const base = CAR_BASE_OFFSET + c * CAR_STRIDE;
    if (authSnap.length < base + 25 || histSnap.length < base + 25) break;

    const posDelta = Math.hypot(
      authSnap[base + 0] - histSnap[base + 0],
      authSnap[base + 1] - histSnap[base + 1],
      authSnap[base + 2] - histSnap[base + 2]
    );
    const velDelta = Math.hypot(
      authSnap[base + 12] - histSnap[base + 12],
      authSnap[base + 13] - histSnap[base + 13],
      authSnap[base + 14] - histSnap[base + 14]
    );
    const rotDelta = Math.hypot(
      authSnap[base + 3] - histSnap[base + 3],
      authSnap[base + 4] - histSnap[base + 4],
      authSnap[base + 5] - histSnap[base + 5]
    ) + Math.hypot(
      authSnap[base + 9] - histSnap[base + 9],
      authSnap[base + 10] - histSnap[base + 10],
      authSnap[base + 11] - histSnap[base + 11]
    );
    const boostDelta = Math.abs(authSnap[base + 18] - histSnap[base + 18]);

    if (c === reconciler.localCarIndex) {
      localCarPosDelta = posDelta;
    }
    if (posDelta > maxCarPosDelta) maxCarPosDelta = posDelta;
    if (velDelta > maxCarVelDelta) maxCarVelDelta = velDelta;
    if (rotDelta > maxCarRotDelta) maxCarRotDelta = rotDelta;
    if (boostDelta > maxBoostDelta) maxBoostDelta = boostDelta;

    // Discrete flags: 21 = DEMOED (>0 respawn timer), 22 = HAS_FLIP_OR_JUMP (flipsRemaining), 24 = IS_FLIPPING, and ext[2] = demoSpawnSelection
    const extOffset = 416 + c * 4 + 2;
    const demoSelMismatch =
      authSnap.length > extOffset &&
      histSnap.length > extOffset &&
      authSnap[base + 21] > 0 &&
      Math.round(authSnap[extOffset]) !== Math.round(histSnap[extOffset]);
    if (
      (authSnap[base + 21] > 0) !== (histSnap[base + 21] > 0) ||
      Math.round(authSnap[base + 22]) !== Math.round(histSnap[base + 22]) ||
      Math.round(authSnap[base + 24]) !== Math.round(histSnap[base + 24]) ||
      demoSelMismatch
    ) {
      discreteMismatch = true;
    }
  }

  if (!discreteMismatch && !isLobbyDualWorld && authSnap.length >= 410 && histSnap.length >= 410) {
    for (let p = 0; p < 34; p++) {
      const padOff = 342 + p * 2;
      if ((authSnap[padOff] > 0.5) !== (histSnap[padOff] > 0.5)) {
        discreteMismatch = true;
        break;
      }
    }
  }

  const maxPosDelta = Math.max(maxCarPosDelta, ballPosDelta);
  const posTol = reconciler.posTolerance ?? 0.5;
  const velTol = reconciler.velTolerance ?? 5.0;
  const rotTol = reconciler.rotTolerance ?? 0.015;
  const ballPosTol = reconciler.ballPosTolerance ?? 1.0;
  const ballVelTol = reconciler.ballVelTolerance ?? 10.0;
  const boostTol = reconciler.boostTolerance ?? 1.0;
  const hardSnapTol = reconciler.hardSnapThreshold ?? 500.0;

  const withinTier1 = !discreteMismatch &&
    maxCarPosDelta <= posTol &&
    ballPosDelta <= ballPosTol &&
    maxCarVelDelta <= velTol &&
    ballVelDelta <= ballVelTol &&
    maxCarRotDelta <= rotTol &&
    maxBoostDelta <= boostTol;

  const exceedsHardSnap = maxPosDelta > hardSnapTol;

  return {
    canCompare: true,
    withinTier1,
    exceedsHardSnap,
    maxPosDelta,
    localPosDelta: isLobbyDualWorld
      ? maxCarPosDelta
      : ((reconciler.localCarIndex >= 0 && reconciler.localCarIndex < checkCars) ? localCarPosDelta : maxCarPosDelta)
  };
}

function stepAndFillVacantTicks(reconciler, fromTick, toTick) {
  const numCars = Math.min(reconciler.sim.numCars, 8);
  const hasSlotCheck = typeof reconciler.sim?.isCarSlotActive === 'function';
  let updatedTick = fromTick;
  const isRedundantEnabled = (reconciler.redundantHistoryCount > 1) || Boolean(reconciler.enableRedundantInputs);
  for (let t = fromTick; t < toTick; t++) {
    const isKickoffMasked = reconciler.kickoffMaskUntilTick > 0 && t < reconciler.kickoffMaskUntilTick;
    const slot = t & reconciler.mask;
    let entry = reconciler.inputHistory[slot];
    if (!entry || entry.tick !== t) {
      entry = { tick: t, cars: new Map() };
      reconciler.inputHistory[slot] = entry;
    }

    let committedLocalCtrl = null;
    for (let c = 0; c < numCars; c++) {
      if (hasSlotCheck && !reconciler.sim.isCarSlotActive(c)) continue;
      if (c === reconciler.localCarIndex) {
        let ctrl;
        if (isKickoffMasked) {
          ctrl = { ...reconciler.neutralControls };
          entry.cars.set(c, ctrl);
        } else if (entry.cars.has(c)) {
          ctrl = { ...entry.cars.get(c) };
        } else {
          ctrl = { ...reconciler.getPreviousCommittedControls(t, c) };
          entry.cars.set(c, ctrl);
        }
        committedLocalCtrl = ctrl;
        reconciler.lastLocalControls = { ...ctrl };
        reconciler.clientInputRingBuffer.record(t, c, ctrl);
        reconciler.sim.setControls(c, ctrl);
      } else {
        const rawRemote = isKickoffMasked
          ? reconciler.neutralControls
          : (entry.cars.has(c)
            ? entry.cars.get(c)
            : (reconciler.lastRemoteControls.get(c) || reconciler.neutralControls));
        const remoteCtrl = rawRemote?.controls ? rawRemote.controls : (rawRemote || reconciler.neutralControls);
        entry.cars.set(c, { ...remoteCtrl });
        reconciler.sim.setControls(c, remoteCtrl);
      }
    }

    reconciler.sim.saveStateSlot(t % 256);
    recordEntryCompactSnapshot(reconciler, entry);
    reconciler.sim.step(1);
    updatedTick = Math.floor(reconciler.sim.getHeaderView().tickCount);

    if (!isRedundantEnabled && typeof reconciler.sendOutboundInputForTick === 'function') {
      reconciler.sendOutboundInputForTick(t, reconciler.localCarIndex, committedLocalCtrl);
    }
  }
  if (isRedundantEnabled && toTick > fromTick && typeof reconciler.sendOutboundInputForTick === 'function') {
    reconciler.sendOutboundInputForTick(toTick - 1, reconciler.localCarIndex);
  }
  return updatedTick;
}

export function modulateReconcilerClockPacing(
  reconciler,
  currentClientTick,
  currentDelta,
  targetDelta,
  nowMs = performance.now()
) {
  let updatedClientTick = currentClientTick;
  const serverTick = currentClientTick - currentDelta;
  const targetClientTick = serverTick + targetDelta;

  if (!reconciler.pacingControllerState) {
    reconciler.pacingControllerState = { initialized: false };
  }

  const effectiveRtt = reconciler._resolveEffectiveRtt();
  const ch = reconciler.channel;
  const isUnimpairedLoopback = Boolean(
    ch?.isLoopback &&
    !((ch?.extraRttMs ?? ((ch?.extraLatencyMs ?? 0) * 2)) > 0) &&
    !(ch?.jitterMs > 0) &&
    !(ch?.packetLossRate > 0) &&
    !ch?.burstDropEnabled
  );
  const isKickoffMasked =
    reconciler.kickoffMaskUntilTick > 0 && currentClientTick < reconciler.kickoffMaskUntilTick;

  const impliedBufferFromTimeline = reconciler.inputBufferTarget + (currentDelta - targetDelta);
  const hasServerBuf =
    Boolean(reconciler._hasServerReportedBuffer) &&
    typeof reconciler.metrics?.inputBufferSize === 'number' &&
    Number.isFinite(reconciler.metrics.inputBufferSize) &&
    serverTick > 4;
  let rawServerBuffer = hasServerBuf
    ? reconciler.metrics.inputBufferSize
    : impliedBufferFromTimeline;

  if (isUnimpairedLoopback) {
    rawServerBuffer = reconciler.inputBufferTarget;
  } else if (isKickoffMasked) {
    rawServerBuffer = Math.max(rawServerBuffer, reconciler.inputBufferTarget);
  }

  const params = reconciler.clockPacingParams || {
    targetBufferTicks: reconciler.inputBufferTarget ?? 3,
    deadbandCatchupOffset: reconciler.catchupThresholdOffset ?? -2,
    deadbandSkipOffset: reconciler.skipThresholdOffset ?? 2,
    rateStepMode: reconciler.clockPacingMode === 'sts' ? 'discrete_2tier' : 'continuous_pd',
    tier1Hz: 1.0,
    tier2Hz: 3.0,
    tier1EnterError: 1.0,
    tier1ExitError: 0.4,
    tier2EnterError: 2.5,
    tier2ExitError: 1.3,
    minDwellTicks: 18,
    kpHzPerTick: 0.85,
    kdHzPerTickVel: 0.35,
    maxAdjustHz: 6.0,
    inFlightCompGain: 0.85,
    rttEwmaAlpha: 0.12,
    bufferEwmaAlpha: 0.25,
    enableAdaptiveJitterBoost: reconciler.clockPacingMode === 'csts' || reconciler.clockPacingMode === 'custom',
    adaptiveJitterGain: 1.25,
    maxAdaptiveBoostTicks: 4.0,
    enableHardResync: true,
    hardResyncThresholdTicks: 10,
    hardResyncCooldownMs: 1000,
  };

  const stepOut = evaluatePacingControllerStep(
    reconciler.pacingControllerState,
    {
      nowMs,
      rawRttMs: effectiveRtt,
      rawServerBuffer,
      packetArrived: true,
    },
    reconciler.clockPacingMode || 'legacy',
    params
  );

  if (isUnimpairedLoopback) {
    stepOut.physicsRateHz = 120.0;
    stepOut.tierState = 0;
    stepOut.tierSwitched = false;
    stepOut.requestHardResync = false;
    stepOut.requestStepCatchup = false;
    stepOut.requestStepSkip = false;
  }

  let stepCatchup = false;
  let stepSkip = false;
  const savedLobbyEntities = saveClientLobbyLocalEntities(reconciler);

  if (reconciler.forceTargetAlign) {
    reconciler.forceTargetAlign = false;
    if (currentDelta > targetDelta) {
      updatedClientTick = Math.max(serverTick, targetClientTick);
      reconciler.sim.restoreStateSlot(updatedClientTick % 256);
      stepSkip = true;
    } else if (currentDelta < targetDelta) {
      updatedClientTick = stepAndFillVacantTicks(reconciler, currentClientTick, targetClientTick);
      stepCatchup = true;
    }
    reconciler.shouldSkipLocalStep = false;
  } else if (reconciler.clockPacingMode === 'legacy') {
    const skipThreshold = targetDelta + reconciler.skipThresholdOffset;
    const catchupThreshold = targetDelta + reconciler.catchupThresholdOffset;
    reconciler.interpolator?.setPhysicsRate?.(120);

    if (currentDelta > skipThreshold) {
      updatedClientTick = Math.max(serverTick, targetClientTick);
      reconciler.sim.restoreStateSlot(updatedClientTick % 256);
      reconciler.shouldSkipLocalStep = false;
      stepSkip = true;
    } else if (currentDelta < catchupThreshold) {
      updatedClientTick = stepAndFillVacantTicks(reconciler, currentClientTick, targetClientTick);
      reconciler.shouldSkipLocalStep = false;
      stepCatchup = true;
    } else {
      reconciler.shouldSkipLocalStep = false;
    }
  } else {
    reconciler.interpolator?.setPhysicsRate?.(stepOut.physicsRateHz);
    reconciler.shouldSkipLocalStep = false;

    const adaptiveBoostRounded = Math.max(
      0,
      Math.round((stepOut.activeTarget || reconciler.inputBufferTarget) - reconciler.inputBufferTarget)
    );
    const boostedTargetClientTick = targetClientTick + adaptiveBoostRounded;

    if (stepOut.requestHardResync) {
      const targetDiff = currentClientTick - boostedTargetClientTick;
      if (targetDiff > 0) {
        updatedClientTick = Math.max(serverTick, boostedTargetClientTick);
        reconciler.sim.restoreStateSlot(updatedClientTick % 256);
        stepSkip = true;
      } else if (targetDiff < 0) {
        updatedClientTick = stepAndFillVacantTicks(reconciler, currentClientTick, boostedTargetClientTick);
        stepCatchup = true;
      }
    } else if (stepOut.requestStepCatchup || currentDelta <= 0) {
      updatedClientTick = stepAndFillVacantTicks(reconciler, currentClientTick, boostedTargetClientTick);
      stepCatchup = true;
    } else if (stepOut.requestStepSkip) {
      updatedClientTick = Math.max(serverTick, boostedTargetClientTick);
      reconciler.sim.restoreStateSlot(updatedClientTick % 256);
      stepSkip = true;
    }
  }

  if (savedLobbyEntities && (stepCatchup || stepSkip)) {
    restoreClientLobbyLocalEntities(reconciler, savedLobbyEntities);
  }

  if (reconciler.metrics) {
    reconciler.metrics.effectiveInputBuffer = Math.round(stepOut.effectiveBuffer * 100) / 100;
    reconciler.metrics.targetInputBuffer = Math.round(stepOut.activeTarget * 100) / 100;
    reconciler.metrics.pacingTier = stepOut.tierState;
    reconciler.metrics.physicsRateHz = stepOut.physicsRateHz;
    reconciler.metrics.smoothRttMs = Math.round(stepOut.smoothRttMs * 10) / 10;
    reconciler.metrics.measuredJitterMs = Math.round(stepOut.jitterMs * 10) / 10;
    if (!hasServerBuf) {
      reconciler.metrics.inputBufferSize = Math.max(-64, Math.min(63, Math.round(rawServerBuffer)));
    }
  }

  reconciler._lastPacingStepStatus = {
    stepOut,
    rawServerBuffer,
    stepCatchup,
    stepSkip,
    nowMs,
  };

  return updatedClientTick;
}

export function replayAndEvaluateCorrection(reconciler, packet, serverTick, currentClientTick, prePositions, numCars) {
  reconciler.sim.saveStateSlot?.(currentClientTick % 256);
  const currentSlot = currentClientTick & reconciler.mask;
  let currentEntry = reconciler.inputHistory[currentSlot];
  if (!currentEntry || currentEntry.tick !== currentClientTick) {
    currentEntry = { tick: currentClientTick, cars: new Map() };
    reconciler.inputHistory[currentSlot] = currentEntry;
  }
  recordEntryCompactSnapshot(reconciler, currentEntry);

  // Check historical compact state snapshot at serverTick for 3-Tier Tolerance evaluation
  const serverSlot = serverTick & reconciler.mask;
  const serverEntry = reconciler.inputHistory[serverSlot];
  const histSnap = (serverEntry && serverEntry.tick === serverTick) ? serverEntry.stateSnapshot : null;
  const evalResult = evaluateHistoricalSnapshotDelta(reconciler, packet.stateSnapshot, histSnap, numCars);

  if (evalResult.canCompare) {
    reconciler.metrics.historicalPosDelta = evalResult.localPosDelta;

    // Tier 1 (Deadband No-Op): Historical delta is within tolerance -> skip rollback & resimulation completely
    if (evalResult.withinTier1) {
      reconciler.skippedCorrections = (reconciler.skippedCorrections || 0) + 1;
      reconciler.metrics.skippedCorrections = reconciler.skippedCorrections;
      reconciler.metrics.reconcileTier = 1;
      reconciler.metrics.lastCorrectionDelta = evalResult.localPosDelta;
      reconciler.metrics.localCorrectionDelta = evalResult.localPosDelta || 0;
      reconciler.metrics.ballCorrectionDelta = 0;
      reconciler.metrics.remoteCorrectionDelta = 0;
      reconciler.metrics.probeCorrectionDelta = 0;
      reconciler.metrics.smoothingMagnitude = Math.hypot(
        reconciler.visualSmoothingOffset.x,
        reconciler.visualSmoothingOffset.y,
        reconciler.visualSmoothingOffset.z
      );
      return;
    }
  }

  const isTier3HistoricalHardSnap = Boolean(evalResult.canCompare && evalResult.exceedsHardSnap);
  const savedLobbyEntities = saveClientLobbyLocalEntities(reconciler);

  // Tier 2 (Rollback + Resimulate + Micro-Snap) & Tier 3 (Hard Snap)
  if (serverTick < currentClientTick && (currentClientTick - serverTick) < 256) {
    reconciler.sim.restoreStateSlot?.(serverTick % 256);
  }
  reconciler.sim.restoreState(packet.stateSnapshot);
  if (reconciler.lobbyDualWorldMode) {
    configureClientLobbyDiagnosticProbes(reconciler.sim);
  }

  for (let t = Math.max(0, serverTick - 16); t < serverTick; t++) {
    if (!reconciler.clientInputRingBuffer.get(t)) {
      const prevCtrl = (reconciler.kickoffMaskUntilTick > 0 && t < reconciler.kickoffMaskUntilTick)
        ? { ...reconciler.neutralControls }
        : reconciler.getPreviousCommittedControls(t, reconciler.localCarIndex);
      reconciler.clientInputRingBuffer.record(t, reconciler.localCarIndex, prevCtrl);
    }
  }

  const hasSlotCheck = typeof reconciler.sim?.isCarSlotActive === 'function';
  for (let t = serverTick; t < currentClientTick; t++) {
    const isKickoffMasked = reconciler.kickoffMaskUntilTick > 0 && t < reconciler.kickoffMaskUntilTick;
    const slot = t & reconciler.mask;
    let entry = reconciler.inputHistory[slot];
    if (!entry || entry.tick !== t) {
      entry = { tick: t, cars: new Map() };
      reconciler.inputHistory[slot] = entry;
    }

    for (let c = 0; c < numCars; c++) {
      if (hasSlotCheck && !reconciler.sim.isCarSlotActive(c)) continue;
      if (c === reconciler.localCarIndex) {
        let ctrl;
        if (isKickoffMasked) {
          ctrl = { ...reconciler.neutralControls };
          entry.cars.set(c, ctrl);
        } else if (entry.cars.has(c)) {
          ctrl = entry.cars.get(c);
        } else {
          ctrl = { ...reconciler.getPreviousCommittedControls(t, c) };
          entry.cars.set(c, ctrl);
        }
        reconciler.sim.setControls(c, ctrl);
        reconciler.clientInputRingBuffer.record(t, c, ctrl);
      } else {
        const rawRemote = isKickoffMasked
          ? reconciler.neutralControls
          : (reconciler.lastRemoteControls.get(c)
            || (entry.cars.has(c) ? entry.cars.get(c) : reconciler.neutralControls));
        const remoteCtrl = rawRemote?.controls ? rawRemote.controls : (rawRemote || reconciler.neutralControls);
        entry.cars.set(c, { ...remoteCtrl });
        reconciler.sim.setControls(c, remoteCtrl);
      }
    }

    reconciler.sim.saveStateSlot(t % 256);
    recordEntryCompactSnapshot(reconciler, entry);
    reconciler.sim.stepSilent(1);
  }

  if (savedLobbyEntities) {
    restoreClientLobbyLocalEntities(reconciler, savedLobbyEntities);
  }

  reconciler.sim.saveStateSlot(currentClientTick % 256);
  recordEntryCompactSnapshot(reconciler, currentEntry);

  let maxDelta = 0;
  let localDelta = 0;
  let remoteMaxDelta = 0;
  let probeMaxDelta = 0;
  let ballDelta = 0;
  for (let c = 0; c < numCars; c++) {
    if (reconciler.lobbyDualWorldMode && c < 6) continue;
    if (hasSlotCheck && !reconciler.sim.isCarSlotActive(c)) continue;
    const postCar = reconciler.sim.getCarStateView(c);
    const carDelta = Math.hypot(
      prePositions[c].x - postCar.posX,
      prePositions[c].y - postCar.posY,
      prePositions[c].z - postCar.posZ
    );
    if (c === reconciler.localCarIndex) {
      localDelta = carDelta;
    } else if (isDiagnosticProbeSlot(c)) {
      if (carDelta > probeMaxDelta) probeMaxDelta = carDelta;
    } else {
      if (carDelta > remoteMaxDelta) remoteMaxDelta = carDelta;
    }
    if (carDelta > maxDelta) {
      maxDelta = carDelta;
    }
  }
  if (!reconciler.lobbyDualWorldMode && prePositions.ball && typeof reconciler.sim.getBallStateView === 'function') {
    const postBall = reconciler.sim.getBallStateView();
    if (postBall) {
      ballDelta = Math.hypot(
        prePositions.ball.x - postBall.posX,
        prePositions.ball.y - postBall.posY,
        prePositions.ball.z - postBall.posZ
      );
      if (ballDelta > maxDelta) {
        maxDelta = ballDelta;
      }
    }
  }

  reconciler.metrics.localCorrectionDelta = localDelta;
  reconciler.metrics.ballCorrectionDelta = ballDelta;
  reconciler.metrics.remoteCorrectionDelta = remoteMaxDelta;
  reconciler.metrics.probeCorrectionDelta = probeMaxDelta;

  const delta = reconciler.lobbyDualWorldMode
    ? maxDelta
    : ((reconciler.localCarIndex >= 0 && reconciler.localCarIndex < numCars) ? localDelta : maxDelta);
  const hardSnapTol = reconciler.hardSnapThreshold ?? 500.0;
  const isTier3HardSnap = isTier3HistoricalHardSnap || maxDelta > hardSnapTol;

  reconciler.metrics.reconcileTier = isTier3HardSnap ? 3 : 2;
  if (isTier3HardSnap) {
    reconciler.hardSnapCount = (reconciler.hardSnapCount || 0) + 1;
    reconciler.metrics.hardSnapCount = reconciler.hardSnapCount;
    reconciler.visualSmoothingOffset.x = 0;
    reconciler.visualSmoothingOffset.y = 0;
    reconciler.visualSmoothingOffset.z = 0;
  }

  const effectiveDelta = Math.max(delta, maxDelta);
  reconciler.metrics.lastCorrectionDelta = effectiveDelta;
  if (effectiveDelta > 0.05) {
    reconciler.totalCorrections++;
    reconciler.metrics.totalCorrections = reconciler.totalCorrections;
    if (effectiveDelta > reconciler.maxCorrectionDelta) {
      reconciler.maxCorrectionDelta = effectiveDelta;
      reconciler.metrics.maxCorrectionDelta = effectiveDelta;
    }

    if (reconciler.enableSmoothing && !isTier3HardSnap && !reconciler.lobbyDualWorldMode) {
      const postCar0 = reconciler.sim.getCarStateView(reconciler.localCarIndex);
      reconciler.visualSmoothingOffset.x += (prePositions[reconciler.localCarIndex].x - postCar0.posX);
      reconciler.visualSmoothingOffset.y += (prePositions[reconciler.localCarIndex].y - postCar0.posY);
      reconciler.visualSmoothingOffset.z += (prePositions[reconciler.localCarIndex].z - postCar0.posZ);

      const maxOffset = 300.0;
      const currentOffsetLen = Math.hypot(
        reconciler.visualSmoothingOffset.x,
        reconciler.visualSmoothingOffset.y,
        reconciler.visualSmoothingOffset.z
      );
      if (currentOffsetLen > maxOffset) {
        const factor = maxOffset / currentOffsetLen;
        reconciler.visualSmoothingOffset.x *= factor;
        reconciler.visualSmoothingOffset.y *= factor;
        reconciler.visualSmoothingOffset.z *= factor;
      }
    }
  } else {
    reconciler.metrics.lastCorrectionDelta = delta;
  }

  reconciler.metrics.smoothingMagnitude = Math.hypot(
    reconciler.visualSmoothingOffset.x,
    reconciler.visualSmoothingOffset.y,
    reconciler.visualSmoothingOffset.z
  );
}

export function syncReconcilerTimeline(reconciler, serverSnapshot, serverTick = 0, nowMs = performance.now()) {
  const savedLobbyEntities = saveClientLobbyLocalEntities(reconciler);
  if (serverSnapshot) {
    reconciler.sim.restoreState(serverSnapshot);
  }
  if (reconciler.lobbyDualWorldMode) {
    configureClientLobbyDiagnosticProbes(reconciler.sim);
  }
  reconciler.lastServerRecordedInputTick = serverTick - 1;
  const effectiveRtt = reconciler._resolveEffectiveRtt();
  reconciler.leadTicks = reconciler.calculateLeadTicks(effectiveRtt);
  const oneWayTicks = typeof reconciler.calculateDownlinkTicks === 'function'
    ? reconciler.calculateDownlinkTicks(effectiveRtt)
    : (effectiveRtt <= 2 ? 0 : Math.max(1, Math.min(64, Math.ceil(effectiveRtt * 0.5 / reconciler.tickDtMs))));
  const targetDelta = reconciler.leadTicks + oneWayTicks;

  for (let t = Math.max(0, serverTick - 16); t < serverTick; t++) {
    if (!reconciler.clientInputRingBuffer.get(t)) {
      const prevCtrl = (reconciler.kickoffMaskUntilTick > 0 && t < reconciler.kickoffMaskUntilTick)
        ? { ...reconciler.neutralControls }
        : reconciler.getPreviousCommittedControls(t, reconciler.localCarIndex);
      reconciler.clientInputRingBuffer.record(t, reconciler.localCarIndex, prevCtrl);
    }
  }

  const numCars = Math.min(reconciler.sim.numCars, 8);
  const hasSlotCheck = typeof reconciler.sim?.isCarSlotActive === 'function';
  const isRedundantEnabled = (reconciler.redundantHistoryCount > 1) || Boolean(reconciler.enableRedundantInputs);
  for (let t = serverTick; t < serverTick + targetDelta; t++) {
    const isKickoffMasked = reconciler.kickoffMaskUntilTick > 0 && t < reconciler.kickoffMaskUntilTick;
    const slot = t & reconciler.mask;
    let entry = reconciler.inputHistory[slot];
    if (!entry || entry.tick !== t) {
      entry = { tick: t, cars: new Map() };
      reconciler.inputHistory[slot] = entry;
    }

    let committedLocalCtrl = null;
    for (let c = 0; c < numCars; c++) {
      if (hasSlotCheck && !reconciler.sim.isCarSlotActive(c)) continue;
      if (c === reconciler.localCarIndex) {
        let ctrl;
        if (isKickoffMasked) {
          ctrl = { ...reconciler.neutralControls };
          entry.cars.set(c, ctrl);
        } else if (entry.cars.has(c)) {
          ctrl = { ...entry.cars.get(c) };
        } else {
          ctrl = { ...reconciler.getPreviousCommittedControls(t, c) };
          entry.cars.set(c, ctrl);
        }
        committedLocalCtrl = ctrl;
        reconciler.lastLocalControls = { ...ctrl };
        reconciler.clientInputRingBuffer.record(t, c, ctrl);
        reconciler.sim.setControls(c, ctrl);
      } else {
        const rawRemote = isKickoffMasked
          ? reconciler.neutralControls
          : (entry.cars.has(c)
            ? entry.cars.get(c)
            : (reconciler.lastRemoteControls.get(c) || reconciler.neutralControls));
        const remoteCtrl = rawRemote?.controls ? rawRemote.controls : (rawRemote || reconciler.neutralControls);
        entry.cars.set(c, { ...remoteCtrl });
        reconciler.sim.setControls(c, remoteCtrl);
      }
    }

    reconciler.sim.saveStateSlot(t % 256);
    recordEntryCompactSnapshot(reconciler, entry);
    reconciler.sim.stepSilent(1);

    if (!isRedundantEnabled) {
      reconciler.sendOutboundInputForTick(t, reconciler.localCarIndex, committedLocalCtrl, nowMs);
    }
  }
  if (isRedundantEnabled && targetDelta > 0) {
    reconciler.sendOutboundInputForTick(serverTick + targetDelta - 1, reconciler.localCarIndex, null, nowMs);
  }

  if (savedLobbyEntities) {
    restoreClientLobbyLocalEntities(reconciler, savedLobbyEntities);
  }

  const currentClientTick = Math.floor(reconciler.sim.getHeaderView().tickCount);
  reconciler.lastAckedServerTick = serverTick;
  reconciler.isTimelineSynchronized = true;
  reconciler.shouldSkipLocalStep = false;
  reconciler.lastHardResyncTime = nowMs;
  reconciler.hardSnapCount = (reconciler.hardSnapCount || 0) + 1;
  reconciler.visualSmoothingOffset = { x: 0, y: 0, z: 0 };

  reconciler.sim.saveStateSlot(currentClientTick % 256);
  const currentSlot = currentClientTick & reconciler.mask;
  let currentEntry = reconciler.inputHistory[currentSlot];
  if (!currentEntry || currentEntry.tick !== currentClientTick) {
    currentEntry = { tick: currentClientTick, cars: new Map() };
    reconciler.inputHistory[currentSlot] = currentEntry;
  }
  recordEntryCompactSnapshot(reconciler, currentEntry);

  reconciler.metrics.reconcileTier = 3;
  reconciler.metrics.hardSnapCount = reconciler.hardSnapCount;
  reconciler.metrics.clientTick = currentClientTick;
  reconciler.metrics.serverTick = serverTick;
  reconciler.metrics.leadTicks = reconciler.leadTicks;
  reconciler.notifyMetricsUpdated();
}

