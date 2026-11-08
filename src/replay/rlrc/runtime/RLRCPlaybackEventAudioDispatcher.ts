/**
 * RLRCPlaybackEventAudioDispatcher.ts
 * Detects discrete rising/falling state edges between consecutive 120Hz RLRC replay frames
 * during smooth playback and dispatches spatial incident and signal audio cues to gameAudio.
 */

import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import type { CameraTransformLike } from '../../../audio/SpatialAudioSource.ts';
import type { PhysicsImpactAudioEvent } from '../../../audio/WorldImpactAudioHandler.ts';
import { INCIDENT_EVENT_TYPES } from '../../../physics/RocketSimConstants.ts';
import {
  RLRC_BOOST_PAD_COUNT,
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCFrame120Hz,
  type RLRCVec3,
} from '../RLRCReplayTypes.ts';

const BALL_HIT_CAR_PROXIMITY_UU = 290.0;
const BALL_HIT_MIN_DV_UU_S = 220.0;
const BALL_WORLD_HIT_MIN_DV_UU_S = 380.0;
const BALL_HIT_COOLDOWN_FRAMES = 8;

function vecDist(a: RLRCVec3, b: RLRCVec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class RLRCPlaybackEventAudioDispatcher {
  private _prevFrame: RLRCFrame120Hz | null = null;
  private _lastBallHitFrame = -100;
  private _lastCountdownNumber = 0;

  public reset(): void {
    this._prevFrame = null;
    this._lastBallHitFrame = -100;
    this._lastCountdownNumber = 0;
  }

  public stepFrame(
    currFrame: RLRCFrame120Hz,
    camera: CameraTransformLike | null | undefined,
    smoothStep: boolean
  ): void {
    const prev = this._prevFrame;
    this._prevFrame = currFrame;
    if (!smoothStep || !prev) {
      this._lastCountdownNumber = currFrame.roundCountdownNumber;
      return;
    }

    const frameDelta = currFrame.frameIndex120Hz - prev.frameIndex120Hz;
    if (frameDelta <= 0 || frameDelta > 8) {
      this._lastCountdownNumber = currFrame.roundCountdownNumber;
      return;
    }

    const cam = camera ?? null;
    const emit = (evt: PhysicsImpactAudioEvent): void => {
      gameAudio.handleEvent(evt, cam);
    };

    if (currFrame.roundCountdownNumber !== this._lastCountdownNumber) {
      if (currFrame.roundCountdownNumber > 0) {
        gameAudio.play('match_countdown_321', 1.0);
      } else if (this._lastCountdownNumber === 1 && currFrame.roundCountdownNumber === 0) {
        gameAudio.play('match_start_go', 1.0);
      }
      this._lastCountdownNumber = currFrame.roundCountdownNumber;
    }

    const goalScored =
      (prev.ball.entityActive && !currFrame.ball.entityActive) ||
      currFrame.blueScore > prev.blueScore ||
      currFrame.orangeScore > prev.orangeScore;
    if (goalScored) {
      const bp = prev.ball.rigidBody.position;
      emit({
        type: INCIDENT_EVENT_TYPES.GOAL_SCORED,
        x: bp.x, y: bp.y, z: bp.z,
        posX: bp.x, posY: bp.y, posZ: bp.z,
      });
      gameAudio.play('sfx_goal_poof', 1.0);
    }

    for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
      const pCar = prev.cars[slot];
      const cCar = currFrame.cars[slot];
      if (!pCar || !cCar) continue;

      if (pCar.entityActive && !cCar.entityActive && currFrame.roundCountdownNumber === 0 && !goalScored) {
        const dp = pCar.rigidBody.position;
        emit({
          type: INCIDENT_EVENT_TYPES.CAR_CAR_DEMO,
          carIndex: slot,
          secondaryId: slot,
          x: dp.x, y: dp.y, z: dp.z,
          posX: dp.x, posY: dp.y, posZ: dp.z,
        });
        continue;
      }

      if (!cCar.entityActive) continue;
      const cp = cCar.rigidBody.position;
      const pFl = pCar.activeFlags;
      const cFl = cCar.activeFlags;

      if (!pFl.jumpActive && cFl.jumpActive) {
        emit({ type: INCIDENT_EVENT_TYPES.CAR_JUMP, carIndex: slot, x: cp.x, y: cp.y, z: cp.z, posX: cp.x, posY: cp.y, posZ: cp.z });
      }
      if (!pFl.doubleJumpActive && cFl.doubleJumpActive) {
        emit({ type: INCIDENT_EVENT_TYPES.CAR_DOUBLE_JUMP, carIndex: slot, x: cp.x, y: cp.y, z: cp.z, posX: cp.x, posY: cp.y, posZ: cp.z });
      }
      if (!pFl.dodgeActive && cFl.dodgeActive) {
        emit({ type: INCIDENT_EVENT_TYPES.CAR_DODGE, carIndex: slot, x: cp.x, y: cp.y, z: cp.z, posX: cp.x, posY: cp.y, posZ: cp.z });
      }

      const wasBoosting = pCar.entityActive && (pFl.boostActive || pCar.controls.boost) && pCar.boostAmount > 0.5;
      const isBoosting = (cFl.boostActive || cCar.controls.boost) && cCar.boostAmount > 0.5;
      if (!wasBoosting && isBoosting) {
        emit({ type: INCIDENT_EVENT_TYPES.CAR_BOOST_START, carIndex: slot, x: cp.x, y: cp.y, z: cp.z, posX: cp.x, posY: cp.y, posZ: cp.z });
      } else if (wasBoosting && !isBoosting) {
        emit({ type: INCIDENT_EVENT_TYPES.CAR_BOOST_STOP, carIndex: slot, x: cp.x, y: cp.y, z: cp.z, posX: cp.x, posY: cp.y, posZ: cp.z });
      }

      if (pCar.entityActive && !pCar.isSupersonic && cCar.isSupersonic) {
        emit({ type: INCIDENT_EVENT_TYPES.CAR_SUPERSONIC_ENTER, carIndex: slot, x: cp.x, y: cp.y, z: cp.z, posX: cp.x, posY: cp.y, posZ: cp.z });
      }
    }

    if (prev.boostPadCooldowns && currFrame.boostPadCooldowns) {
      for (let p = 0; p < RLRC_BOOST_PAD_COUNT; p++) {
        const pCd = prev.boostPadCooldowns[p] ?? 0;
        const cCd = currFrame.boostPadCooldowns[p] ?? 0;
        if (pCd <= 1e-3 && cCd > 0.5) {
          emit({
            type: INCIDENT_EVENT_TYPES.BOOST_PICKUP,
            padIndex: p,
            isBig: cCd > 6.0,
          });
        }
      }
    }

    if (
      prev.ball.entityActive &&
      currFrame.ball.entityActive &&
      currFrame.frameIndex120Hz - this._lastBallHitFrame >= BALL_HIT_COOLDOWN_FRAMES
    ) {
      const pv = prev.ball.rigidBody.linearVelocity;
      const cv = currFrame.ball.rigidBody.linearVelocity;
      const dv = vecDist(cv, pv);
      if (dv >= BALL_HIT_MIN_DV_UU_S) {
        const bp = currFrame.ball.rigidBody.position;
        let nearestSlot = -1;
        let nearestDist = BALL_HIT_CAR_PROXIMITY_UU;
        for (let slot = 0; slot < RLRC_MAX_PLAYER_SLOTS; slot++) {
          const car = currFrame.cars[slot];
          if (!car?.entityActive) continue;
          const d = vecDist(car.rigidBody.position, bp);
          if (d < nearestDist) {
            nearestDist = d;
            nearestSlot = slot;
          }
        }
        if (nearestSlot >= 0) {
          this._lastBallHitFrame = currFrame.frameIndex120Hz;
          emit({
            type: INCIDENT_EVENT_TYPES.CAR_BALL_HIT,
            carIndex: nearestSlot,
            impulse: dv,
            relSpeed: dv,
            x: bp.x, y: bp.y, z: bp.z,
            posX: bp.x, posY: bp.y, posZ: bp.z,
          });
        } else if (dv >= BALL_WORLD_HIT_MIN_DV_UU_S) {
          this._lastBallHitFrame = currFrame.frameIndex120Hz;
          emit({
            type: INCIDENT_EVENT_TYPES.BALL_WORLD_HIT,
            impulse: dv,
            normalRelVel: dv,
            x: bp.x, y: bp.y, z: bp.z,
            posX: bp.x, posY: bp.y, posZ: bp.z,
          });
        }
      }
    }
  }
}
