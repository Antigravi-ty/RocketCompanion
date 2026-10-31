/**
 * SubsystemIsolationLabIncidentMatchHelper.js
 * Extracted Bench 4 (90s Incident, Overtime, Kickoff Countdown & Possession Match Sandbox)
 * logic for SubsystemIsolationLabMode.
 *
 * Features:
 * - 3-2-1-Go Kickoff Countdown (360 ticks @ 120Hz) with car lock and audio cues
 * - Full match audio cues (sfx_goal_poof, match_60_seconds_left, match_30_seconds_left,
 *   match_countdown_10s, match_entering_overtime, endgame)
 * - Persistent Possession Score across goals (reset only on new match start)
 * - Speed multiplier (100%, 200%, 300%, 400%, 500%)
 * - Live switching between Manual Control vs Nexto AI Bot Control, and Blue (Car 0) vs Orange (Car 1)
 */

import {
  DEFAULT_CAR_CONTROLS,
  ExperimentalBotAgent,
  ensureExperimentalEngine,
  multiCarHeuristicDecide,
} from '../../../ai/experimental/ExperimentalBotAgent.js';
import { parkDevTestLabProbes } from './SubsystemIsolationLabProbesHelper.js';
import { enterPodiumInTestLab, exitPodiumInTestLab } from './SubsystemIsolationLabGoalReplayScenarios.js';
import { useSubsystemIsolationLabStore } from '../../../ui-core/stores/subsystemIsolationLabStore';
import { hudStore } from '../../../ui-core/stores/hudStore';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.js';

const KICKOFF_COUNTDOWN_TICKS = 360; // 3.0s @ 120Hz
const INCIDENT_ACTIVE_CARS = Object.freeze([
  { carIndex: 0, team: 0 },
  { carIndex: 1, team: 1 },
]);

function getAudio(runtime) {
  return runtime?.options?.gameAudio || gameAudio;
}

export async function ensureIncidentBotsLoaded(mode) {
  if (!mode.botBlue) {
    mode.botBlue = new ExperimentalBotAgent('nexto', 0, 0);
  }
  if (!mode.botOrange) {
    mode.botOrange = new ExperimentalBotAgent('nexto', 1, 1);
  }
  await ensureExperimentalEngine('nexto');
}

export function resetIncidentBotEpoch(mode) {
  mode.botDecisionEpoch++;
  mode.botBlue?.reset();
  mode.botOrange?.reset();
  mode.botBlueControls = { ...DEFAULT_CAR_CONTROLS };
  mode.botOrangeControls = { ...DEFAULT_CAR_CONTROLS };
  mode.botBlueTickSkip = 0;
  mode.botOrangeTickSkip = 0;
  mode.botBlueDeciding = false;
  mode.botOrangeDeciding = false;
  mode.incidentKickoffStep = 0;
}

export function applyIncidentControlledCar(mode, carIdx = 0) {
  const r = mode.runtime;
  if (!r) return;
  const targetIdx = carIdx === 1 ? 1 : 0;
  r.playerCarIndex = targetIdx;
  if (r.arena) {
    r.arena.playerCarIndex = targetIdx;
  }
}

export function applyIncidentSpeedMultiplier(mode, multiplierPct = 100) {
  const r = mode.runtime;
  if (!r?.interpolator) return;
  const mult = Math.max(100, Math.min(500, Number(multiplierPct) || 100));
  const targetRate = Math.round(120 * (mult / 100));
  r.interpolator.setTrainingPhysicsRate?.(targetRate);
}

export function beginIncidentKickoffCountdown(mode, store) {
  const r = mode.runtime;
  const audio = getAudio(r);
  mode.incidentCountdownTicks = KICKOFF_COUNTDOWN_TICKS;
  mode.incidentClockStarted = false;
  mode.incidentTicksSinceKickoff = 0;
  mode.incidentClockTickAccum = 0;
  mode.incidentPhase = 'kickoff (3)';
  if (r?.match?.state) {
    r.match.state.phase = 'kickoff';
    r.match.state.countdown = 3;
  }
  audio?.play?.('match_countdown_321', 1.0);
  store.updateLiveTelemetry({
    incidentClockStarted: false,
    incidentTicksSinceKickoff: 0,
    incidentKickoffCountdownSec: 3,
    incidentPhase: mode.incidentPhase,
  });
  hudStore.getState().setMatchState({
    matchPhase: 'kickoff',
    kickoffCountdown: 3,
  });
}

