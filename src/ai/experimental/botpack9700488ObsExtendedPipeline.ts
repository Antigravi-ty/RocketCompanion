/**
 * botpack9700488ObsExtendedPipeline.ts
 * Trajectory-predicting observation builders for Ducky (295), Fury (318), and Galactus v2 (258).
 */

import { CarStateView } from '../../physics/RocketSimStateViews.ts';
import { KICKOFF_SPAWN_PRESETS } from '../../physics/RocketSimConstants.ts';
import { encodeCarControls } from './experimentalMultiCarObsPipeline.ts';
import type { CarControls } from './botpack9700488Actions.ts';
import {
  POS_COEF,
  VEL_COEF,
  ANG_VEL_COEF,
  FURY_POS_COEF_X,
  FURY_POS_COEF_Y,
  FURY_POS_COEF_Z,
  FURY_VEL_COEF,
  FURY_ANG_VEL_COEF,
  BLUE_GOAL_BACK,
  ORANGE_GOAL_BACK,
  BIG_BOOST_PAD_INDICES,
  CANONICAL_BOOST_LOCATIONS,
  CANONICAL_TO_WASM_PAD_INDEX,
} from './botpack9700488Specs.ts';
import {
  sBallView,
  sPadView,
  sCarViews,
  ensureSharedBallPrediction,
  getCarPhys,
  getBallPhys,
  rotDot,
  collectTeammatesAndOpponents,
  type ActiveCarSlot,
  type BallPredictionEnginePort,
  type BuiltBotpackObs,
  type CarPhysSnapshot,
} from './botpackSharedBallPredPipeline.ts';
import {
  writeStandardPlayer29,
  writeBoostPads34,
} from './botpack9700488ObsCorePipeline.ts';

function safeUnit3(x: number, y: number, z: number): [number, number, number] {
  const lenSq = x * x + y * y + z * z;
  if (!Number.isFinite(lenSq) || lenSq <= 1e-6) return [0.0, 0.0, 0.0];
  const invLen = 1.0 / Math.sqrt(lenSq);
  return [x * invLen, y * invLen, z * invLen];
}

/**
 * 3. Ducky Observation Builder (`DuckyObs_V2_01(3)`, 295 floats)
 */
