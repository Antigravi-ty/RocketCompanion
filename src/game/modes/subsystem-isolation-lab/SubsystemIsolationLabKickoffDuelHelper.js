/**
 * SubsystemIsolationLabKickoffDuelHelper.js
 * Bench 6 ('kickoff-duel') for SubsystemIsolationLabMode:
 * 4-Model Kickoff Speed & 1v1 Duel Arena + Live Action & Channel Telemetry Recorder.
 */

import {
  DEFAULT_CAR_CONTROLS,
  ExperimentalBotAgent,
  ensureExperimentalEngine,
} from '../../../ai/experimental/ExperimentalBotAgent.js';
import { loadExperimentalPolicySafeTensors } from '../../../ai/experimental/SafeTensorsLoader.js';
import {
  KickoffPPOAgent,
  preloadKickoffPPOWeights,
  multiDiscreteToControls,
} from '../../../ai/KickoffPPOAgent.js';
import {
  KickoffV2SafeTensorsAgent,
  formatDiscreteActionKeys,
  classifyBallOutcome,
} from '../../../ai/KickoffV2SafeTensorsAgent.js';
import {
  KICKOFF_DUEL_MODELS,
  KICKOFF_DUEL_SLOTS,
  KICKOFF_DUEL_PAIRINGS,
} from '../../../ui-core/config/kickoffDuelConfig.js';
import { useSubsystemIsolationLabStore } from '../../../ui-core/stores/subsystemIsolationLabStore';
import { parkDevTestLabProbes } from './SubsystemIsolationLabProbesHelper.js';

export const DUEL_ACTIVE_CARS = Object.freeze([
  { carIndex: 0, team: 0 },
  { carIndex: 1, team: 1 },
]);

/**
 * Ensures requested kickoff duel models are preloaded into SafeTensors cache.
 */
export async function ensureKickoffDuelModelsLoaded(
  modelIds = ['ko_v2', 'ko_v1', 'nexto', 'necto']
) {
  const uniqueIds = Array.from(new Set(modelIds));
  const tasks = uniqueIds.map((id) => {
    if (id === 'ko_v2') {
      return loadExperimentalPolicySafeTensors('ko_v2').catch((e) =>
        console.warn('[KickoffDuelLab] Failed to load ko_v2 SafeTensors:', e)
      );
    }
    if (id === 'ko_v1') {
      return preloadKickoffPPOWeights().catch((e) =>
        console.warn('[KickoffDuelLab] Failed to load ko_v1 SafeTensors:', e)
      );
    }
    if (id === 'nexto' || id === 'necto') {
      return ensureExperimentalEngine(id);
    }
    return Promise.resolve();
  });
  await Promise.all(tasks);
}

/**
 * Resets a RocketSimPhysicsEngine instance to a specific kickoff slot (0..4),
 * runs 60 frames of C++ suspension settle via resetKickoffAtSpawn(cppIdx, 60),
 * and restores exact pre-settle (x, y) & symmetric rotation matrices while preserving
 * settled z (~16.92uu) and zeroing velocities — matching RLRL101 `_reset_kickoff_and_settle`.
 */
export function resetSimToKickoffSlotAndSettle(sim, slotIndex = 0) {
  const slot = KICKOFF_DUEL_SLOTS[slotIndex] || KICKOFF_DUEL_SLOTS[0];
  while (sim.numCars > 2 && typeof sim.removeCar === 'function') {
    sim.removeCar(sim.numCars - 1);
  }
  while (sim.numCars < 2) {
    sim.addCar(sim.numCars, 'octane');
  }
  sim.setUnlimitedBoost(false);

  // Capture exact pre-settle XY & rotation matrix at 0 settle ticks
  sim.resetKickoffAtSpawn(slot.cppIdx, 0);
  const pre0 = new Float32Array(sim.getCarState(0));

  // Run 60-tick suspension settle
  sim.resetKickoffAtSpawn(slot.cppIdx, 60);
  const s0 = new Float32Array(sim.getCarState(0));
  const s1 = new Float32Array(sim.getCarState(1));

  // Restore exact pre-settle XY & rotation matrix on Car 0 while preserving settled Z
  s0[0] = pre0[0];
  s0[1] = pre0[1];
  for (let k = 3; k <= 11; k++) s0[k] = pre0[k];
  for (let k = 12; k <= 17; k++) s0[k] = 0.0;
  sim.setCarState(0, s0);

  // Enforce exact 180-degree XY symmetry on Car 1 (eliminates float32 cos(pi+yaw) drift)
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
  sim.setCarState(1, s1);

  sim.setControls(0, DEFAULT_CAR_CONTROLS);
  sim.setControls(1, DEFAULT_CAR_CONTROLS);
}

