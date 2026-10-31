/**
 * ExperimentalBotAgent.js
 * Native SafeTensors Multi-Car Bot Agent for Experimental Multiple Bots Mode.
 *
 * Supports:
 * - 'nexto' (Grand Champion EARL Perceiver policy via SafeTensors, arbitrary 1..8 cars)
 * - 'necto' (Diamond EARL Perceiver policy via SafeTensors, arbitrary 1..8 cars)
 * - 'heuristic' (Role-aware multi-car tactical heuristic policy with striker/support/defender spacing)
 */

import {
  ArenaHeaderView,
  CarStateView,
  BallStateView,
} from '../../physics/RocketSimStateViews.js';
import {
  EXPERIMENTAL_MODEL_URLS,
  loadExperimentalPolicySafeTensors,
  getCachedSafeTensors,
  registerCachedSafeTensors,
} from './SafeTensorsLoader.js';
import { EarlPerceiverEngine } from './EarlPerceiverEngine.js';
import {
  DEFAULT_CAR_CONTROLS,
  NEXTO_ACTION_TABLE,
  encodeCarControls,
  decodeCarControls,
  getNextoKickoffControls,
  buildDynamicNextoObs,
  buildDynamicNectoObs,
  resolveActiveCars,
} from './ExperimentalMultiCarObs.js';

export {
  DEFAULT_CAR_CONTROLS,
  NEXTO_ACTION_TABLE,
  encodeCarControls,
  decodeCarControls,
  getNextoKickoffControls,
};

export const EXPERIMENTAL_BOT_POLICIES = Object.freeze([
  {
    id: 'nexto',
    name: 'Nexto (Native SafeTensors)',
    shortName: 'Nexto',
    rank: 'Grand Champion',
    modelUrl: EXPERIMENTAL_MODEL_URLS.nexto,
    tickSkip: 8,
    scriptedKickoff: true,
  },
  {
    id: 'necto',
    name: 'Necto (Native SafeTensors)',
    shortName: 'Necto',
    rank: 'Diamond',
    modelUrl: EXPERIMENTAL_MODEL_URLS.necto,
    tickSkip: 8,
    scriptedKickoff: false,
  },
  {
    id: 'heuristic',
    name: 'Tactical Heuristic (Multi-Role)',
    shortName: 'Heuristic',
    rank: 'All-Star',
    modelUrl: null,
    tickSkip: 4,
    scriptedKickoff: false,
  },
]);

const sHeaderView = new ArenaHeaderView();
const sBallView = new BallStateView();
const sCarViews = Array.from({ length: 8 }, () => new CarStateView());

// Shared zero-GC Perceiver forward engine
const sPerceiverEngine = new EarlPerceiverEngine();

/**
 * Preloads or retrieves a cached SafeTensors model for 'nexto' or 'necto'.
 * @param {'nexto'|'necto'} botType
 * @returns {Promise<Object|null>}
 */
export async function ensureExperimentalEngine(botType) {
  if (botType !== 'nexto' && botType !== 'necto') return null;
  const cached = getCachedSafeTensors(botType);
  if (cached) return cached;
  try {
    return await loadExperimentalPolicySafeTensors(botType);
  } catch (err) {
    console.warn(`[ExperimentalBotAgent] Failed to load SafeTensors for ${botType}:`, err);
    return null;
  }
}

/**
 * Synchronously registers pre-parsed SafeTensors weights (useful for Node/headless verification).
 * @param {'nexto'|'nexto'} botType
 * @param {Object} parsedSafeTensors
 */
export function registerExperimentalEngineTensors(botType, parsedSafeTensors) {
  registerCachedSafeTensors(botType, parsedSafeTensors);
  return parsedSafeTensors;
}

/**
 * Checks whether a native SafeTensors engine is loaded in memory.
 * @param {'nexto'|'necto'|'heuristic'} botType
 * @returns {boolean}
 */
export function isExperimentalEngineReady(botType) {
  if (botType === 'heuristic') return true;
  return Boolean(getCachedSafeTensors(botType));
}

/**
 * Decodes Nexto 90-action logits into CarControls.
 * @param {Float32Array} logits
 * @returns {Object}
 */
function decodeNextoLogits(logits) {
  let bestIdx = 0;
  let bestVal = logits[0];
  for (let i = 1; i < logits.length; i++) {
    const v = logits[i];
    if (!Number.isFinite(v)) continue;
    if (v > bestVal) {
      bestVal = v;
      bestIdx = i;
    }
  }
  return { ...NEXTO_ACTION_TABLE[bestIdx] };
}

