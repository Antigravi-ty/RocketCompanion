/**
 * KickoffTrainingPhysicsHelper.js
 * Spawn setup, suspension settling, and realistic/instant/easy-learning episode reset
 * helpers for KickoffTrainingMode.
 */

import { MATCH_SIGNALS } from '../../physics/RocketSimConstants.js';
import {
  KICKOFF_SPAWNS,
  CPP_SPAWN_INDEX_MAP,
  getSameSidePartnerSpawnIndex,
  makeKickoffRawCarState,
  multiDiscreteToOverlayKeys,
  multiDiscreteToKeyString,
} from '../../ai/KickoffPPOAgent.js';
import { KICKOFF_V1_SETTLE_TICKS } from '../../ai/KickoffV2SafeTensorsAgent.js';
import { hudStore } from '../../ui-core/stores/hudStore';
import { useKickoffTrainingStore } from '../../ui-core/stores/kickoffTrainingStore';

export function clampSettledKickoffCar(mode, carIdx, spawn, teamSign = 1, preSettleState = null) {
  const r = mode.runtime;
  if (!r.physics || carIdx >= r.physics.numCars) return;
  const settled = new Float32Array(r.physics.getCarState(carIdx));
  if (preSettleState && preSettleState.length >= 12) {
    settled[0] = preSettleState[0];
    settled[1] = preSettleState[1];
    for (let k = 3; k <= 11; k++) settled[k] = preSettleState[k];
  } else if (Math.abs(spawn.x) < 500.0) {
    settled[0] = spawn.x * teamSign;
    settled[3] = 0.0;
    settled[4] = 1.0 * teamSign;
    settled[6] = -1.0 * teamSign;
    settled[7] = 0.0;
    settled[8] = 0.0;
    settled[9] = 0.0;
  }
  for (let k = 12; k <= 17; k++) settled[k] = 0.0;
  r.physics.setCarState(carIdx, settled);
}

export function clampSettledKickoffPlayerCar(mode, spawn) {
  const r = mode.runtime;
  const carIdx = r.playerCarIndex ?? 0;
  clampSettledKickoffCar(mode, carIdx, spawn, 1, mode.preSettleCar0State);
  if (!mode.ghostModeEnabled && r.physics?.numCars >= 2) {
    if (mode.ghostPlacement === 'opposite') {
      const s0 = new Float32Array(r.physics.getCarState(carIdx));
      const s1 = new Float32Array(r.physics.getCarState(1));
      s1[0] = -s0[0];
      s1[1] = -s0[1];
      s1[2] = s0[2];
      s1[3] = -s0[3];
      s1[4] = -s0[4];
      s1[5] = s0[5];
      s1[6] = -s0[6];
      s1[7] = -s0[7];
      s1[8] = s0[8];
      s1[9] = -s0[9];
      s1[10] = -s0[10];
      s1[11] = s0[11];
      for (let k = 12; k <= 17; k++) s1[k] = 0.0;
      r.physics.setCarState(1, s1);
    } else {
      const partnerIdx = getSameSidePartnerSpawnIndex(mode.spawnIndex) ?? 4;
      const partnerSpawn = KICKOFF_SPAWNS[partnerIdx] || KICKOFF_SPAWNS[4];
      clampSettledKickoffCar(mode, 1, partnerSpawn, 1, mode.preSettleCar1State);
    }
  }
}