export function createKickoffDuelHelpers(channelMode = 'keyboard_coupled') {
  return {
    koV2Blue: new KickoffV2SafeTensorsAgent({ channelMode }),
    koV2Orange: new KickoffV2SafeTensorsAgent({ channelMode }),
    koV1Blue: new KickoffPPOAgent(),
    koV1Orange: new KickoffPPOAgent(),
    expBlue: new ExperimentalBotAgent('nexto', 0, 0),
    expOrange: new ExperimentalBotAgent('nexto', 1, 1),
    blueCtrl: { ...DEFAULT_CAR_CONTROLS },
    orangeCtrl: { ...DEFAULT_CAR_CONTROLS },
    blueAct: [1, 1, 1, 0, 0, 0],
    orangeAct: [1, 1, 1, 0, 0, 0],
  };
}

/**
 * Steps a single model policy for one car on the given simulation instance.
 */
export function decideCarControlsForModel(
  sim,
  modelId,
  carIndex,
  team,
  tick,
  helpers,
  options = {}
) {
  const isOrange = team === 1;
  const teamSign = isOrange ? -1.0 : 1.0;
  const nextoScriptedKickoff = Boolean(options.nextoScripted);
  const channelMode = options.channelMode || 'keyboard_coupled';

  if (modelId === 'ko_v2') {
    const agent = carIndex === 0 ? helpers.koV2Blue : helpers.koV2Orange;
    agent.channelMode = channelMode;
    if (tick % 4 === 0) {
      const rawCtrl = agent.actDeterministic(sim, carIndex, isOrange);
      if (carIndex === 0) {
        helpers.blueCtrl = rawCtrl;
        helpers.blueAct = [...agent.act];
      } else {
        helpers.orangeCtrl = rawCtrl;
        helpers.orangeAct = [...agent.act];
      }
    }
    const raw = carIndex === 0 ? helpers.blueCtrl : helpers.orangeCtrl;
    return agent.sanitizeAndRecordTickControls(sim, carIndex, raw);
  }

  if (modelId === 'ko_v1') {
    const agent = carIndex === 0 ? helpers.koV1Blue : helpers.koV1Orange;
    if (tick % 4 === 0) {
      const obs = agent.buildObsV3(sim, carIndex, agent.obsBuffer, teamSign);
      const act = agent.actDeterministic(obs);
      const ctrl = multiDiscreteToControls(act);
      if (carIndex === 0) {
        helpers.blueCtrl = ctrl;
        helpers.blueAct = [...act];
      } else {
        helpers.orangeCtrl = ctrl;
        helpers.orangeAct = [...act];
      }
    }
    const ctrl = carIndex === 0 ? helpers.blueCtrl : helpers.orangeCtrl;
    const cv = sim.getCarStateView(carIndex);
    agent.tracker.stepTick(Boolean(ctrl.jump), Boolean(cv.isOnGround));
    return ctrl;
  }

  if (modelId === 'nexto' || modelId === 'necto') {
    const bot = carIndex === 0 ? helpers.expBlue : helpers.expOrange;
    if (bot.botType !== modelId) {
      bot.setBotType(modelId);
    }
    const kickoffStepArg = modelId === 'nexto' && nextoScriptedKickoff ? tick : 999;
    if (tick % 8 === 0) {
      const ctrl = bot.decideSync(sim.state, sim.getPads(), DUEL_ACTIVE_CARS, kickoffStepArg);
      if (carIndex === 0) {
        helpers.blueCtrl = ctrl;
        helpers.blueAct = null;
      } else {
        helpers.orangeCtrl = ctrl;
        helpers.orangeAct = null;
      }
    }
    return carIndex === 0 ? helpers.blueCtrl : helpers.orangeCtrl;
  }

  return { ...DEFAULT_CAR_CONTROLS };
}