export function buildDuckyObs(
  simState: Float32Array,
  prevControls: CarControls,
  selfCarIndex: number,
  selfTeam: number,
  activeCars: ActiveCarSlot[] | null = null,
  physicsEngine: BallPredictionEnginePort | null = null
): BuiltBotpackObs {
  const normSelfTeam = selfTeam === 1 ? 1 : selfTeam === 0 ? 0 : selfCarIndex % 2;
  const inv = normSelfTeam === 1;
  const selfCv = (sCarViews[selfCarIndex] || new CarStateView()).attachCar(simState, selfCarIndex);
  sBallView.attach(simState);

  const ball = getBallPhys(sBallView, inv, false);
  const selfPhys = getCarPhys(selfCv, inv, false);
  const obs = new Float32Array(295);
  let ptr = 0;

  obs[ptr++] = ball.posX * POS_COEF;
  obs[ptr++] = ball.posY * POS_COEF;
  obs[ptr++] = ball.posZ * POS_COEF;
  obs[ptr++] = ball.velX * VEL_COEF;
  obs[ptr++] = ball.velY * VEL_COEF;
  obs[ptr++] = ball.velZ * VEL_COEF;
  obs[ptr++] = ball.angVelX * ANG_VEL_COEF;
  obs[ptr++] = ball.angVelY * ANG_VEL_COEF;
  obs[ptr++] = ball.angVelZ * ANG_VEL_COEF;

  const actArr = encodeCarControls(prevControls);
  for (let i = 0; i < 8; i++) obs[ptr++] = actArr[i];
  ptr = writeBoostPads34(obs, ptr, simState, inv, false, 1.0);

  const writeDuckyPlayer = (p: CarPhysSnapshot, includeOwnerRel: boolean) => {
    obs[ptr++] = p.posX * POS_COEF;
    obs[ptr++] = p.posY * POS_COEF;
    obs[ptr++] = p.posZ * POS_COEF;
    obs[ptr++] = p.fwdX;
    obs[ptr++] = p.fwdY;
    obs[ptr++] = p.fwdZ;
    obs[ptr++] = p.upX;
    obs[ptr++] = p.upY;
    obs[ptr++] = p.upZ;
    obs[ptr++] = p.velX * VEL_COEF;
    obs[ptr++] = p.velY * VEL_COEF;
    obs[ptr++] = p.velZ * VEL_COEF;

    const locAng = rotDot(p, p.angVelX, p.angVelY, p.angVelZ);
    obs[ptr++] = locAng[0] * ANG_VEL_COEF;
    obs[ptr++] = locAng[1] * ANG_VEL_COEF;
    obs[ptr++] = locAng[2] * ANG_VEL_COEF;

    const locBallPos = rotDot(p, ball.posX - p.posX, ball.posY - p.posY, ball.posZ - p.posZ);
    obs[ptr++] = locBallPos[0] * POS_COEF;
    obs[ptr++] = locBallPos[1] * POS_COEF;
    obs[ptr++] = locBallPos[2] * POS_COEF;

    const locBallVel = rotDot(p, ball.velX - p.velX, ball.velY - p.velY, ball.velZ - p.velZ);
    obs[ptr++] = locBallVel[0] * VEL_COEF;
    obs[ptr++] = locBallVel[1] * VEL_COEF;
    obs[ptr++] = locBallVel[2] * VEL_COEF;

    if (includeOwnerRel) {
      const relPos = rotDot(
        selfPhys,
        p.posX - selfPhys.posX,
        p.posY - selfPhys.posY,
        p.posZ - selfPhys.posZ
      );
      obs[ptr++] = relPos[0] * POS_COEF;
      obs[ptr++] = relPos[1] * POS_COEF;
      obs[ptr++] = relPos[2] * POS_COEF;

      const relVel = rotDot(
        selfPhys,
        p.velX - selfPhys.velX,
        p.velY - selfPhys.velY,
        p.velZ - selfPhys.velZ
      );
      obs[ptr++] = relVel[0] * VEL_COEF;
      obs[ptr++] = relVel[1] * VEL_COEF;
      obs[ptr++] = relVel[2] * VEL_COEF;
    }

    obs[ptr++] = Math.max(0, Math.min(1, p.boost / 100.0));
    obs[ptr++] = p.isOnGround ? 1.0 : 0.0;
    obs[ptr++] = p.hasFlipOrJump ? 1.0 : 0.0;
    obs[ptr++] = p.isDemoed ? 1.0 : 0.0;
    obs[ptr++] = p.hasJumped ? 1.0 : 0.0;
    obs[ptr++] = 1.0 / (1.0 + Math.max(0.0, p.demoRespawnTimer));
    const dodgeRem = p.isOnGround
      ? 1.0
      : !p.hasFlipOrJump
        ? 0.0
        : Math.max(0.0, 1.0 - p.airTimeSinceJump / 1.25);
    obs[ptr++] = dodgeRem;
    obs[ptr++] = p.isSupersonic ? 1.0 : 0.0;
  };

  writeDuckyPlayer(selfPhys, false);

  const { teammates, opponents } = collectTeammatesAndOpponents(
    simState,
    selfCarIndex,
    normSelfTeam,
    activeCars,
    2,
    3
  );
  for (let i = 0; i < 2; i++) {
    if (i < teammates.length) {
      writeDuckyPlayer(getCarPhys(teammates[i].cv, inv, false), true);
    } else {
      ptr += 35;
    }
  }
  for (let i = 0; i < 3; i++) {
    if (i < opponents.length) {
      writeDuckyPlayer(getCarPhys(opponents[i].cv, inv, false), true);
    } else {
      ptr += 35;
    }
  }

  const predBuf = ensureSharedBallPrediction(simState, physicsEngine, 3.05);
  const s = inv ? -1.0 : 1.0;
  const predTicks = [36, 120, 360];
  for (let i = 0; i < 3; i++) {
    const off = predTicks[i] * 6;
    const pbx = predBuf[off + 0] * s;
    const pby = predBuf[off + 1] * s;
    const pbz = predBuf[off + 2];
    const pvx = predBuf[off + 3] * s;
    const pvy = predBuf[off + 4] * s;
    const pvz = predBuf[off + 5];

    obs[ptr++] = pbx * POS_COEF;
    obs[ptr++] = pby * POS_COEF;
    obs[ptr++] = pbz * POS_COEF;
    obs[ptr++] = pvx * VEL_COEF;
    obs[ptr++] = pvy * VEL_COEF;
    obs[ptr++] = pvz * VEL_COEF;

    const locPos = rotDot(selfPhys, pbx - selfPhys.posX, pby - selfPhys.posY, pbz - selfPhys.posZ);
    obs[ptr++] = locPos[0] * POS_COEF;
    obs[ptr++] = locPos[1] * POS_COEF;
    obs[ptr++] = locPos[2] * POS_COEF;

    const locVel = rotDot(selfPhys, pvx - selfPhys.velX, pvy - selfPhys.velY, pvz - selfPhys.velZ);
    obs[ptr++] = locVel[0] * VEL_COEF;
    obs[ptr++] = locVel[1] * VEL_COEF;
    obs[ptr++] = locVel[2] * VEL_COEF;
  }

  const flatSpeed = Math.hypot(selfPhys.velX, selfPhys.velY);
  const velDirX = flatSpeed > 1.0 ? selfPhys.velX / flatSpeed : 0.0;
  const velDirY = flatSpeed > 1.0 ? selfPhys.velY / flatSpeed : 0.0;
  const speedFrac = Math.min(flatSpeed / 2300.0, 1.0);

  for (const wantBig of [true, false]) {
    let bestLoc: readonly [number, number, number] = [0, 0, 0];
    let bestCost = Infinity;
    let closestLoc: readonly [number, number, number] = [0, 0, 0];
    let closestDist = Infinity;

    for (let i = 0; i < 34; i++) {
      const loc = CANONICAL_BOOST_LOCATIONS[i];
      const isBig = loc[2] > 71.0;
      if (isBig !== wantBig) continue;

      const dx = loc[0] - selfPhys.posX;
      const dy = loc[1] - selfPhys.posY;
      const dist = Math.hypot(dx, dy);
      if (dist < closestDist) {
        closestDist = dist;
        closestLoc = loc;
      }

      const rawPadIdx = inv ? 33 - i : i;
      sPadView.attach(simState, CANONICAL_TO_WASM_PAD_INDEX[rawPadIdx]);
      const availSoon = sPadView.isActive || sPadView.cooldown <= 3.0;
      if (!availSoon) continue;

      const align = dist > 1.0 ? (velDirX * dx + velDirY * dy) / dist : 1.0;
      const cost = dist * (1.0 + speedFrac * (1.0 - align));
      if (cost < bestCost) {
        bestCost = cost;
        bestLoc = loc;
      }
    }

    const chosen = bestCost < Infinity ? bestLoc : closestLoc;
    const locPad = rotDot(
      selfPhys,
      chosen[0] - selfPhys.posX,
      chosen[1] - selfPhys.posY,
      chosen[2] - selfPhys.posZ
    );
    obs[ptr++] = locPad[0] * POS_COEF;
    obs[ptr++] = locPad[1] * POS_COEF;
  }

  return { obs, selfCarView: selfCv };
}

