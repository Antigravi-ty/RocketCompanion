/**
 * ExperimentalBotAgent.ts
 * Native SafeTensors Multi-Car Bot Agent for Experimental Multiple Bots Mode.
 *
 * Supports:
 * - 'nexto' (Grand Champion EARL Perceiver policy via SafeTensors, arbitrary 1..8 cars)
 * - 'necto' (Diamond EARL Perceiver policy via SafeTensors, arbitrary 1..8 cars)
 * - 'heuristic' (Role-aware multi-car tactical heuristic policy with striker/support/defender spacing)
 * - 8 RLBot Botpack#9700488 policies (Chronos v2.1, Dice, Ducky, Fury, Galactus v2, Kira, Rain 3v3, Ripple v1.1)
 */

import {
  EXPERIMENTAL_MODEL_URLS,
  loadExperimentalPolicySafeTensors,
  getCachedSafeTensors,
  registerCachedSafeTensors,
} from './SafeTensorsLoader.ts';
import { EarlPerceiverEngine } from './EarlPerceiverEngine.ts';
import { SequentialMlpEngine, selectMaskedArgmax } from './SequentialMlpEngine.ts';
import { RipplePerceiverEngine } from './RipplePerceiverEngine.ts';
import {
  DEFAULT_90_ACTIONS,
  FURY_380_ACTIONS,
  computeDefaultAction90Mask,
  computeFuryAction380Mask,
  mirrorActionControlsX,
} from './botpack9700488Actions.ts';
import {
  MLP_BOTPACK_SPECS,
  RIPPLE_BOTPACK_SPECS,
} from './botpack9700488Specs.ts';
import {
  buildChronosObs,
  buildDiceObs,
  buildKiraObs,
  buildRainObs,
} from './botpack9700488ObsCorePipeline.ts';
import {
  buildDuckyObs,
  buildFuryObs,
  buildGalactusObs,
} from './botpack9700488ObsExtendedPipeline.ts';
import { RippleAgentState } from './RippleObsBuilder.ts';
import { multiCarHeuristicDecide } from './multiCarHeuristicPolicy.ts';
import {
  DEFAULT_CAR_CONTROLS,
  NEXTO_ACTION_TABLE,
  encodeCarControls,
  decodeCarControls,
  getNextoKickoffControls,
  buildDynamicNextoObs,
  buildDynamicNectoObs,
} from './experimentalMultiCarObsPipeline.ts';

export {
  DEFAULT_CAR_CONTROLS,
  NEXTO_ACTION_TABLE,
  encodeCarControls,
  decodeCarControls,
  getNextoKickoffControls,
  multiCarHeuristicDecide,
};

export interface ExperimentalBotPolicyMeta {
  id: string;
  name: string;
  shortName: string;
  rank: string;
  modelUrl: string | null;
  tickSkip: number;
  maxPlayers: number;
  showcaseFormat: string;
  category: string;
  scriptedKickoff: boolean;
}

