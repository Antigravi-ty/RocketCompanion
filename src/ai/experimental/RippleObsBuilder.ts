/**
 * RippleObsBuilder.ts
 * Self-contained per-agent observation builder and 6-step delayed action queue for
 * Ripple v1.1 (`rolv/ripple/1.1`).
 *
 * Matches `src/obs.py` (`RippleObs`) and `src/act.py` (`DelayedAction` + `RippleLookupAction`):
 * - 5 observation inputs:
 *   1. `main` [32]: self player features (first 30 into `main_player_processor`, index 30 is `is_flipped`)
 *   2. `others` [5 * 21]: up to 5 other players in local car frame (slot[15] == +1 mate, -1 opp, 0 empty)
 *   3. `ball` [6 * 9]: 6 ball prediction slices at 0s, 1s, 2s, 3s, 4s, 5s in local car frame
 *   4. `actions` [6 * 8]: 6-step delayed action queue (newest at index 0, oldest executed at index 5)
 *   5. `boosts` [34 * 5]: 34 boost pads in local car frame (`[rx, ry, rz, amount, timer/10]`)
 * - 4-tick decision cadence (`tickSkip = 4`) with 6-step `actionQueue` (~200ms human-like reaction delay).
 */

import {
  CarStateView,
  BallStateView,
  BoostPadStateView,
} from '../../physics/RocketSimStateViews.ts';
import {
  DEFAULT_CAR_CONTROLS,
  encodeCarControls,
  decodeCarControls,
  resolveActiveCars,
} from './experimentalMultiCarObsPipeline.ts';
import { RIPPLE_276_ACTIONS, type CarControls } from './botpack9700488Actions.ts';
import {
  CANONICAL_BOOST_LOCATIONS,
  CANONICAL_TO_WASM_PAD_INDEX,
} from './botpack9700488Specs.ts';
import {
  ensureSharedBallPrediction,
  type ActiveCarSlot,
  type BallPredictionEnginePort,
} from './botpackSharedBallPredPipeline.ts';

export interface RippleObservationTensors {
  main: Float32Array;
  others: Float32Array;
  ball: Float32Array;
  actions: Float32Array;
  boosts: Float32Array;
  isKickoff: boolean;
}

const TICK_SKIP = 4;
const TICKS_PER_SECOND = 120;
const NUM_OTHER_SLOTS = 5;
const NUM_BALL_SLICES = 6; // t = 0, 1s, 2s, 3s, 4s, 5s
const ACTION_QUEUE_LEN = 6;
const NUM_BOOST_PADS = 34;

// Normalization constants from src/obs.py:
// NORM = [2300]*6 + [6]*3 + [1]*6 + [1, 3, 1, 1, 1, 1, 12, 24, 150, 120, 1, 1, 1, 1, 1, 1, 1]
const NORM_32 = new Float32Array([
  2300, 2300, 2300, 2300, 2300, 2300,
  6, 6, 6,
  1, 1, 1, 1, 1, 1,
  1, 3, 1, 1, 1, 1,
  12, 24, 150, 120,
  1, 1, 1, 1, 1, 1, 1,
]);

// INVERT_TEAM = [-1, -1, 1]*5 + [-1] + [1]*16
const INVERT_TEAM_32 = new Float32Array([
  -1, -1, 1, -1, -1, 1, -1, -1, 1, -1, -1, 1, -1, -1, 1,
  -1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
]);

// INVERT_SIDE = [-1, 1, 1]*2 + [1, -1, -1] + [-1, 1, 1]*2 + [1]*17
const INVERT_SIDE_32 = new Float32Array([
  -1, 1, 1, -1, 1, 1,
  1, -1, -1,
  -1, 1, 1, -1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
]);

// INVERT_SIDE_RELATIVE = [1, -1, 1]*2 + [-1, 1, -1] + [1, -1, 1]*2 + [1]*12 + [-1] + [1]*4
const INVERT_SIDE_RELATIVE_32 = new Float32Array([
  1, -1, 1, 1, -1, 1,
  -1, 1, -1,
  1, -1, 1, 1, -1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  -1,
  1, 1, 1, 1,
]);