/**
 * 4. Fury Observation Builder (`FuryOBSPadded200B(3)`, 318 floats)
 */
export function buildFuryObs(
  simState: Float32Array,
  prevControls: CarControls,
  selfCarIndex: number,
  selfTeam: number,
  activeCars: ActiveCarSlot[] | null = null,
  physicsEngine: BallPredictionEnginePort | null = null
): BuiltBotpackObs {
  const normSelfTeam = selfTeam === 1 ? 1 : selfTeam === 0 ? 0 : selfCarIndex % 2;
  const inv = normSelfTeam === 1;
  const selfCv = (sCarViews[selfCarIndex] || new CarStateView()).attachCar(simState, selfCarIndex);
  sBallView.attach(simState);

  const ball = getBallPhys(sBallView, inv, false);
  const selfPhys = getCarPhys(selfCv, inv, false);
  const obs = new Float32Array(318);
  let ptr = 0;

  obs[ptr++] = ball.posX * FURY_POS_COEF_X;
  obs[ptr++] = ball.posY * FURY_POS_COEF_Y;
  obs[ptr++] = ball.posZ * FURY_POS_COEF_Z;
  obs[ptr++] = ball.velX * FURY_VEL_COEF;
  obs[ptr++] = ball.velY * FURY_VEL_COEF;
  obs[ptr++] = ball.velZ * FURY_VEL_COEF;
  obs[ptr++] = ball.angVelX * FURY_ANG_VEL_COEF;
  obs[ptr++] = ball.angVelY * FURY_ANG_VEL_COEF;
  obs[ptr++] = ball.angVelZ * FURY_ANG_VEL_COEF;

  const actArr = encodeCarControls(prevControls);
  for (let i = 0; i < 8; i++) obs[ptr++] = actArr[i];
  ptr = writeBoostPads34(obs, ptr, simState, inv, false, 1.0);

  const { teammates, opponents, roster } = collectTeammatesAndOpponents(
    simState,
    selfCarIndex,
    normSelfTeam,
    activeCars,
    2,
    3
  );

  const ballCentered =
    Math.abs(sBallView.posX) <= 10.0 &&
    Math.abs(sBallView.posY) <= 10.0 &&
    Math.abs(sBallView.posZ - 93.15) <= 25.0;
  const ballStationary =
    sBallView.velX * sBallView.velX +
      sBallView.velY * sBallView.velY +
      sBallView.velZ * sBallView.velZ <=
    25.0;
  const isKickoffActive = ballCentered && ballStationary;

  let anyCarMoving = false;
  for (let i = 0; i < roster.length; i++) {
    const cv = (sCarViews[roster[i].carIndex] || new CarStateView()).attachCar(
      simState,
      roster[i].carIndex
    );
    if (cv.velX * cv.velX + cv.velY * cv.velY + cv.velZ * cv.velZ > 225.0) {
      anyCarMoving = true;
      break;
    }
  }
  const koStateNorm = isKickoffActive ? (anyCarMoving ? 2.0 / 3.0 : 1.0 / 3.0) : 0.0;
  obs[ptr++] = koStateNorm;

  const distToBall = Math.hypot(
    selfCv.posX - sBallView.posX,
    selfCv.posY - sBallView.posY,
    selfCv.posZ - sBallView.posZ
  );
  obs[ptr++] = distToBall * FURY_POS_COEF_X;

  let roleInt = 0;
  if (isKickoffActive) {
    const myTeamSize = 1 + teammates.length;
    const oppTeamSize = opponents.length;
    if (!(myTeamSize === 1 && oppTeamSize >= 2)) {
      const teamCars = [{ carIndex: selfCarIndex, cv: selfCv }, ...teammates];
      const sortEntries = teamCars.map((tc) => {
        const tFlip = normSelfTeam === 1 ? -1.0 : 1.0;
        let bestSpawnDist = Infinity;
        let bestSpawnY = 0.0;
        for (let sIdx = 0; sIdx < KICKOFF_SPAWN_PRESETS.length; sIdx++) {
          const sp = KICKOFF_SPAWN_PRESETS[sIdx].team0;
          const sx = sp.x * tFlip;
          const sy = sp.y * tFlip;
          const d = (tc.cv.posX - sx) ** 2 + (tc.cv.posY - sy) ** 2;
          if (d < bestSpawnDist) {
            bestSpawnDist = d;
            bestSpawnY = Math.abs(sy);
          }
        }
        return {
          carIndex: tc.carIndex,
          absCenterDist: bestSpawnY,
          teamLocalX: tc.cv.posX * tFlip,
        };
      });
      sortEntries.sort((a, b) => {
        if (Math.abs(a.absCenterDist - b.absCenterDist) > 40.0) {
          return a.absCenterDist - b.absCenterDist;
        }
        return b.teamLocalX - a.teamLocalX;
      });
      const rank = sortEntries.findIndex((e) => e.carIndex === selfCarIndex);
      roleInt = rank <= 0 ? 1 : rank === 1 ? 2 : 3;
    }
  }
  obs[ptr++] = roleInt / 3.0;

  let minSpawnDist = Infinity;
  for (let sIdx = 0; sIdx < KICKOFF_SPAWN_PRESETS.length; sIdx++) {
    const sp = KICKOFF_SPAWN_PRESETS[sIdx].team0;
    const d = Math.hypot(selfPhys.posX - sp.x, selfPhys.posY - sp.y, selfPhys.posZ - 17.0);
    if (d < minSpawnDist) minSpawnDist = d;
  }
  obs[ptr++] = minSpawnDist * FURY_POS_COEF_X;

  const predBuf = ensureSharedBallPrediction(simState, physicsEngine, 2.05);
  const s = inv ? -1.0 : 1.0;
  const furyPredTicks = [60, 120, 180, 240];
  for (let i = 0; i < 4; i++) {
    const off = furyPredTicks[i] * 6;
    obs[ptr++] = predBuf[off + 0] * s * FURY_POS_COEF_X;
    obs[ptr++] = predBuf[off + 1] * s * FURY_POS_COEF_Y;
    obs[ptr++] = predBuf[off + 2] * FURY_POS_COEF_Z;
    obs[ptr++] = predBuf[off + 3] * s * FURY_VEL_COEF;
    obs[ptr++] = predBuf[off + 4] * s * FURY_VEL_COEF;
    obs[ptr++] = predBuf[off + 5] * FURY_VEL_COEF;
  }

  const distToOwnGoal = Math.hypot(
    selfPhys.posX - BLUE_GOAL_BACK[0],
    selfPhys.posY - BLUE_GOAL_BACK[1],
    selfPhys.posZ - BLUE_GOAL_BACK[2]
  );
  const distToEnemyGoal = Math.hypot(
    selfPhys.posX - ORANGE_GOAL_BACK[0],
    selfPhys.posY - ORANGE_GOAL_BACK[1],
    selfPhys.posZ - ORANGE_GOAL_BACK[2]
  );
  const ballDistToEnemyGoal = Math.hypot(
    ball.posX - ORANGE_GOAL_BACK[0],
    ball.posY - ORANGE_GOAL_BACK[1],
    ball.posZ - ORANGE_GOAL_BACK[2]
  );
  const bToEnemyUnit = safeUnit3(
    ORANGE_GOAL_BACK[0] - ball.posX,
    ORANGE_GOAL_BACK[1] - ball.posY,
    ORANGE_GOAL_BACK[2] - ball.posZ
  );
  const bToOwnUnit = safeUnit3(
    BLUE_GOAL_BACK[0] - ball.posX,
    BLUE_GOAL_BACK[1] - ball.posY,
    BLUE_GOAL_BACK[2] - ball.posZ
  );
  const ballSpdEnemy =
    ball.velX * bToEnemyUnit[0] + ball.velY * bToEnemyUnit[1] + ball.velZ * bToEnemyUnit[2];
  const ballSpdOwn =
    ball.velX * bToOwnUnit[0] + ball.velY * bToOwnUnit[1] + ball.velZ * bToOwnUnit[2];

  obs[ptr++] = distToOwnGoal * FURY_POS_COEF_X;
  obs[ptr++] = distToEnemyGoal * FURY_POS_COEF_X;
  obs[ptr++] = ballDistToEnemyGoal * FURY_POS_COEF_X;
  obs[ptr++] = ballSpdEnemy * FURY_VEL_COEF;
  obs[ptr++] = ballSpdOwn * FURY_VEL_COEF;

  const writeFuryPlayer39 = (carIndex: number, carTeam: number, cv: CarStateView) => {
    const p = getCarPhys(cv, inv, false);
    obs[ptr++] = p.posX * FURY_POS_COEF_X;
    obs[ptr++] = p.posY * FURY_POS_COEF_Y;
    obs[ptr++] = p.posZ * FURY_POS_COEF_Z;
    obs[ptr++] = p.fwdX;
    obs[ptr++] = p.fwdY;
    obs[ptr++] = p.fwdZ;
    obs[ptr++] = p.upX;
    obs[ptr++] = p.upY;
    obs[ptr++] = p.upZ;
    obs[ptr++] = p.velX * FURY_VEL_COEF;
    obs[ptr++] = p.velY * FURY_VEL_COEF;
    obs[ptr++] = p.velZ * FURY_VEL_COEF;
    obs[ptr++] = p.angVelX * FURY_ANG_VEL_COEF;
    obs[ptr++] = p.angVelY * FURY_ANG_VEL_COEF;
    obs[ptr++] = p.angVelZ * FURY_ANG_VEL_COEF;

    const locAng = rotDot(p, p.angVelX, p.angVelY, p.angVelZ);
    obs[ptr++] = locAng[0] * FURY_ANG_VEL_COEF;
    obs[ptr++] = locAng[1] * FURY_ANG_VEL_COEF;
    obs[ptr++] = locAng[2] * FURY_ANG_VEL_COEF;

    const locBallPos = rotDot(p, ball.posX - p.posX, ball.posY - p.posY, ball.posZ - p.posZ);
    obs[ptr++] = locBallPos[0] * FURY_POS_COEF_X;
    obs[ptr++] = locBallPos[1] * FURY_POS_COEF_Y;
    obs[ptr++] = locBallPos[2] * FURY_POS_COEF_Z;

    const locBallVel = rotDot(p, ball.velX - p.velX, ball.velY - p.velY, ball.velZ - p.velZ);
    obs[ptr++] = locBallVel[0] * FURY_VEL_COEF;
    obs[ptr++] = locBallVel[1] * FURY_VEL_COEF;
    obs[ptr++] = locBallVel[2] * FURY_VEL_COEF;

    obs[ptr++] = Math.max(0, Math.min(1, p.boost / 100.0));
    obs[ptr++] = p.isOnGround ? 1.0 : 0.0;
    obs[ptr++] = p.hasFlipOrJump ? 1.0 : 0.0;
    obs[ptr++] = p.hasFlipReset ? 1.0 : 0.0;
    obs[ptr++] = p.isDemoed ? 1.0 : 0.0;
    obs[ptr++] = p.hasJumped ? 1.0 : 0.0;

    const toOwnUnit = safeUnit3(
      BLUE_GOAL_BACK[0] - p.posX,
      BLUE_GOAL_BACK[1] - p.posY,
      BLUE_GOAL_BACK[2] - p.posZ
    );
    const toEnemyUnit = safeUnit3(
      ORANGE_GOAL_BACK[0] - p.posX,
      ORANGE_GOAL_BACK[1] - p.posY,
      ORANGE_GOAL_BACK[2] - p.posZ
    );
    obs[ptr++] = toOwnUnit[0];
    obs[ptr++] = toOwnUnit[1];
    obs[ptr++] = toOwnUnit[2];
    obs[ptr++] = toEnemyUnit[0];
    obs[ptr++] = toEnemyUnit[1];
    obs[ptr++] = toEnemyUnit[2];

    let minMateDistSq = Infinity;
    let mateDx = 0.0;
    let mateDy = 0.0;
    let mateDz = 0.0;
    for (let rIdx = 0; rIdx < roster.length; rIdx++) {
      const other = roster[rIdx];
      const otherTeam = other.team === 1 ? 1 : 0;
      if (other.carIndex === carIndex || otherTeam !== carTeam) continue;
      const ocv = (sCarViews[other.carIndex] || new CarStateView()).attachCar(
        simState,
        other.carIndex
      );
      const dx = ocv.posX - cv.posX;
      const dy = ocv.posY - cv.posY;
      const dz = ocv.posZ - cv.posZ;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < minMateDistSq) {
        minMateDistSq = dSq;
        mateDx = dx;
        mateDy = dy;
        mateDz = dz;
      }
    }
    const mateUnit = safeUnit3(mateDx * s, mateDy * s, mateDz);
    obs[ptr++] = mateUnit[0];
    obs[ptr++] = mateUnit[1];
    obs[ptr++] = mateUnit[2];
  };

  writeFuryPlayer39(selfCarIndex, normSelfTeam, selfCv);
  for (let i = 0; i < 2; i++) {
    if (i < teammates.length) {
      writeFuryPlayer39(teammates[i].carIndex, teammates[i].team, teammates[i].cv);
    } else {
      ptr += 39;
    }
  }
  for (let i = 0; i < 3; i++) {
    if (i < opponents.length) {
      writeFuryPlayer39(opponents[i].carIndex, opponents[i].team, opponents[i].cv);
    } else {
      ptr += 39;
    }
  }

  return { obs, selfCarView: selfCv };
}