export async function startIncidentMatchSession(mode, opponentMode = 'stationary') {
  const r = mode.runtime;
  if (!r?.physics) return;
  const epoch = mode._tabSwitchEpoch;

  if (mode.podiumController?.isActive) {
    exitPodiumInTestLab(mode);
  }

  parkDevTestLabProbes(r.physics, r.arena);
  mode.probeState = null;
  if (mode.ghostVisuals) {
    mode.ghostVisuals.setVisible(false);
  }

  await r.arena?.ensureOpponent?.();
  if (mode._tabSwitchEpoch !== epoch || useSubsystemIsolationLabStore.getState().activeTab !== 'incident-match') {
    return;
  }

  const store = useSubsystemIsolationLabStore.getState();

  while (r.physics.numCars > 0 && typeof r.physics.removeCar === 'function') {
    r.physics.removeCar(r.physics.numCars - 1);
  }
  r.physics.addCar(0, 'octane');
  r.physics.addCar(1, 'octane');

  if (r.arena?.cars) {
    if (r.arena.cars[0]) {
      r.arena.cars[0].visible = true;
      r.arena.setCarTeam?.(0, 0);
    }
    if (r.arena.cars[1]) {
      r.arena.cars[1].visible = true;
      r.arena.setCarTeam?.(1, 1);
    }
    for (let i = 2; i < r.arena.cars.length; i++) {
      if (r.arena.cars[i]) r.arena.cars[i].visible = false;
    }
  }

  applyIncidentControlledCar(mode, store.incidentControlledCar ?? 0);
  applyIncidentSpeedMultiplier(mode, store.incidentSpeedMultiplier ?? 100);

  r.physics.setUnlimitedBoost(false);
  r.physics.setPossessionReportingEnabled?.(true);
  r.physics.resetPossessionStats?.();
  r.physics.resetGoalLatch?.();
  r.physics.resetKickoff(0, false);
  r.physics.clearEvents?.();
  r.simulationStage?.resetActionStates?.();
  r.arena?.resetAllCarEffects?.();
  r.resetAudio?.();
  r.interpolator?.sync?.();

  resetIncidentBotEpoch(mode);
  if (opponentMode === 'nexto') {
    ensureIncidentBotsLoaded(mode);
  }

  mode.incidentPauseResumeTicks = 0;
  mode.incidentGoalResetTicks = 0;
  mode.incidentRemainingSec = 90;
  mode.incidentOvertime = false;
  mode.incidentBlueScore = 0;
  mode.incidentOrangeScore = 0;
  mode.incidentLatched10s = -1;

  store.updateLiveTelemetry({
    incidentMatchActive: true,
    incidentOpponentMode: opponentMode,
    incidentBlueScore: 0,
    incidentOrangeScore: 0,
    incidentRemainingSec: 90,
    incidentOvertime: false,
    incidentPossessionTeam: 0,
    incidentPossessionBluePts: 0,
    incidentPossessionOrangePts: 0,
  });

  hudStore.getState().setMatchState({
    blueScore: 0,
    orangeScore: 0,
    remainingSeconds: 90,
    isOvertime: false,
    overtimeSeconds: 0,
  });

  beginIncidentKickoffCountdown(mode, store);
}

export function handleIncidentControlModeSwitch(mode, nextOpponentMode) {
  const store = useSubsystemIsolationLabStore.getState();
  if (!store.incidentMatchActive) {
    startIncidentMatchSession(mode, nextOpponentMode);
    return;
  }
  resetIncidentBotEpoch(mode);
  if (nextOpponentMode === 'nexto') {
    ensureIncidentBotsLoaded(mode);
  }
  store.updateLiveTelemetry({
    incidentOpponentMode: nextOpponentMode,
  });
}