const INVERT_SIDE_ACTIONS_8 = new Float32Array([1, -1, 1, -1, -1, 1, 1, 1]);

const sBallView = new BallStateView();
const sPadView = new BoostPadStateView();
const sCarViews: CarStateView[] = Array.from({ length: 8 }, () => new CarStateView());

/**
 * Multiplies a 3D world vector `[vx, vy, vz]` by the car's rotation matrix `[fwd, right, up]`:
 *   `[vx*fwdX + vy*fwdY + vz*fwdZ, vx*rightX + vy*rightY + vz*rightZ, vx*upX + vy*upY + vz*upZ]`
 */
function matMulRot3(vx: number, vy: number, vz: number, cv: CarStateView): [number, number, number] {
  return [
    vx * cv.fwdX + vy * cv.fwdY + vz * cv.fwdZ,
    vx * cv.rightX + vy * cv.rightY + vz * cv.rightZ,
    vx * cv.upX + vy * cv.upY + vz * cv.upZ,
  ];
}

export class RippleAgentState {
  public readonly main = new Float32Array(32);
  public readonly others = new Float32Array(NUM_OTHER_SLOTS * 21);
  public readonly ball = new Float32Array(NUM_BALL_SLICES * 9);
  public readonly actions = new Float32Array(ACTION_QUEUE_LEN * 8);
  public readonly boosts = new Float32Array(NUM_BOOST_PADS * 5);

  // 6-step action queue [6, 8], newest action at row 0, oldest at row 5
  public readonly actionQueue = new Float32Array(ACTION_QUEUE_LEN * 8);
  public isQueueReset = true;
  public readonly prevExecutedAction = new Float32Array(8);
  public readonly prevPrevAction = new Float32Array(8);

  // Per-car timers tracked across steps
  private readonly demoTimers = new Float32Array(8);
  private readonly boostTimers = new Float32Array(NUM_BOOST_PADS);
  private readonly boostTimes = new Float32Array(8);
  private readonly prevOnGrounds = new Uint8Array(8);
  private readonly isJumpings = new Uint8Array(8);
  private readonly hasJumpeds = new Uint8Array(8);
  private readonly jumpTimes = new Float32Array(8);
  private readonly airTimes = new Float32Array(8);
  private readonly hasDoubleJumpeds = new Uint8Array(8);
  private readonly hasFlippeds = new Uint8Array(8);
  private readonly flipTimes = new Float32Array(8);
  private readonly flipDirs = new Float32Array(8 * 2);
  private readonly handbrakes = new Float32Array(8);
  private lastBallX = 0;
  private lastBallY = 0;

  reset(isKickoff = true): void {
    this.actionQueue.fill(0);
    // On kickoff, Ripple starts with 6 zero actions in queue (`action_queue[:] = 0`).
    // Mid-play resets set `isQueueReset = true` so the first chosen action fills all 6 slots.
    this.isQueueReset = !isKickoff;
    this.prevExecutedAction.fill(0);
    this.prevPrevAction.fill(0);

    this.demoTimers.fill(0);
    this.boostTimers.fill(0);
    this.boostTimes.fill(0);
    this.prevOnGrounds.fill(1);
    this.isJumpings.fill(0);
    this.hasJumpeds.fill(0);
    this.jumpTimes.fill(0);
    this.airTimes.fill(0);
    this.hasDoubleJumpeds.fill(0);
    this.hasFlippeds.fill(0);
    this.flipTimes.fill(0);
    this.flipDirs.fill(0);
    this.handbrakes.fill(0);
  }