/**
 * 5. Galactus v2 Observation Builder (`GalactusOBS(3)`, 258 floats)
 */
export function buildGalactusObs(
  simState: Float32Array,
  prevControls: CarControls,
  selfCarIndex: number,
  selfTeam: number,
  activeCars: ActiveCarSlot[] | null = null,
  physicsEngine: BallPredictionEnginePort | null = null
): BuiltBotpackObs {
  const normSelfTeam = selfTeam === 1 ? 1 : selfTeam === 0 ? 0 : selfCarIndex % 2;
  const inv = normSelfTeam === 1;
  const selfCv = (sCarViews[selfCarIndex] || new CarStateView()).attachCar(simState, selfCarIndex);
  sBallView.attach(simState);

  const ball = getBallPhys(sBallView, inv, false);
  const selfPhys = getCarPhys(selfCv, inv, false);
  const obs = new Float32Array(258);
  let ptr = 0;

  obs[ptr++] = ball.posX * POS_COEF;
  obs[ptr++] = ball.posY * POS_COEF;
  obs[ptr++] = ball.posZ * POS_COEF;
  obs[ptr++] = ball.velX * VEL_COEF;
  obs[ptr++] = ball.velY * VEL_COEF;
  obs[ptr++] = ball.velZ * VEL_COEF;
  obs[ptr++] = ball.angVelX * ANG_VEL_COEF;
  obs[ptr++] = ball.angVelY * ANG_VEL_COEF;
  obs[ptr++] = ball.angVelZ * ANG_VEL_COEF;

  const actArr = encodeCarControls(prevControls);
  for (let i = 0; i < 8; i++) obs[ptr++] = actArr[i];

  ptr = writeBoostPads34(obs, ptr, simState, inv, false, 1.0);

  let nearestRelX = 0.0;
  let nearestRelY = 0.0;
  let nearestRelZ = 0.0;
  let nearestDistSq = 1500.0 * 1500.0;
  for (const padIdx of BIG_BOOST_PAD_INDICES) {
    const canonicalPadIdx = inv ? 33 - padIdx : padIdx;
    sPadView.attach(simState, CANONICAL_TO_WASM_PAD_INDEX[canonicalPadIdx]);
    if (!sPadView.isActive) continue;
    const loc = CANONICAL_BOOST_LOCATIONS[padIdx];
    const rx = loc[0] - selfPhys.posX;
    const ry = loc[1] - selfPhys.posY;
    const rz = loc[2] - selfPhys.posZ;
    const distSq2D = rx * rx + ry * ry;
    if (distSq2D <= nearestDistSq) {
      nearestDistSq = distSq2D;
      nearestRelX = rx;
      nearestRelY = ry;
      nearestRelZ = rz;
    }
  }
  obs[ptr++] = nearestRelX * POS_COEF;
  obs[ptr++] = nearestRelY * POS_COEF;
  obs[ptr++] = nearestRelZ * POS_COEF;

  ptr = writeStandardPlayer29(obs, ptr, selfPhys, ball);
  const { teammates, opponents } = collectTeammatesAndOpponents(
    simState,
    selfCarIndex,
    normSelfTeam,
    activeCars,
    2,
    3
  );
  for (let i = 0; i < 2; i++) {
    if (i < teammates.length) {
      ptr = writeStandardPlayer29(obs, ptr, getCarPhys(teammates[i].cv, inv, false), ball);
    } else {
      ptr += 29;
    }
  }
  for (let i = 0; i < 3; i++) {
    if (i < opponents.length) {
      ptr = writeStandardPlayer29(obs, ptr, getCarPhys(opponents[i].cv, inv, false), ball);
    } else {
      ptr += 29;
    }
  }

  const predBuf = ensureSharedBallPrediction(simState, physicsEngine, 2.05);
  const s = inv ? -1.0 : 1.0;
  const galPredTicks = [30, 60, 120, 180, 240];
  for (let i = 0; i < 5; i++) {
    const off = galPredTicks[i] * 6;
    obs[ptr++] = predBuf[off + 0] * s * POS_COEF;
    obs[ptr++] = predBuf[off + 1] * s * POS_COEF;
    obs[ptr++] = predBuf[off + 2] * POS_COEF;
    obs[ptr++] = predBuf[off + 3] * s * VEL_COEF;
    obs[ptr++] = predBuf[off + 4] * s * VEL_COEF;
    obs[ptr++] = predBuf[off + 5] * VEL_COEF;
  }

  return { obs, selfCarView: selfCv };
}