export function resetPlayerCarToKickoffSpawn(mode, spawnIndex, settleImmediate = true) {
  const r = mode.runtime;
  if (!r.physics) return;

  const spawn = KICKOFF_SPAWNS[spawnIndex] || KICKOFF_SPAWNS[0];
  const cppSpawnIdx = CPP_SPAWN_INDEX_MAP[spawnIndex] ?? 0;
  const carIdx = r.playerCarIndex ?? 0;
  const hitboxType = r.selectedHitbox || 'default';

  r.physics.setUnlimitedBoost(false);

  while (r.physics.numCars > 0 && typeof r.physics.removeCar === 'function') {
    r.physics.removeCar(r.physics.numCars - 1);
  }
  r.physics.addCar(0, hitboxType);

  mode.ghostAgent?.reset?.();
  mode.solidAgent?.reset?.();
  mode.preSettleCar0State = null;
  mode.preSettleCar1State = null;

  if (!mode.ghostModeEnabled) {
    r.arena?.ensureOpponent?.();

    if (mode.ghostPlacement === 'opposite') {
      r.physics.addCar(1, 'default');
      mode.aiTeamSign = -1;
      r.arena?.setCarColor?.(1, 0xf97316);

      if (typeof r.physics.resetKickoffAtSpawn === 'function') {
        r.physics.resetKickoffAtSpawn(cppSpawnIdx, 0);
        mode.preSettleCar0State = new Float32Array(r.physics.getCarState(0));
        if (settleImmediate) {
          r.physics.resetKickoffAtSpawn(cppSpawnIdx, KICKOFF_V1_SETTLE_TICKS);
          clampSettledKickoffPlayerCar(mode, spawn);
        }
      } else {
        r.physics.resetKickoff(-1);
        const raw0 = makeKickoffRawCarState(spawn.x, spawn.y);
        r.physics.setCarState(0, raw0);
        mode.preSettleCar0State = new Float32Array(raw0);
        if (settleImmediate) {
          r.physics.stepSilent(KICKOFF_V1_SETTLE_TICKS);
          clampSettledKickoffPlayerCar(mode, spawn);
        }
      }
      r.physics.setControls(0, r.neutralControls);
      r.physics.setControls(1, r.neutralControls);
    } else {
      const partnerIdx = getSameSidePartnerSpawnIndex(spawnIndex) ?? 4;
      const partnerSpawn = KICKOFF_SPAWNS[partnerIdx] || KICKOFF_SPAWNS[4];
      r.physics.addCar(0, 'default');
      mode.aiTeamSign = 1;
      r.arena?.setCarColor?.(1, 0x38bdf8);

      if (typeof r.physics.resetKickoffAtSpawn === 'function') {
        r.physics.resetKickoffAtSpawn(cppSpawnIdx, 0);
      } else {
        r.physics.resetKickoff(-1);
        r.physics.setCarState(0, makeKickoffRawCarState(spawn.x, spawn.y));
      }
      r.physics.setCarState(1, makeKickoffRawCarState(partnerSpawn.x, partnerSpawn.y));
      mode.preSettleCar0State = new Float32Array(r.physics.getCarState(0));
      mode.preSettleCar1State = new Float32Array(r.physics.getCarState(1));
      r.physics.setControls(0, r.neutralControls);
      r.physics.setControls(1, r.neutralControls);

      if (settleImmediate) {
        r.physics.stepSilent(KICKOFF_V1_SETTLE_TICKS);
        clampSettledKickoffCar(mode, 0, spawn, 1, mode.preSettleCar0State);
        clampSettledKickoffCar(mode, 1, partnerSpawn, 1, mode.preSettleCar1State);
      }
    }
  } else {
    if (r.arena?.cars?.[1]) {
      r.arena.cars[1].visible = false;
    }
    if (typeof r.physics.resetKickoffAtSpawn === 'function') {
      r.physics.resetKickoffAtSpawn(cppSpawnIdx, 0);
      mode.preSettleCar0State = new Float32Array(r.physics.getCarState(carIdx));
      if (settleImmediate) {
        r.physics.resetKickoffAtSpawn(cppSpawnIdx, KICKOFF_V1_SETTLE_TICKS);
        clampSettledKickoffCar(mode, carIdx, spawn, 1, mode.preSettleCar0State);
      }
      r.physics.setControls(carIdx, r.neutralControls);
    } else {
      r.physics.resetKickoff(-1);
      const rawState = makeKickoffRawCarState(spawn.x, spawn.y);
      r.physics.setCarState(carIdx, rawState);
      mode.preSettleCar0State = new Float32Array(rawState);
      r.physics.setControls(carIdx, r.neutralControls);

      if (settleImmediate) {
        r.physics.stepSilent(KICKOFF_V1_SETTLE_TICKS);
        clampSettledKickoffCar(mode, carIdx, spawn, 1, mode.preSettleCar0State);
      }
    }
  }

  r.botControls = { ...r.neutralControls };
  r.physics.clearEvents();
  r.ballTrajectoryPredictor?.clear?.();
  r.audioSubsystem?.resetAudio?.();
  r.arena?.resetBallTrail?.();
  r.camera?.resetView?.();
  r.interpolator?.sync?.();
}