export function buildCarStepTraceEntry(sim, modelId, carIndex, tick, helpers, ctrl) {
  const cs = sim.getCarStateView(carIndex);
  const bs = sim.getBallStateView();
  const speed = Math.hypot(cs.velX, cs.velY, cs.velZ);
  const distToBall = Math.hypot(cs.posX - bs.posX, cs.posY - bs.posY, cs.posZ - bs.posZ);
  const act = carIndex === 0 ? helpers.blueAct : helpers.orangeAct;
  const ko2Agent = carIndex === 0 ? helpers.koV2Blue : helpers.koV2Orange;
  const prevAct0 =
    modelId === 'ko_v2'
      ? Number((ko2Agent.prevActionVec[0] ?? 0).toFixed(3))
      : Number((cs.isOnGround ? ctrl.throttle : -ctrl.pitch).toFixed(3));

  return {
    tick,
    timeSec: Number((tick / 120).toFixed(3)),
    onGround: Boolean(cs.isOnGround),
    hasFlip: Boolean(cs.hasFlipOrJump),
    isFlipping: Boolean(cs.isFlipping),
    boostAmount: Math.round(Number(cs.boost ?? 0)),
    carPos: [
      Math.round(cs.posX * 10) / 10,
      Math.round(cs.posY * 10) / 10,
      Math.round(cs.posZ * 10) / 10,
    ],
    carVel: [Math.round(cs.velX), Math.round(cs.velY), Math.round(cs.velZ)],
    carSpeed: Math.round(speed),
    distToBall: Math.round(distToBall),
    discreteAct: act ? act.slice(0, 5) : undefined,
    keysLabel: formatDiscreteActionKeys(act, ctrl),
    controls: {
      throttle: Number((ctrl.throttle ?? 0).toFixed(3)),
      steer: Number((ctrl.steer ?? 0).toFixed(3)),
      pitch: Number((ctrl.pitch ?? 0).toFixed(3)),
      yaw: Number((ctrl.yaw ?? 0).toFixed(3)),
      roll: Number((ctrl.roll ?? 0).toFixed(3)),
      jump: Boolean(ctrl.jump),
      boost: Boolean(ctrl.boost),
      handbrake: Boolean(ctrl.handbrake),
    },
    prevAct0,
  };
}

/**
 * Sets up the live 3D Kickoff Duel Bench inside SubsystemIsolationLabMode.
 */
export async function setupKickoffDuelBench(mode) {
  const r = mode.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();
  const epoch = mode._tabSwitchEpoch;

  parkDevTestLabProbes(r.physics, r.arena);
  mode.probeState = null;
  if (mode.ghostVisuals) {
    mode.ghostVisuals.setVisible(false);
  }

  if (!mode.kickoffDuelHelpers) {
    mode.kickoffDuelHelpers = createKickoffDuelHelpers(store.kickoffDuelChannelMode);
  }

  startKickoffDuelEpisode(mode);

  await r.arena?.ensureOpponent?.();
  await ensureKickoffDuelModelsLoaded([
    store.kickoffDuelBlueModel,
    store.kickoffDuelOrangeModel,
  ]);

  if (mode._tabSwitchEpoch !== epoch || useSubsystemIsolationLabStore.getState().activeTab !== 'kickoff-duel') {
    return;
  }

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

  const mult = Math.max(100, Math.min(400, Number(store.kickoffDuelSpeedMultiplier) || 100));
  r.interpolator?.setTrainingPhysicsRate?.(Math.round(120 * (mult / 100)));

  startKickoffDuelEpisode(mode);
}

/**
 * Starts or restarts a single 1v1 kickoff duel episode in the live 3D arena.
 */