  /**
   * Updates boost pad timers, demo timers, and self player timers for one 4-tick step.
   */
  private _updateTimers(
    simState: Float32Array,
    selfCarIndex: number,
    roster: ActiveCarSlot[]
  ): void {
    const dtSec = TICK_SKIP / TICKS_PER_SECOND;

    // 1. Boost pad timers
    for (let p = 0; p < NUM_BOOST_PADS; p++) {
      sPadView.attach(simState, CANONICAL_TO_WASM_PAD_INDEX[p]);
      if (sPadView.isActive) {
        this.boostTimers[p] = 0.0;
      } else {
        const cooldown = sPadView.cooldown;
        if (cooldown > 0) {
          this.boostTimers[p] = Math.min(10.0, cooldown);
        } else {
          let t = this.boostTimers[p] - dtSec;
          if (t <= 0) {
            t = CANONICAL_BOOST_LOCATIONS[p][2] > 72.0 ? 10.0 : 4.0;
          }
          this.boostTimers[p] = Math.max(0.0, Math.min(10.0, t));
        }
      }
    }

    // 2. Demo timers for all cars in roster
    for (let i = 0; i < roster.length; i++) {
      const cIdx = roster[i].carIndex;
      const cv = (sCarViews[cIdx] || new CarStateView()).attachCar(simState, cIdx);
      if (cv.isDemoed) {
        const rem = cv.demoRespawnTimer;
        if (rem > 0) {
          this.demoTimers[cIdx] = rem;
        } else if (this.demoTimers[cIdx] <= 0) {
          this.demoTimers[cIdx] = 3.0;
        } else {
          this.demoTimers[cIdx] = Math.max(0.0, this.demoTimers[cIdx] - dtSec);
        }
      } else {
        this.demoTimers[cIdx] = 0.0;
      }
    }

    // 3. Self player action-driven timers (exact match to RippleObs.update_player_timers)
    const cIdx = selfCarIndex;
    const cv = (sCarViews[cIdx] || new CarStateView()).attachCar(simState, cIdx);
    const onGround = cv.isOnGround;
    const lastActOff = (ACTION_QUEUE_LEN - 1) * 8;
    const lastPitch = this.isQueueReset ? 0 : this.actionQueue[lastActOff + 2];
    const lastYaw = this.isQueueReset ? 0 : this.actionQueue[lastActOff + 3];
    const lastRoll = this.isQueueReset ? 0 : this.actionQueue[lastActOff + 4];
    const lastJump = this.isQueueReset ? 0 : this.actionQueue[lastActOff + 5];
    const lastBoost = this.isQueueReset ? 0 : this.actionQueue[lastActOff + 6];
    const lastHandbrake = this.isQueueReset ? 0 : this.actionQueue[lastActOff + 7];
    const prevJump = this.prevPrevAction[5];

    // Boost time (0..12 ticks)
    if (!lastBoost && this.boostTimes[cIdx] === 12.0) {
      this.boostTimes[cIdx] = 0.0;
    } else if (this.boostTimes[cIdx] !== 0.0 || lastBoost) {
      this.boostTimes[cIdx] = Math.min(12.0, this.boostTimes[cIdx] + TICK_SKIP);
    } else {
      this.boostTimes[cIdx] = 0.0;
    }

    // Jump time (0..24 ticks)
    if (this.prevOnGrounds[cIdx] && !this.isJumpings[cIdx]) {
      this.hasJumpeds[cIdx] = 0;
    }
    if (this.isJumpings[cIdx]) {
      this.isJumpings[cIdx] =
        this.jumpTimes[cIdx] < 3.0 || (lastJump > 0 && this.jumpTimes[cIdx] < 24.0) ? 1 : 0;
    } else if (lastJump > 0 && !(prevJump > 0) && this.prevOnGrounds[cIdx]) {
      this.isJumpings[cIdx] = 1;
      this.jumpTimes[cIdx] = 0.0;
    }

    if (this.isJumpings[cIdx]) {
      this.hasJumpeds[cIdx] = 1;
      this.jumpTimes[cIdx] = Math.min(24.0, this.jumpTimes[cIdx] + TICK_SKIP);
    } else {
      this.jumpTimes[cIdx] = 0.0;
    }

    // Air time (0..150 ticks) and flip time (0..120 ticks)
    if (onGround) {
      this.hasDoubleJumpeds[cIdx] = 0;
      this.hasFlippeds[cIdx] = 0;
      this.airTimes[cIdx] = 0.0;
      this.flipTimes[cIdx] = 0.0;
      this.flipDirs[cIdx * 2 + 0] = 0.0;
      this.flipDirs[cIdx * 2 + 1] = 0.0;
    } else {
      if (this.hasJumpeds[cIdx] && !this.isJumpings[cIdx]) {
        this.airTimes[cIdx] = Math.min(150.0, this.airTimes[cIdx] + TICK_SKIP);
      } else {
        this.airTimes[cIdx] = 0.0;
      }

      if (
        this.hasJumpeds[cIdx] &&
        lastJump > 0 &&
        !(prevJump > 0) &&
        this.airTimes[cIdx] < 150.0 &&
        !this.hasDoubleJumpeds[cIdx] &&
        !this.hasFlippeds[cIdx]
      ) {
        const mag = Math.abs(lastPitch) + Math.abs(lastYaw) + Math.abs(lastRoll);
        if (mag >= 0.5) {
          this.flipTimes[cIdx] = 0.0;
          this.hasFlippeds[cIdx] = 1;
          let fx = -lastPitch;
          let fy = lastYaw + lastRoll;
          const flen = Math.hypot(fx, fy);
          if (flen > 1e-6) {
            fx /= flen;
            fy /= flen;
          }
          this.flipDirs[cIdx * 2 + 0] = fx;
          this.flipDirs[cIdx * 2 + 1] = fy;
        } else {
          this.hasDoubleJumpeds[cIdx] = 1;
        }
      }
    }

    if (this.hasFlippeds[cIdx]) {
      this.flipTimes[cIdx] = Math.min(120.0, this.flipTimes[cIdx] + TICK_SKIP);
    }

    // Handbrake (0..1)
    if (lastHandbrake > 0) {
      this.handbrakes[cIdx] = Math.min(1.0, this.handbrakes[cIdx] + 5.0 * dtSec);
    } else {
      this.handbrakes[cIdx] = Math.max(0.0, this.handbrakes[cIdx] - 2.0 * dtSec);
    }

    this.prevOnGrounds[cIdx] = onGround ? 1 : 0;
  }