/**
 * Decodes Necto 12-dim logits ([3 throttle, 3 steer, 2 jump, 2 boost, 2 handbrake]) into CarControls.
 * @param {Float32Array} logits12
 * @returns {Object}
 */
function decodeNectoLogits(logits12) {
  const argmaxRange = (start, len) => {
    let best = 0;
    for (let i = 1; i < len; i++) {
      if (logits12[start + i] > logits12[start + best]) best = i;
    }
    return best;
  };
  const throttle = argmaxRange(0, 3);
  const steer = argmaxRange(3, 3);
  const jump = argmaxRange(6, 2);
  const boost = argmaxRange(8, 2);
  const handbrake = argmaxRange(10, 2);

  return decodeCarControls([
    throttle - 1,
    steer - 1,
    throttle - 1,
    (steer - 1) * (1 - handbrake) || 0,
    (steer - 1) * handbrake || 0,
    jump,
    boost,
    handbrake,
  ]);
}

/**
 * Role-aware multi-car tactical heuristic decision function.
 * Assigns dynamic roles among same-team cars based on distance to the ball:
 * - Role 0 (Closest): Primary Striker / Challenger
 * - Role 1 (2nd Closest): Midfield Support / Offset Wing
 * - Role 2 (3rd Closest): Third-Man Sweeper / Goalie Anchor
 */