export function startKickoffDuelEpisode(mode, overrideSlotIndex = null) {
  const r = mode.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();

  // Lazily ensure selected models are loaded if user switched models
  ensureKickoffDuelModelsLoaded([store.kickoffDuelBlueModel, store.kickoffDuelOrangeModel]);

  const slotIdx =
    typeof overrideSlotIndex === 'number'
      ? overrideSlotIndex
      : store.kickoffDuelSlotIndex ?? 0;

  resetSimToKickoffSlotAndSettle(r.physics, slotIdx);
  r.physics.clearEvents?.();
  r.arena?.resetAllCarEffects?.();
  r.interpolator?.sync?.();

  if (mode.kickoffDuelHelpers) {
    mode.kickoffDuelHelpers.koV2Blue.channelMode = store.kickoffDuelChannelMode;
    mode.kickoffDuelHelpers.koV2Orange.channelMode = store.kickoffDuelChannelMode;
    mode.kickoffDuelHelpers.koV2Blue.reset();
    mode.kickoffDuelHelpers.koV2Orange.reset();
    mode.kickoffDuelHelpers.koV1Blue.resetTracker();
    mode.kickoffDuelHelpers.koV1Orange.resetTracker();
    mode.kickoffDuelHelpers.expBlue.setBotType(
      store.kickoffDuelBlueModel === 'necto' ? 'necto' : 'nexto'
    );
    mode.kickoffDuelHelpers.expOrange.setBotType(
      store.kickoffDuelOrangeModel === 'necto' ? 'necto' : 'nexto'
    );
    mode.kickoffDuelHelpers.expBlue.reset();
    mode.kickoffDuelHelpers.expOrange.reset();
    mode.kickoffDuelHelpers.blueCtrl = { ...DEFAULT_CAR_CONTROLS };
    mode.kickoffDuelHelpers.orangeCtrl = { ...DEFAULT_CAR_CONTROLS };
  }

  mode.kickoffDuelRuntime = {
    tick: 0,
    slotIndex: slotIdx,
    touched: false,
    touchTick: -1,
    touchWinner: 'NONE',
    blueDistAtTouch: 0,
    orangeDistAtTouch: 0,
    ballSpeedAtTouch: 0,
    ballVyAtTouch: 0,
    inputsCutOff: false,
    cutoffTick: -1,
    postCutoffTicks: 0,
    blueSteps: [],
    orangeSteps: [],
  };

  store.updateLiveTelemetry({
    kickoffDuelSlotIndex: slotIdx,
    kickoffDuelPhase: 'APPROACHING',
    kickoffDuelCurrentTick: 0,
    kickoffDuelTouchTick: -1,
    kickoffDuelTouchWinner: 'NONE',
    kickoffDuelInputsCutOff: false,
    kickoffDuelBlueDist: 0,
    kickoffDuelOrangeDist: 0,
    kickoffDuelBallPos: [0, 0, 93.15],
    kickoffDuelBallVel: [0, 0, 0],
    kickoffDuelBallSpeed: 0,
    kickoffDuelBallOutcome: 'Waiting for First Touch...',
    kickoffDuelLiveBlueSteps: [],
    kickoffDuelLiveOrangeSteps: [],
  });
}

/**
 * Steps the live 3D Kickoff Duel Bench before each 120Hz physics tick.
 */