  /**
   * Builds the 5 observation tensors (`main`, `others`, `ball`, `actions`, `boosts`) for this car.
   */
  buildObs(
    simState: Float32Array,
    selfCarIndex: number,
    selfTeam: number,
    activeCars: ActiveCarSlot[] | null = null,
    physicsEngine: BallPredictionEnginePort | null = null
  ): RippleObservationTensors {
    const normSelfTeam = selfTeam === 1 ? 1 : selfTeam === 0 ? 0 : selfCarIndex % 2;
    const roster = resolveActiveCars(simState, activeCars ?? undefined) as ActiveCarSlot[];
    sBallView.attach(simState);

    const isKickoff =
      Math.abs(sBallView.posX) < 1.0 &&
      Math.abs(sBallView.posY) < 1.0 &&
      Math.hypot(sBallView.velX, sBallView.velY) < 5.0;

    // Detect transition into kickoff to zero the queue (`action_queue[:] = 0`)
    const wasKickoff = Math.abs(this.lastBallX) < 1.0 && Math.abs(this.lastBallY) < 1.0;
    if (isKickoff && !wasKickoff) {
      this.reset(true);
    }
    this.lastBallX = sBallView.posX;
    this.lastBallY = sBallView.posY;

    this._updateTimers(simState, selfCarIndex, roster);
    this.prevPrevAction.set(this.prevExecutedAction);

    const selfCv = (sCarViews[selfCarIndex] || new CarStateView()).attachCar(simState, selfCarIndex);

    // 1. Populate self player features [32]
    const main = this.main;
    main.fill(0);
    main[0] = selfCv.posX;
    main[1] = selfCv.posY;
    main[2] = selfCv.posZ;
    main[3] = selfCv.velX;
    main[4] = selfCv.velY;
    main[5] = selfCv.velZ;
    main[6] = selfCv.angVelX;
    main[7] = selfCv.angVelY;
    main[8] = selfCv.angVelZ;
    main[9] = selfCv.fwdX;
    main[10] = selfCv.fwdY;
    main[11] = selfCv.fwdZ;
    main[12] = selfCv.upX;
    main[13] = selfCv.upY;
    main[14] = selfCv.upZ;
    main[15] = 2 * normSelfTeam - 1;
    main[16] = this.demoTimers[selfCarIndex];
    main[17] = selfCv.isOnGround ? 1.0 : 0.0;
    const selfHasJump = selfCv.isOnGround ? 1.0 : 0.0;
    const selfHasFlip = selfCv.hasFlipOrJump ? 1.0 : 0.0;
    main[18] = selfHasJump;
    main[19] = selfHasFlip;
    main[20] = Math.min(selfCv.boost / 100.0, 2.0);
    main[21] = this.boostTimes[selfCarIndex];
    main[22] = this.jumpTimes[selfCarIndex];
    main[23] = this.airTimes[selfCarIndex];
    main[24] = this.flipTimes[selfCarIndex];
    main[25] = this.handbrakes[selfCarIndex];
    main[26] = this.flipDirs[selfCarIndex * 2 + 0];
    main[27] = this.flipDirs[selfCarIndex * 2 + 1];
    main[28] = this.isQueueReset ? 1.0 : 0.0;
    main[29] = isKickoff ? 1.0 : 0.0;
    main[30] = 0.0; // is_flipped (set below if main[0] < 0)
    main[31] = 0.0; // is_swapped

    // 2. Populate other players [5 * 21] in local self frame
    const others = this.others;
    others.fill(0);

    // Collect other cars (up to 5; if >5, keep closest 5 to ball)
    const otherList: Array<{ carIndex: number; team: number; distSq: number; cv: CarStateView }> = [];
    for (let i = 0; i < roster.length; i++) {
      const entry = roster[i];
      if (entry.carIndex === selfCarIndex) continue;
      const cv = (sCarViews[entry.carIndex] || new CarStateView()).attachCar(
        simState,
        entry.carIndex
      );
      const distSq = (cv.posX - sBallView.posX) ** 2 + (cv.posY - sBallView.posY) ** 2;
      otherList.push({ carIndex: entry.carIndex, team: entry.team === 1 ? 1 : 0, distSq, cv });
    }
    if (otherList.length > NUM_OTHER_SLOTS) {
      otherList.sort((a, b) => a.distSq - b.distSq);
      otherList.length = NUM_OTHER_SLOTS;
    }

    for (let s = 0; s < otherList.length; s++) {
      const o = otherList[s];
      const ocv = o.cv;
      const base = s * 21;

      const relPos = matMulRot3(
        ocv.posX - selfCv.posX,
        ocv.posY - selfCv.posY,
        ocv.posZ - selfCv.posZ,
        selfCv
      );
      const relVel = matMulRot3(
        ocv.velX - selfCv.velX,
        ocv.velY - selfCv.velY,
        ocv.velZ - selfCv.velZ,
        selfCv
      );
      const relAng = matMulRot3(ocv.angVelX, ocv.angVelY, ocv.angVelZ, selfCv);
      const relFwd = matMulRot3(ocv.fwdX, ocv.fwdY, ocv.fwdZ, selfCv);
      const relUp = matMulRot3(ocv.upX, ocv.upY, ocv.upZ, selfCv);

      others[base + 0] = relPos[0];
      others[base + 1] = relPos[1];
      others[base + 2] = relPos[2];
      others[base + 3] = relVel[0];
      others[base + 4] = relVel[1];
      others[base + 5] = relVel[2];
      others[base + 6] = relAng[0];
      others[base + 7] = relAng[1];
      others[base + 8] = relAng[2];
      others[base + 9] = relFwd[0];
      others[base + 10] = relFwd[1];
      others[base + 11] = relFwd[2];
      others[base + 12] = relUp[0];
      others[base + 13] = relUp[1];
      others[base + 14] = relUp[2];
      others[base + 15] = 2 * o.team - 1;
      others[base + 16] = this.demoTimers[o.carIndex];
      others[base + 17] = ocv.isOnGround ? 1.0 : 0.0;
      others[base + 18] = ocv.isOnGround ? 1.0 : 0.0;
      others[base + 19] = ocv.hasFlipOrJump ? 1.0 : 0.0;
      others[base + 20] = Math.min(ocv.boost / 100.0, 2.0);
    }

    // 3. Populate 6 ball prediction slices (0s, 1s, 2s, 3s, 4s, 5s = ticks 0, 120, 240, 360, 480, 600)
    const predBuf = ensureSharedBallPrediction(simState, physicsEngine);
    const ball = this.ball;
    const rawAng = [sBallView.angVelX, sBallView.angVelY, sBallView.angVelZ];
    for (let step = 0; step < NUM_BALL_SLICES; step++) {
      const tickOff = step * 120 * 6;
      const bpx = predBuf[tickOff + 0];
      const bpy = predBuf[tickOff + 1];
      const bpz = predBuf[tickOff + 2];
      const bvx = predBuf[tickOff + 3];
      const bvy = predBuf[tickOff + 4];
      const bvz = predBuf[tickOff + 5];

      const relPos = matMulRot3(
        bpx - selfCv.posX,
        bpy - selfCv.posY,
        bpz - selfCv.posZ,
        selfCv
      );
      const relVel = matMulRot3(
        bvx - selfCv.velX,
        bvy - selfCv.velY,
        bvz - selfCv.velZ,
        selfCv
      );
      const relAng = matMulRot3(rawAng[0], rawAng[1], rawAng[2], selfCv);

      const dst = step * 9;
      ball[dst + 0] = relPos[0];
      ball[dst + 1] = relPos[1];
      ball[dst + 2] = relPos[2];
      ball[dst + 3] = relVel[0];
      ball[dst + 4] = relVel[1];
      ball[dst + 5] = relVel[2];
      ball[dst + 6] = relAng[0];
      ball[dst + 7] = relAng[1];
      ball[dst + 8] = relAng[2];
    }

    // 4. Populate action queue [6 * 8]
    if (this.isQueueReset) {
      this.actions.fill(0);
    } else {
      this.actions.set(this.actionQueue);
    }

    // 5. Populate boost pads [34 * 5] in local self frame
    const boosts = this.boosts;
    for (let p = 0; p < NUM_BOOST_PADS; p++) {
      const loc = CANONICAL_BOOST_LOCATIONS[p];
      const relPos = matMulRot3(
        loc[0] - selfCv.posX,
        loc[1] - selfCv.posY,
        loc[2] - selfCv.posZ,
        selfCv
      );
      const dst = p * 5;
      boosts[dst + 0] = relPos[0];
      boosts[dst + 1] = relPos[1];
      boosts[dst + 2] = relPos[2];
      boosts[dst + 3] = loc[2] > 72.0 ? 1.0 : 0.12;
      boosts[dst + 4] = this.boostTimers[p] / 10.0;
    }

    // 6. Orange team inversion
    if (normSelfTeam === 1) {
      for (let d = 0; d < 32; d++) {
        main[d] *= INVERT_TEAM_32[d];
      }
      for (let s = 0; s < otherList.length; s++) {
        const base = s * 21;
        for (let d = 15; d < 21; d++) {
          others[base + d] *= INVERT_TEAM_32[d];
        }
      }
      main[31] = 1.0; // is_swapped
    }

    // 7. Left-only X-side mirroring when `main[0] < 0`
    if (main[0] < 0) {
      for (let step = 0; step < NUM_BALL_SLICES; step++) {
        const dst = step * 9;
        for (let d = 0; d < 9; d++) {
          ball[dst + d] *= INVERT_SIDE_RELATIVE_32[d];
        }
      }
      for (let d = 0; d < 32; d++) {
        main[d] *= INVERT_SIDE_32[d];
      }
      for (let s = 0; s < otherList.length; s++) {
        const base = s * 21;
        for (let d = 0; d < 21; d++) {
          others[base + d] *= INVERT_SIDE_RELATIVE_32[d];
        }
      }
      for (let p = 0; p < NUM_BOOST_PADS; p++) {
        const dst = p * 5;
        boosts[dst + 0] *= INVERT_SIDE_RELATIVE_32[0];
        boosts[dst + 1] *= INVERT_SIDE_RELATIVE_32[1];
        boosts[dst + 2] *= INVERT_SIDE_RELATIVE_32[2];
      }
      for (let q = 0; q < ACTION_QUEUE_LEN; q++) {
        const dst = q * 8;
        for (let d = 0; d < 8; d++) {
          this.actions[dst + d] *= INVERT_SIDE_ACTIONS_8[d];
        }
      }
      main[29] *= -1.0;
      main[30] = 1.0; // is_flipped
    }

    // 8. Normalize all features by NORM_32
    for (let step = 0; step < NUM_BALL_SLICES; step++) {
      const dst = step * 9;
      for (let d = 0; d < 9; d++) {
        ball[dst + d] /= NORM_32[d];
      }
    }
    for (let d = 0; d < 32; d++) {
      main[d] /= NORM_32[d];
    }
    for (let s = 0; s < otherList.length; s++) {
      const base = s * 21;
      for (let d = 0; d < 21; d++) {
        others[base + d] /= NORM_32[d];
      }
    }
    for (let p = 0; p < NUM_BOOST_PADS; p++) {
      const dst = p * 5;
      boosts[dst + 0] /= NORM_32[0];
      boosts[dst + 1] /= NORM_32[1];
      boosts[dst + 2] /= NORM_32[2];
    }

    return {
      main,
      others,
      ball,
      actions: this.actions,
      boosts,
      isKickoff,
    };
  }