export function triggerIncidentSandboxAction(mode, action) {
  const r = mode.runtime;
  const store = useSubsystemIsolationLabStore.getState();
  const audio = getAudio(r);
  if (!r?.physics) return;

  if (!store.incidentMatchActive) {
    startIncidentMatchSession(mode, store.incidentOpponentMode);
  }

  switch (action) {
    case 'score_blue': {
      r.physics.setBallState({
        pos: [0, 5050, 200],
        vel: [0, 1200, 0],
        angVel: [0, 0, 0],
      });
      break;
    }
    case 'score_orange': {
      r.physics.setBallState({
        pos: [0, -5050, 200],
        vel: [0, -1200, 0],
        angVel: [0, 0, 0],
      });
      break;
    }
    case 'force_overtime': {
      const tiedScore = Math.max(mode.incidentBlueScore, mode.incidentOrangeScore, 1);
      r.physics.resetKickoff(0, true);
      r.interpolator?.sync?.();
      resetIncidentBotEpoch(mode);
      mode.incidentBlueScore = tiedScore;
      mode.incidentOrangeScore = tiedScore;
      mode.incidentRemainingSec = 0;
      mode.incidentOvertime = true;
      audio?.play?.('match_entering_overtime', 1.0, 10000);
      store.updateLiveTelemetry({
        incidentBlueScore: tiedScore,
        incidentOrangeScore: tiedScore,
        incidentRemainingSec: 0,
        incidentOvertime: true,
      });
      hudStore.getState().setMatchState({
        blueScore: tiedScore,
        orangeScore: tiedScore,
        remainingSeconds: 0,
        isOvertime: true,
        overtimeSeconds: 0,
      });
      beginIncidentKickoffCountdown(mode, store);
      break;
    }
    case 'pause_5s': {
      mode.incidentPauseResumeTicks = 600;
      mode.incidentPhase = 'will-resume (5.0s)';
      store.updateLiveTelemetry({
        incidentPhase: mode.incidentPhase,
      });
      break;
    }
    case 'reset_kickoff': {
      r.physics.resetKickoff(0, true);
      r.interpolator?.sync?.();
      resetIncidentBotEpoch(mode);
      beginIncidentKickoffCountdown(mode, store);
      break;
    }
    case 'podium_blue': {
      enterPodiumInTestLab(mode, 0);
      mode.incidentPhase = 'PODIUM (BLUE WINS)';
      store.updateLiveTelemetry({ incidentPhase: mode.incidentPhase });
      break;
    }
    case 'podium_orange': {
      enterPodiumInTestLab(mode, 1);
      mode.incidentPhase = 'PODIUM (ORANGE WINS)';
      store.updateLiveTelemetry({ incidentPhase: mode.incidentPhase });
      break;
    }
    case 'podium_draw': {
      enterPodiumInTestLab(mode, 2);
      mode.incidentPhase = 'PODIUM (DRAW)';
      store.updateLiveTelemetry({ incidentPhase: mode.incidentPhase });
      break;
    }
    case 'exit_podium': {
      exitPodiumInTestLab(mode);
      beginIncidentKickoffCountdown(mode, store);
      break;
    }
    default:
      break;
  }
}

function stepSingleNextoCar(mode, sim, pads, epoch, carIdx, team, botKey, ctrlKey, skipKey) {
  const bot = mode[botKey];
  if (!bot) return;
  const car = sim.getCarStateView(carIdx);
  const onWallOrCeiling =
    car && (Math.abs(car.posX) > 3650 || Math.abs(car.posY) > 4750 || car.upZ < 0.82 || car.posZ > 700);
  const ko = !onWallOrCeiling ? bot.getKickoffControls(sim.state, mode.incidentKickoffStep, true) : null;

  if (ko) {
    mode[ctrlKey] = ko;
    bot.overrideControls(ko);
  } else if (onWallOrCeiling) {
    mode[ctrlKey] = multiCarHeuristicDecide(sim.state, pads, carIdx, team, INCIDENT_ACTIVE_CARS);
  } else {
    if (mode[skipKey] <= 0) {
      mode[ctrlKey] = bot.decideSync(sim.state, pads, INCIDENT_ACTIVE_CARS);
      mode[skipKey] = bot.tickSkip - 1;
    } else {
      mode[skipKey]--;
    }
  }
  sim.setControls(carIdx, mode[ctrlKey]);
}

export function stepDualNextoBots(mode, sim) {
  if (!mode.botBlue || !mode.botOrange) ensureIncidentBotsLoaded(mode);
  const pads = sim.getPads();
  const epoch = mode.botDecisionEpoch;
  stepSingleNextoCar(mode, sim, pads, epoch, 0, 0, 'botBlue', 'botBlueControls', 'botBlueTickSkip');
  stepSingleNextoCar(mode, sim, pads, epoch, 1, 1, 'botOrange', 'botOrangeControls', 'botOrangeTickSkip');
  mode.incidentKickoffStep++;
}