export function stepKickoffDuelBeforeTick(mode, store) {
  const r = mode.runtime;
  const sim = r?.physics;
  if (!sim || sim.numCars < 2 || !mode.kickoffDuelRuntime || !mode.kickoffDuelHelpers) {
    return true;
  }

  const rt = mode.kickoffDuelRuntime;
  const helpers = mode.kickoffDuelHelpers;

  const bs = sim.getBallStateView();
  const c0 = sim.getCarStateView(0);
  const c1 = sim.getCarStateView(1);

  const ballMoved =
    Math.hypot(bs.posX, bs.posY, bs.posZ - 93.15) > 0.8 ||
    Math.hypot(bs.velX, bs.velY, bs.velZ) > 5.0;

  if (!rt.touched && ballMoved) {
    rt.touched = true;
    rt.touchTick = rt.tick;
    const d0 = Math.hypot(c0.posX - bs.posX, c0.posY - bs.posY, c0.posZ - bs.posZ);
    const d1 = Math.hypot(c1.posX - bs.posX, c1.posY - bs.posY, c1.posZ - bs.posZ);
    rt.blueDistAtTouch = Math.round(d0);
    rt.orangeDistAtTouch = Math.round(d1);
    rt.ballSpeedAtTouch = Math.round(Math.hypot(bs.velX, bs.velY, bs.velZ));
    rt.ballVyAtTouch = Math.round(bs.velY);

    if (Math.abs(d0 - d1) <= 8.0) {
      rt.touchWinner = 'TIE';
    } else if (d0 < d1) {
      rt.touchWinner = 'BLUE';
    } else {
      rt.touchWinner = 'ORANGE';
    }
  }

  const cutoffDelayTicks = Math.max(0, Math.round((store.kickoffDuelCutoffDelaySec ?? 0.5) * 120));
  if (rt.touched && !rt.inputsCutOff && rt.tick >= rt.touchTick + cutoffDelayTicks) {
    rt.inputsCutOff = true;
    rt.cutoffTick = rt.tick;
  }

  if (rt.inputsCutOff) {
    sim.setControls(0, DEFAULT_CAR_CONTROLS);
    sim.setControls(1, DEFAULT_CAR_CONTROLS);
    rt.postCutoffTicks++;
  } else {
    const blueModel = store.kickoffDuelBlueModel || 'ko_v2';
    const orangeModel = store.kickoffDuelOrangeModel || 'ko_v1';
    const decideOpts = {
      nextoScripted: Boolean(store.kickoffDuelNextoScripted),
      channelMode: store.kickoffDuelChannelMode || 'keyboard_coupled',
    };

    const ctrl0 = decideCarControlsForModel(sim, blueModel, 0, 0, rt.tick, helpers, decideOpts);
    const ctrl1 = decideCarControlsForModel(sim, orangeModel, 1, 1, rt.tick, helpers, decideOpts);

    if (rt.tick % 4 === 0 && rt.blueSteps.length < 120) {
      rt.blueSteps.push(buildCarStepTraceEntry(sim, blueModel, 0, rt.tick, helpers, ctrl0));
      rt.orangeSteps.push(buildCarStepTraceEntry(sim, orangeModel, 1, rt.tick, helpers, ctrl1));
    }

    sim.setControls(0, ctrl0);
    sim.setControls(1, ctrl1);
  }

  rt.tick++;

  if (rt.tick % 4 === 0 || rt.tick === rt.touchTick + 1 || rt.tick === rt.cutoffTick + 1) {
    const d0Now = Math.round(Math.hypot(c0.posX - bs.posX, c0.posY - bs.posY, c0.posZ - bs.posZ));
    const d1Now = Math.round(Math.hypot(c1.posX - bs.posX, c1.posY - bs.posY, c1.posZ - bs.posZ));
    const bSpd = Math.round(Math.hypot(bs.velX, bs.velY, bs.velZ));
    const outcome = rt.touched
      ? classifyBallOutcome(bs.posX, bs.posY, bs.velX, bs.velY)
      : 'Approaching Ball...';

    let phase = 'APPROACHING';
    if (rt.inputsCutOff) {
      phase = 'INPUTS CUT OFF (OBSERVING BALL)';
    } else if (rt.touched) {
      phase = `POST-TOUCH FOLLOW-THROUGH (${Math.max(0, rt.touchTick + cutoffDelayTicks - rt.tick)}f left)`;
    }

    store.updateLiveTelemetry({
      kickoffDuelPhase: phase,
      kickoffDuelCurrentTick: rt.tick,
      kickoffDuelTouchTick: rt.touchTick,
      kickoffDuelTouchWinner: rt.touchWinner,
      kickoffDuelInputsCutOff: rt.inputsCutOff,
      kickoffDuelBlueDist: rt.touched ? rt.blueDistAtTouch : d0Now,
      kickoffDuelOrangeDist: rt.touched ? rt.orangeDistAtTouch : d1Now,
      kickoffDuelBallPos: [Math.round(bs.posX), Math.round(bs.posY), Math.round(bs.posZ)],
      kickoffDuelBallVel: [Math.round(bs.velX), Math.round(bs.velY), Math.round(bs.velZ)],
      kickoffDuelBallSpeed: bSpd,
      kickoffDuelBallOutcome: outcome,
      kickoffDuelLiveBlueSteps: rt.blueSteps.slice(-16),
      kickoffDuelLiveOrangeSteps: rt.orangeSteps.slice(-16),
    });
  }

  const maxObservationTicks = 180;
  const timedOut = !rt.touched && rt.tick >= 420;
  const finishedObservation = rt.inputsCutOff && rt.postCutoffTicks >= maxObservationTicks;

  if ((finishedObservation || timedOut) && store.kickoffDuelAutoCycle) {
    const nextSlot = (rt.slotIndex + 1) % 5;
    if (nextSlot === 0 && store.kickoffDuelAutoCycleAllPairs) {
      const currentPairIdx = KICKOFF_DUEL_PAIRINGS.findIndex(
        (p) => p.blue === store.kickoffDuelBlueModel && p.orange === store.kickoffDuelOrangeModel
      );
      const nextPair = KICKOFF_DUEL_PAIRINGS[(currentPairIdx + 1) % KICKOFF_DUEL_PAIRINGS.length];
      store.updateLiveTelemetry({
        kickoffDuelBlueModel: nextPair.blue,
        kickoffDuelOrangeModel: nextPair.orange,
      });
    }
    startKickoffDuelEpisode(mode, nextSlot);
  }

  return true;
}