  /**
   * Pushes the newly selected action index (0..275) into the 6-step delayed queue
   * and returns the action at the tail of the queue (`actionQueue[5]`) as `CarControls`.
   * Matches `DelayedAction.parse_actions` in `src/act.py`.
   */
  stepDelayedActionQueue(actionIdx: number): CarControls {
    const newControls = RIPPLE_276_ACTIONS[actionIdx] || DEFAULT_CAR_CONTROLS;
    const newArr = encodeCarControls(newControls);

    if (this.isQueueReset) {
      for (let q = 0; q < ACTION_QUEUE_LEN; q++) {
        this.actionQueue.set(newArr, q * 8);
      }
      this.isQueueReset = false;
    }

    // Extract oldest action at index 5 before shifting
    const tailOff = (ACTION_QUEUE_LEN - 1) * 8;
    for (let d = 0; d < 8; d++) {
      this.prevExecutedAction[d] = this.actionQueue[tailOff + d];
    }

    // Shift queue down: actionQueue[1..5] = actionQueue[0..4]
    for (let q = ACTION_QUEUE_LEN - 1; q >= 1; q--) {
      const dst = q * 8;
      const src = (q - 1) * 8;
      for (let d = 0; d < 8; d++) {
        this.actionQueue[dst + d] = this.actionQueue[src + d];
      }
    }

    // Insert newest action at index 0
    for (let d = 0; d < 8; d++) {
      this.actionQueue[d] = newArr[d];
    }

    return decodeCarControls(this.prevExecutedAction);
  }
}