export function multiCarHeuristicDecide(simState, boostPads, selfCarIndex, selfTeam, activeCars = null) {
  sHeaderView.attach(simState);
  if (!simState || sHeaderView.numCars < 1) {
    return { ...DEFAULT_CAR_CONTROLS };
  }

  const roster = resolveActiveCars(simState, activeCars);
  const carView = (sCarViews[selfCarIndex] || new CarStateView()).attachCar(simState, selfCarIndex);
  sBallView.attach(simState);

  const cx = carView.posX;
  const cy = carView.posY;
  const cz = carView.posZ;
  const fx = carView.fwdX;
  const fy = carView.fwdY;
  const rx = carView.rightX;
  const ry = carView.rightY;

  // 1. Wall / Ceiling recovery guard (only when actually tilted on a wall or high up, never on flat ground near goals)
  if ((carView.upZ < 0.72 && (Math.abs(cx) > 3750 || Math.abs(cy) > 4850 || cz > 250)) || cz > 1100) {
    const toCenterLen = Math.hypot(-cx, -cy) || 1;
    const dirX = -cx / toCenterLen;
    const dirY = -cy / toCenterLen;
    const dotRight = dirX * rx + dirY * ry;
    const dotFwd = dirX * fx + dirY * fy;
    const steer = Math.max(-1, Math.min(1, dotRight * 3.0));
    return {
      throttle: dotFwd < -0.4 ? -1.0 : 0.85,
      steer: dotFwd < -0.4 ? -steer : steer,
      pitch: !carView.isOnGround ? -0.5 : 0,
      yaw: steer,
      roll: !carView.isOnGround ? Math.max(-1, Math.min(1, -carView.rightZ * 2.0)) : 0,
      jump: false,
      boost: false,
      handbrake: Math.abs(dotRight) > 0.65 && carView.isOnGround,
    };
  }

  const bx = sBallView.posX + sBallView.velX * 0.14;
  const by = sBallView.posY + sBallView.velY * 0.14;
  const bz = sBallView.posZ;

  // Determine tactical role among teammates by ranking distance to predicted ball
  let teammatesCloserCount = 0;
  let closestOppDist = 99999;
  const selfDistToBall = Math.hypot(bx - cx, by - cy);

  for (let i = 0; i < roster.length; i++) {
    const other = roster[i];
    if (other.carIndex === selfCarIndex) continue;
    const ov = (sCarViews[other.carIndex] || new CarStateView()).attachCar(simState, other.carIndex);
    if (ov.isDemoed) continue;
    const d = Math.hypot(bx - (ov.posX + ov.velX * 0.12), by - (ov.posY + ov.velY * 0.12));
    if (other.team === selfTeam) {
      if (d < selfDistToBall - 40 || (Math.abs(d - selfDistToBall) <= 40 && other.carIndex < selfCarIndex)) {
        teammatesCloserCount++;
      }
    } else if (d < closestOppDist) {
      closestOppDist = d;
    }
  }

  const enemyGoalY = selfTeam === 0 ? 5120 : -5120;
  const ownGoalY = selfTeam === 0 ? -5120 : 5120;
  const ballToGoalX = 0 - bx;
  const ballToGoalY = enemyGoalY - by;
  const ballToGoalLen = Math.hypot(ballToGoalX, ballToGoalY) || 1;
  const attackDirX = ballToGoalX / ballToGoalLen;
  const attackDirY = ballToGoalY / ballToGoalLen;

  const isKickoffBall =
    Math.abs(sBallView.posX) < 15 &&
    Math.abs(sBallView.posY) < 15 &&
    Math.hypot(sBallView.velX, sBallView.velY) < 15;
  const isBehindBall = selfTeam === 0 ? cy < by + 60 : cy > by - 60;

  let targetX = bx;
  let targetY = by;

  if (teammatesCloserCount === 1 && !isKickoffBall) {
    // Role 1: Midfield Support — position slightly behind and laterally offset from ball
    const wingSign = cx >= 0 ? 1 : -1;
    targetX = Math.max(-2800, Math.min(2800, bx * 0.5 + wingSign * 900));
    targetY = Math.max(-4200, Math.min(4200, by + (ownGoalY - by) * 0.35));
  } else if (teammatesCloserCount >= 2 && !isKickoffBall) {
    // Role 2: Third-Man Sweeper — protect backfield between ball and own goal
    targetX = Math.max(-1600, Math.min(1600, bx * 0.35));
    targetY = Math.max(-4450, Math.min(4450, ownGoalY * 0.65 + by * 0.35));
  } else if (isKickoffBall) {
    targetX = 0;
    targetY = 0;
  } else if (!isBehindBall) {
    const sideSign = cx >= bx ? 1 : -1;
    targetX = Math.max(-3200, Math.min(3200, bx + sideSign * 420));
    targetY = Math.max(-4400, Math.min(4400, by + (ownGoalY > 0 ? 480 : -480)));
  } else if (closestOppDist < selfDistToBall * 0.65 && selfDistToBall > 500) {
    const blockRatio = 0.28;
    targetX = bx * (1 - blockRatio);
    targetY = by + (ownGoalY - by) * blockRatio;
  } else if (selfDistToBall > 340) {
    const offset = Math.min(280, selfDistToBall * 0.45);
    targetX = Math.max(-3300, Math.min(3300, bx - attackDirX * offset));
    targetY = Math.max(-4500, Math.min(4500, by - attackDirY * offset));
  }

  const dx = targetX - cx;
  const dy = targetY - cy;
  const targetLen = Math.hypot(dx, dy) || 1;
  const dirX = dx / targetLen;
  const dirY = dy / targetLen;

  const dotRight = dirX * rx + dirY * ry;
  const dotFwd = dirX * fx + dirY * fy;

  const steer = Math.max(-1, Math.min(1, dotRight * 2.6));
  const throttle =
    dotFwd < -0.35 && selfDistToBall < 450 && !isKickoffBall
      ? -1.0
      : Math.abs(dotRight) > 0.8
        ? 0.45
        : 1.0;
  const boost =
    (isKickoffBall || (isBehindBall && teammatesCloserCount === 0)) &&
    dotFwd > 0.88 &&
    selfDistToBall > 380 &&
    Math.abs(cx) < 3100 &&
    Math.abs(cy) < 4200 &&
    carView.boost > 12;
  const jump =
    !isKickoffBall &&
    teammatesCloserCount === 0 &&
    isBehindBall &&
    selfDistToBall < 185 &&
    bz < 200 &&
    bz > 85 &&
    carView.isOnGround &&
    dotFwd > 0.9;
  const handbrake = carView.isOnGround && Math.abs(dotRight) > 0.78 && dotFwd < 0.25 && !isKickoffBall;

  return {
    throttle,
    steer: throttle < 0 ? -steer : steer,
    pitch: jump ? -0.8 : 0,
    yaw: steer,
    roll: 0,
    jump,
    boost,
    handbrake,
  };
}

/**
 * ExperimentalBotAgent
 * Per-slot bot controller supporting dynamic N-car Nexto, Necto, and Heuristic policies.
 */