export function resetKickoffTrainingEpisode(mode, spawnIndex = mode.spawnIndex) {
  const r = mode.runtime;
  const store = useKickoffTrainingStore.getState();
  mode.subMode = store.subMode || 'instant';
  mode.ghostPlacement = store.ghostPlacement || 'same';
  mode.ghostModeEnabled = store.ghostModeEnabled ?? true;
  mode.episodeTick = 0;
  mode.playerTouchedBall = false;
  mode.playerTouchTick = null;
  mode.postTouchResetTimer = 0;
  mode.goalResetTicksRemaining = 0;
  mode.currentGhostRawControls = { ...r.neutralControls };
  mode.currentGhostControls = { ...r.neutralControls };
  r.botControls = { ...r.neutralControls };

  if (mode.ghostSim?.isInitialized) {
    mode.timeline = mode.ghostAgent.precomputeTimeline(mode.ghostSim, spawnIndex, 95);
    mode.aiTouchTick = mode.timeline.touchTick;
    mode.ghostPrevState.set(mode.ghostSim.state);
    mode.ghostCurrState.set(mode.ghostSim.state);
  }

  if (mode.ghostVisuals) {
    mode.ghostVisuals.setGhostPlacement(mode.ghostPlacement);
    mode.ghostVisuals.setVisible(mode.ghostModeEnabled);
    mode.ghostVisuals.resetTrail();
  }

  if (mode.subMode === 'realistic') {
    const waitTicks = store.realisticWaitTicks || 480;
    mode.phase = 'countdown';
    mode.countdownTicksRemaining = waitTicks;
    mode.countdownElapsedTicks = 0;
    mode.latchedCountdownSeconds.clear();

    resetPlayerCarToKickoffSpawn(mode, spawnIndex, false);
    r.physics?.setSimulationFrozen?.(false, 0, true);

    const curTick = Math.floor(r.physics?.getHeaderView?.()?.tickCount ?? 0);
    const targetTick = curTick + waitTicks;
    r.physics?.pushSignalEvent?.(
      MATCH_SIGNALS.KICKOFF_WILL_START,
      curTick,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      targetTick
    );

    const displaySec = Math.min(4, Math.ceil(waitTicks / 120));
    if (r.match) {
      r.match.state.phase = 'kickoff';
      r.match.state.countdown = displaySec;
    }
    hudStore.getState().setMatchState({
      matchPhase: 'kickoff',
      kickoffCountdown: displaySec,
    });
  } else {
    resetPlayerCarToKickoffSpawn(mode, spawnIndex, true);
    mode.phase = 'waiting-for-input';
    mode.countdownTicksRemaining = 0;

    r.physics?.setSimulationFrozen?.(true, 0, true);

    if (r.match) {
      r.match.state.phase = 'playing';
      r.match.state.countdown = 0;
    }
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      kickoffCountdown: 0,
    });
  }

  const firstStep = mode.timeline?.steps?.[0];
  const reqAct = firstStep ? firstStep.action : [2, 1, 1, 0, 1, 0];
  store.updateLiveState({
    phase: mode.phase,
    episodeTick: 0,
    decisionStep: 0,
    countdownRemainingTicks: mode.countdownTicksRemaining,
    requiredAction: reqAct,
    requiredKeys: multiDiscreteToOverlayKeys(reqAct),
    requiredKeyStr: multiDiscreteToKeyString(reqAct),
    timeline: mode.timeline,
    aiTouchTick: mode.aiTouchTick,
    playerTouchTick: null,
    lastDeltaTicks: null,
    isInputMatching: true,
  });
}