export const EXPERIMENTAL_BOT_POLICIES: ReadonlyArray<Readonly<ExperimentalBotPolicyMeta>> = Object.freeze([
  {
    id: 'nexto',
    name: 'Nexto (Native SafeTensors)',
    shortName: 'Nexto',
    rank: 'Grand Champion',
    modelUrl: EXPERIMENTAL_MODEL_URLS.nexto,
    tickSkip: 8,
    maxPlayers: 3,
    showcaseFormat: '3v3',
    category: 'legacy',
    scriptedKickoff: true,
  },
  {
    id: 'necto',
    name: 'Necto (Native SafeTensors)',
    shortName: 'Necto',
    rank: 'Diamond',
    modelUrl: EXPERIMENTAL_MODEL_URLS.necto,
    tickSkip: 8,
    maxPlayers: 3,
    showcaseFormat: '3v3',
    category: 'legacy',
    scriptedKickoff: false,
  },
  {
    id: 'heuristic',
    name: 'Tactical Heuristic (Multi-Role)',
    shortName: 'Heuristic',
    rank: 'All-Star',
    modelUrl: null,
    tickSkip: 4,
    maxPlayers: 3,
    showcaseFormat: '3v3',
    category: 'legacy',
    scriptedKickoff: false,
  },
  {
    id: 'chronos',
    name: 'Chronos v2.1 (Botpack #9700488)',
    shortName: 'Chronos v2.1',
    rank: 'SSL (3v3)',
    modelUrl: EXPERIMENTAL_MODEL_URLS.chronos,
    tickSkip: 8,
    maxPlayers: 3,
    showcaseFormat: '3v3',
    category: 'botpack_9700488',
    scriptedKickoff: false,
  },
  {
    id: 'dice',
    name: 'Dice (Botpack #9700488)',
    shortName: 'Dice',
    rank: 'GC (2v2)',
    modelUrl: EXPERIMENTAL_MODEL_URLS.dice,
    tickSkip: 8,
    maxPlayers: 2,
    showcaseFormat: '2v2',
    category: 'botpack_9700488',
    scriptedKickoff: false,
  },
  {
    id: 'ducky',
    name: 'Ducky (Botpack #9700488)',
    shortName: 'Ducky',
    rank: 'GC (3v3)',
    modelUrl: EXPERIMENTAL_MODEL_URLS.ducky,
    tickSkip: 8,
    maxPlayers: 3,
    showcaseFormat: '3v3',
    category: 'botpack_9700488',
    scriptedKickoff: false,
  },
  {
    id: 'fury',
    name: 'Fury (Botpack #9700488)',
    shortName: 'Fury',
    rank: 'SSL (3v3)',
    modelUrl: EXPERIMENTAL_MODEL_URLS.fury,
    tickSkip: 8,
    maxPlayers: 3,
    showcaseFormat: '3v3',
    category: 'botpack_9700488',
    scriptedKickoff: false,
  },
  {
    id: 'galactus',
    name: 'Galactus v2 (Botpack #9700488)',
    shortName: 'Galactus v2',
    rank: 'GC (3v3)',
    modelUrl: EXPERIMENTAL_MODEL_URLS.galactus,
    tickSkip: 8,
    maxPlayers: 3,
    showcaseFormat: '3v3',
    category: 'botpack_9700488',
    scriptedKickoff: false,
  },
  {
    id: 'kira',
    name: 'Kira (Botpack #9700488)',
    shortName: 'Kira',
    rank: 'SSL Duel (1v1)',
    modelUrl: EXPERIMENTAL_MODEL_URLS.kira,
    tickSkip: 8,
    maxPlayers: 1,
    showcaseFormat: '1v1',
    category: 'botpack_9700488',
    scriptedKickoff: false,
  },
  {
    id: 'rain',
    name: 'Rain (Botpack #9700488)',
    shortName: 'Rain',
    rank: 'SSL (3v3)',
    modelUrl: EXPERIMENTAL_MODEL_URLS.rain,
    tickSkip: 6,
    maxPlayers: 3,
    showcaseFormat: '3v3',
    category: 'botpack_9700488',
    scriptedKickoff: false,
  },
  {
    id: 'ripple_v1_1',
    name: 'Ripple v1.1 (Botpack #9700488)',
    shortName: 'Ripple v1.1',
    rank: 'SSL Human-Pretrained (3v3)',
    modelUrl: EXPERIMENTAL_MODEL_URLS.ripple_v1_1,
    tickSkip: 4,
    maxPlayers: 3,
    showcaseFormat: '3v3',
    category: 'botpack_9700488',
    scriptedKickoff: false,
  },
]);

export const BOTPACK_9700488_POLICIES: ReadonlyArray<Readonly<ExperimentalBotPolicyMeta>> = Object.freeze(
  EXPERIMENTAL_BOT_POLICIES.filter((p) => p.category === 'botpack_9700488')
);

export function getExperimentalBotPolicyMeta(botType: string): Readonly<ExperimentalBotPolicyMeta> | null {
  return EXPERIMENTAL_BOT_POLICIES.find((p) => p.id === botType) || null;
}

// Shared zero-GC forward engines (stateless across calls; per-agent state stays on ExperimentalBotAgent)
const sPerceiverEngine = new EarlPerceiverEngine();
const sSequentialMlpEngine = new SequentialMlpEngine();
const sRippleEngine = new RipplePerceiverEngine();

/**
 * Preloads or retrieves a cached SafeTensors model for any neural policy.
 */