export class ExperimentalBotAgent {
  /**
   * @param {'nexto'|'necto'|'heuristic'} botType
   * @param {number} carIndex
   * @param {number} team
   */
  constructor(botType = 'nexto', carIndex = 0, team = 0) {
    this.botType = botType;
    this.carIndex = carIndex;
    this.team = team === 1 ? 1 : team === 0 ? 0 : carIndex % 2;
    this.action = { ...DEFAULT_CAR_CONTROLS };
    this.demoTimers = new Float64Array(8);
    this.boostTimers = new Float64Array(34);
    this.tickSkipCounter = 0;
    this.lastInferenceMs = 0;
  }

  setBotType(botType) {
    if (this.botType !== botType) {
      this.botType = botType;
      this.reset();
      if (botType === 'nexto' || botType === 'necto') {
        ensureExperimentalEngine(botType);
      }
    }
  }

  reset() {
    this.action = { ...DEFAULT_CAR_CONTROLS };
    this.demoTimers.fill(0);
    this.boostTimers.fill(0);
    this.tickSkipCounter = 0;
  }

  async preload() {
    if (this.botType === 'nexto' || this.botType === 'necto') {
      await ensureExperimentalEngine(this.botType);
    }
  }

  get isReady() {
    return isExperimentalEngineReady(this.botType);
  }

  get tickSkip() {
    const policy = EXPERIMENTAL_BOT_POLICIES.find((p) => p.id === this.botType);
    return policy ? policy.tickSkip : 8;
  }

  overrideControls(controls) {
    this.action = { ...controls };
  }

  /**
   * Returns scripted speed-flip kickoff controls if applicable (only for primary kickoff striker).
   * Delegates directly to getNextoKickoffControls with (this.carIndex, normTeam) which already
   * mirrors lateral steer/yaw/roll based on team-adjusted X spawn position.
   */
  getKickoffControls(simState, kickoffTick, isPrimaryKickoffCar = true) {
    if (!isPrimaryKickoffCar) return null;
    if (this.botType !== 'nexto') return null;
    const normTeam = this.team === 1 ? 1 : this.team === 0 ? 0 : this.carIndex % 2;
    return getNextoKickoffControls(simState, kickoffTick, this.carIndex, normTeam);
  }

  /**
   * Executes synchronous native Float32 inference (or heuristic fallback) for this car.
   * @param {Float32Array} simState
   * @param {Array} boostPads
   * @param {Array<{carIndex: number, team: number}>} activeCars
   * @returns {Object} CarControls
   */
  decideSync(simState, boostPads, activeCars) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (this.botType === 'heuristic') {
      this.action = multiCarHeuristicDecide(
        simState,
        boostPads,
        this.carIndex,
        this.team,
        activeCars
      );
      this.lastInferenceMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return this.action;
    }

    const parsedModel = getCachedSafeTensors(this.botType);
    if (!parsedModel || !parsedModel.tensors) {
      if (!this._warnedUnloadedFallback) {
        this._warnedUnloadedFallback = true;
        console.warn(
          `[ExperimentalBotAgent] SafeTensors model "${this.botType}" is not yet loaded for car ${this.carIndex}; falling back to multiCarHeuristicDecide while loading in background.`
        );
        ensureExperimentalEngine(this.botType);
      }
      this.action = multiCarHeuristicDecide(
        simState,
        boostPads,
        this.carIndex,
        this.team,
        activeCars
      );
      this.lastInferenceMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return this.action;
    }
    this._warnedUnloadedFallback = false;

    try {
      if (this.botType === 'nexto') {
        const obs = buildDynamicNextoObs(
          simState,
          boostPads,
          this.action,
          this.carIndex,
          this.team,
          activeCars
        );
        const logits = sPerceiverEngine.forwardNexto(
          obs.query,
          obs.entities,
          obs.numEntities,
          parsedModel.tensors
        );
        this.action = decodeNextoLogits(logits);
      } else if (this.botType === 'necto') {
        const obs = buildDynamicNectoObs(
          simState,
          boostPads,
          this.action,
          this.carIndex,
          this.team,
          activeCars,
          this.demoTimers,
          this.boostTimers
        );
        const logits12 = sPerceiverEngine.forwardNecto(
          obs.query,
          obs.entities,
          obs.numEntities,
          parsedModel.tensors
        );
        this.action = decodeNectoLogits(logits12);
      }
    } catch (err) {
      console.warn(`[ExperimentalBotAgent] Inference error on car ${this.carIndex} (${this.botType}):`, err);
      this.action = multiCarHeuristicDecide(
        simState,
        boostPads,
        this.carIndex,
        this.team,
        activeCars
      );
    }

    this.lastInferenceMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return this.action;
  }
}