export function stepIncidentMatchTick(mode, store) {
  const r = mode.runtime;
  const sim = r?.physics;
  if (!sim) return;
  const audio = getAudio(r);

  // 1. Handle 3-2-1-Go Kickoff Countdown Phase
  if (mode.incidentCountdownTicks > 0) {
    sim.setControls(0, r.neutralControls);
    sim.setControls(1, r.neutralControls);
    mode.incidentCountdownTicks--;

    if (mode.incidentCountdownTicks === 240) {
      mode.incidentPhase = 'kickoff (2)';
      audio?.play?.('match_countdown_321', 1.0);
      store.updateLiveTelemetry({ incidentKickoffCountdownSec: 2, incidentPhase: mode.incidentPhase });
      hudStore.getState().setMatchState({ matchPhase: 'kickoff', kickoffCountdown: 2 });
    } else if (mode.incidentCountdownTicks === 120) {
      mode.incidentPhase = 'kickoff (1)';
      audio?.play?.('match_countdown_321', 1.0);
      store.updateLiveTelemetry({ incidentKickoffCountdownSec: 1, incidentPhase: mode.incidentPhase });
      hudStore.getState().setMatchState({ matchPhase: 'kickoff', kickoffCountdown: 1 });
    } else if (mode.incidentCountdownTicks === 0) {
      mode.incidentPhase = mode.incidentOvertime ? 'overtime' : 'playing';
      if (r?.match?.state) {
        r.match.state.phase = 'playing';
        r.match.state.countdown = 0;
      }
      audio?.play?.('match_start_go', 1.0);
      store.updateLiveTelemetry({ incidentKickoffCountdownSec: 0, incidentPhase: mode.incidentPhase });
      hudStore.getState().setMatchState({
        matchPhase: mode.incidentOvertime ? 'overtime' : 'playing',
        kickoffCountdown: 0,
      });
    }
    return;
  }

  // 2. Route Controls: Nexto AI Bot Control vs Manual Control (with Car 0 / Car 1 switcher)
  const controlledCar = store.incidentControlledCar === 1 ? 1 : 0;
  if (r.playerCarIndex !== controlledCar) {
    applyIncidentControlledCar(mode, controlledCar);
  }

  if (store.incidentOpponentMode === 'nexto') {
    stepDualNextoBots(mode, sim);
  } else {
    const otherCar = controlledCar === 0 ? 1 : 0;
    sim.setControls(controlledCar, r.playerControls || r.neutralControls);
    sim.setControls(otherCar, r.neutralControls);
  }

  // 3. Handle Post-Goal Celebration Timer
  if (mode.incidentGoalResetTicks > 0) {
    mode.incidentGoalResetTicks--;
    if (mode.incidentGoalResetTicks <= 0) {
      if (mode.incidentPhase.includes('WINS') || mode.incidentPhase.includes('MATCH END')) {
        return;
      }
      sim.resetGoalLatch?.();
      sim.resetKickoff(0, true);
      r.interpolator?.sync?.();
      resetIncidentBotEpoch(mode);
      beginIncidentKickoffCountdown(mode, store);
    }
    return;
  }

  // 4. Check Goal Scored
  const bView = sim.getBallStateView();
  const goalScored = typeof sim.isBallScored === 'function'
    ? sim.isBallScored(bView)
    : (Math.abs(bView.posY) > 5120 + 91.25 && Math.abs(bView.posX) < 892.755 && bView.posZ < 642.775);
  if (goalScored) {
    const blueScored = bView.posY > 0;
    mode.incidentBlueScore += blueScored ? 1 : 0;
    mode.incidentOrangeScore += blueScored ? 0 : 1;
    audio?.play?.('sfx_goal_poof', 1.0);

    const poss = sim.getPossessionStats?.() || { team: 0, bluePoints: 0, orangePoints: 0 };

    if (mode.incidentOvertime) {
      mode.incidentGoalResetTicks = 180;
      mode.incidentOvertime = false;
      mode.incidentPhase = blueScored ? 'BLUE WINS OT!' : 'ORANGE WINS OT!';
      audio?.play?.('endgame', 1.0);
      store.updateLiveTelemetry({
        incidentBlueScore: mode.incidentBlueScore,
        incidentOrangeScore: mode.incidentOrangeScore,
        incidentPhase: mode.incidentPhase,
        incidentOvertime: false,
        incidentPossessionTeam: poss.team,
        incidentPossessionBluePts: poss.bluePoints,
        incidentPossessionOrangePts: poss.orangePoints,
      });
    } else {
      mode.incidentGoalResetTicks = store.incidentDisableGoalReplay ? 150 : 360;
      mode.incidentPhase = store.incidentDisableGoalReplay
        ? 'GOAL! (Replay Skipped -> Kickoff)'
        : 'GOAL CELEBRATION';
      store.updateLiveTelemetry({
        incidentBlueScore: mode.incidentBlueScore,
        incidentOrangeScore: mode.incidentOrangeScore,
        incidentPhase: mode.incidentPhase,
        incidentPossessionTeam: poss.team,
        incidentPossessionBluePts: poss.bluePoints,
        incidentPossessionOrangePts: poss.orangePoints,
      });
    }

    hudStore.getState().setMatchState({
      blueScore: mode.incidentBlueScore,
      orangeScore: mode.incidentOrangeScore,
    });
    return;
  }

  // 5. 5-Second Kickoff Touch Timeout & Match Clock Progression
  const ballMoved =
    Math.abs(bView.posX) + Math.abs(bView.posY) > 2.0 ||
    Math.hypot(bView.velX, bView.velY) > 5.0;

  mode.incidentTicksSinceKickoff++;
  const prevClockStarted = mode.incidentClockStarted;
  const prevRemSec = mode.incidentRemainingSec;

  if (!mode.incidentClockStarted) {
    if (ballMoved || mode.incidentTicksSinceKickoff >= 600) {
      mode.incidentClockStarted = true;
      mode.incidentClockTickAccum = 0;
    }
  }

  if (mode.incidentClockStarted) {
    mode.incidentClockTickAccum++;
    if (mode.incidentClockTickAccum >= 120) {
      mode.incidentClockTickAccum -= 120;
      if (!mode.incidentOvertime) {
        if (mode.incidentRemainingSec > 0) {
          mode.incidentRemainingSec--;
        }

        if (mode.incidentRemainingSec === 60) {
          audio?.play?.('match_60_seconds_left', 1.0, 10000);
        } else if (mode.incidentRemainingSec === 30) {
          audio?.play?.('match_30_seconds_left', 1.0, 10000);
        } else if (mode.incidentRemainingSec <= 10 && mode.incidentRemainingSec >= 1) {
          audio?.play?.('match_countdown_10s', 1.0);
        }

        if (mode.incidentRemainingSec === 0) {
          if (mode.incidentBlueScore === mode.incidentOrangeScore) {
            mode.incidentOvertime = true;
            mode.incidentPhase = 'overtime';
            audio?.play?.('match_entering_overtime', 1.0, 10000);
            sim.resetKickoff(0, true);
            r.interpolator?.sync?.();
            resetIncidentBotEpoch(mode);
            beginIncidentKickoffCountdown(mode, store);
          } else {
            mode.incidentPhase =
              mode.incidentBlueScore > mode.incidentOrangeScore
                ? 'MATCH END (BLUE WINS)'
                : 'MATCH END (ORANGE WINS)';
            audio?.play?.('endgame', 1.0);
          }
        }
      } else {
        mode.incidentRemainingSec++;
      }
    }
  }

  const poss = sim.getPossessionStats?.() || { team: 0, bluePoints: 0, orangePoints: 0 };

  if (
    mode.incidentTicksSinceKickoff % 6 === 0 ||
    mode.incidentClockStarted !== prevClockStarted ||
    mode.incidentRemainingSec !== prevRemSec
  ) {
    store.updateLiveTelemetry({
      incidentClockStarted: mode.incidentClockStarted,
      incidentTicksSinceKickoff: mode.incidentTicksSinceKickoff,
      incidentRemainingSec: mode.incidentRemainingSec,
      incidentOvertime: mode.incidentOvertime,
      incidentPhase: mode.incidentPhase,
      incidentPossessionTeam: poss.team,
      incidentPossessionBluePts: poss.bluePoints,
      incidentPossessionOrangePts: poss.orangePoints,
    });

    hudStore.getState().setMatchState({
      remainingSeconds: mode.incidentRemainingSec,
      isOvertime: mode.incidentOvertime,
      overtimeSeconds: mode.incidentOvertime ? mode.incidentRemainingSec : 0,
      matchPhase: mode.incidentOvertime ? 'overtime' : 'playing',
    });
  }
}