export async function ensureExperimentalEngine(botType: string): Promise<any | null> {
  if (!botType || botType === 'heuristic' || !EXPERIMENTAL_MODEL_URLS[botType]) {
    return null;
  }
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
 */
export function registerExperimentalEngineTensors(botType: string, parsedSafeTensors: any): any {
  registerCachedSafeTensors(botType, parsedSafeTensors);
  return parsedSafeTensors;
}

/**
 * Checks whether a native SafeTensors engine is loaded in memory.
 */
export function isExperimentalEngineReady(botType: string): boolean {
  if (botType === 'heuristic') return true;
  return Boolean(getCachedSafeTensors(botType));
}

/**
 * Decodes Nexto 90-action logits into CarControls.
 */
function decodeNextoLogits(logits: ArrayLike<number>): Record<string, any> {
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
 * Writes a CarControls object into an 8-float array [throttle, steer, pitch, yaw, roll, jump, boost, handbrake].
 */
function writeControlsToFloat8(ctrl: Record<string, any>, out8: Float32Array): void {
  out8[0] = ctrl.throttle || 0;
  out8[1] = ctrl.steer || 0;
  out8[2] = ctrl.pitch || 0;
  out8[3] = ctrl.yaw || 0;
  out8[4] = ctrl.roll || 0;
  out8[5] = ctrl.jump ? 1 : 0;
  out8[6] = ctrl.boost ? 1 : 0;
  out8[7] = ctrl.handbrake ? 1 : 0;
}

/**
 * Decodes Necto 12-dim logits ([3 throttle, 3 steer, 2 jump, 2 boost, 2 handbrake]) into CarControls.
 */
function decodeNectoLogits(logits12: ArrayLike<number>): Record<string, any> {
  const argmaxRange = (start: number, len: number): number => {
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
 * ExperimentalBotAgent
 * Per-slot bot controller supporting dynamic N-car Nexto, Necto, Heuristic, and Botpack#9700488 policies.
 */
export class ExperimentalBotAgent {
  botType: string;
  carIndex: number;
  team: number;
  action: any;
  prevAction8: Float32Array;
  obsBuf: Float32Array;
  mask90: Uint8Array;
  mask380: Uint8Array;
  demoTimers: Float64Array;
  boostTimers: Float64Array;
  rippleState: RippleAgentState;
  tickSkipCounter: number;
  lastInferenceMs: number;
  _warnedUnloadedFallback?: boolean;

  constructor(botType: string = 'nexto', carIndex: number = 0, team: number = 0) {
    this.botType = botType;
    this.carIndex = carIndex;
    this.team = team === 1 ? 1 : team === 0 ? 0 : carIndex % 2;
    this.action = { ...DEFAULT_CAR_CONTROLS };
    this.prevAction8 = new Float32Array(8);
    this.obsBuf = new Float32Array(264);
    this.mask90 = new Uint8Array(90);
    this.mask380 = new Uint8Array(380);
    this.demoTimers = new Float64Array(8);
    this.boostTimers = new Float64Array(34);
    this.rippleState = new RippleAgentState();
    this.tickSkipCounter = 0;
    this._staggered = false;
    this.lastInferenceMs = 0;
    if (botType && botType !== 'heuristic') {
      ensureExperimentalEngine(botType);
    }
  }

  _staggered = false;

  setBotType(botType: string): void {
    if (this.botType !== botType) {
      this.botType = botType;
      this.reset();
      if (botType && botType !== 'heuristic') {
        ensureExperimentalEngine(botType);
      }
    }
  }

  reset(): void {
    this.action = { ...DEFAULT_CAR_CONTROLS };
    this.prevAction8.fill(0);
    this.demoTimers.fill(0);
    this.boostTimers.fill(0);
    this.rippleState.reset();
    this.tickSkipCounter = 0;
    this._staggered = false;
  }

  async preload(): Promise<void> {
    if (this.botType && this.botType !== 'heuristic') {
      await ensureExperimentalEngine(this.botType);
    }
  }

  get isReady(): boolean {
    return isExperimentalEngineReady(this.botType);
  }

  get tickSkip(): number {
    const policy = EXPERIMENTAL_BOT_POLICIES.find((p) => p.id === this.botType);
    return policy ? policy.tickSkip : 8;
  }

  overrideControls(controls: Record<string, any>): void {
    this.action = { ...controls };
    writeControlsToFloat8(this.action, this.prevAction8);
  }

  /**
   * Returns scripted speed-flip kickoff controls if applicable (only for primary kickoff striker).
   */
  getKickoffControls(
    simState: Float32Array,
    kickoffTick: number,
    isPrimaryKickoffCar: boolean = true
  ): Record<string, any> | null {
    if (!isPrimaryKickoffCar) return null;
    if (this.botType !== 'nexto') return null;
    const normTeam = this.team === 1 ? 1 : this.team === 0 ? 0 : this.carIndex % 2;
    return getNextoKickoffControls(simState, kickoffTick, this.carIndex, normTeam);
  }

  /**
   * Executes synchronous native Float32 inference (or heuristic fallback) for this car.
   */
  decideSync(
    simState: Float32Array,
    boostPads: any[],
    activeCars: Array<{ carIndex: number; team: number }>,
    physicsEngine: any = null
  ): Record<string, any> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

    if (this.botType === 'heuristic') {
      this.action = multiCarHeuristicDecide(
        simState,
        boostPads,
        this.carIndex,
        this.team,
        activeCars
      );
      writeControlsToFloat8(this.action, this.prevAction8);
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
      writeControlsToFloat8(this.action, this.prevAction8);
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
        writeControlsToFloat8(this.action, this.prevAction8);
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
        writeControlsToFloat8(this.action, this.prevAction8);
      } else if (this.botType === 'ripple_v1_1') {
        const rObs = this.rippleState.buildObs(
          simState,
          this.carIndex,
          this.team,
          activeCars,
          physicsEngine
        );
        const rippleSpec = RIPPLE_BOTPACK_SPECS[this.botType];
        const logits276 = sRippleEngine.forward(rObs, parsedModel.tensors, rippleSpec);
        const actIdx = selectMaskedArgmax(logits276, null);
        this.action = this.rippleState.stepDelayedActionQueue(actIdx);
        writeControlsToFloat8(this.action, this.prevAction8);
      } else {
        this._decideMlpBotpack9700488(
          simState,
          activeCars,
          physicsEngine,
          parsedModel.tensors
        );
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
      writeControlsToFloat8(this.action, this.prevAction8);
    }

    this.lastInferenceMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return this.action;
  }

  _decideMlpBotpack9700488(
    simState: Float32Array,
    activeCars: Array<{ carIndex: number; team: number }>,
    physicsEngine: any,
    tensors: Record<string, any>
  ): void {
    const spec = MLP_BOTPACK_SPECS[this.botType] || MLP_BOTPACK_SPECS.rain;
    let built: any;

    switch (this.botType) {
      case 'chronos':
        built = buildChronosObs(simState, this.action, this.carIndex, this.team, activeCars);
        break;
      case 'dice':
        built = buildDiceObs(simState, this.action, this.carIndex, this.team, activeCars);
        break;
      case 'ducky':
        built = buildDuckyObs(simState, this.action, this.carIndex, this.team, activeCars, physicsEngine);
        break;
      case 'fury':
        built = buildFuryObs(simState, this.action, this.carIndex, this.team, activeCars, physicsEngine);
        break;
      case 'galactus':
        built = buildGalactusObs(simState, this.action, this.carIndex, this.team, activeCars, physicsEngine);
        break;
      case 'kira':
        built = buildKiraObs(simState, this.action, this.carIndex, this.team, activeCars);
        break;
      case 'rain':
      default:
        built = buildRainObs(simState, this.action, this.carIndex, this.team, activeCars);
        break;
    }

    const logits = sSequentialMlpEngine.forward(built.obs, tensors, spec);
    if (this.botType === 'fury') {
      const mask = computeFuryAction380Mask(built.selfCarView, this.mask380);
      const actIdx = selectMaskedArgmax(logits, mask);
      const rawCtrl = FURY_380_ACTIONS[actIdx] || DEFAULT_CAR_CONTROLS;
      this.action = { ...rawCtrl };
    } else {
      const mask = computeDefaultAction90Mask(built.selfCarView, this.mask90);
      const actIdx = selectMaskedArgmax(logits, mask);
      const rawCtrl = DEFAULT_90_ACTIONS[actIdx] || DEFAULT_CAR_CONTROLS;
      this.action = built.mirrorX ? mirrorActionControlsX(rawCtrl) : { ...rawCtrl };
    }
    writeControlsToFloat8(this.action, this.prevAction8);
  }
}
