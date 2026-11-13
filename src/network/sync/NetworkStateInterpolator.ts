/**
 * src/network/sync/NetworkStateInterpolator.ts
 * Steady-state client snapshot interpolator for RoomStatePod frames,
 * reusing shortest-arc SLERP and cubic Hermite rigid-body math from RLRCHermiteSlerpMathPipeline.
 */

import { slerpShortestArcQuat } from '../../replay/rlrc/synthesis/RLRCQuaternionTrajectoryInterpolator.ts';
import type { RoomCarPodState, RoomStatePod } from '../protocol/RoomReplicationBusCodec.ts';

function hermiteScalar(
  p0: number,
  v0: number,
  p1: number,
  v1: number,
  t: number,
  dt: number
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * dt * v0 + h01 * p1 + h11 * dt * v1;
}

function hermiteVec3(
  p0: readonly [number, number, number],
  v0: readonly [number, number, number],
  p1: readonly [number, number, number],
  v1: readonly [number, number, number],
  t: number,
  dt: number
): [number, number, number] {
  return [
    hermiteScalar(p0[0], v0[0], p1[0], v1[0], t, dt),
    hermiteScalar(p0[1], v0[1], p1[1], v1[1], t, dt),
    hermiteScalar(p0[2], v0[2], p1[2], v1[2], t, dt),
  ];
}

export interface TimedRoomStateSnapshot {
  receivedMs: number;
  pod: RoomStatePod;
}

export class NetworkStateInterpolator {
  private readonly buffer: TimedRoomStateSnapshot[] = [];
  private readonly maxBufferedSnapshots: number;
  interpolationDelayMs: number;

  constructor(interpolationDelayMs = 24, maxBufferedSnapshots = 16) {
    this.interpolationDelayMs = interpolationDelayMs;
    this.maxBufferedSnapshots = maxBufferedSnapshots;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  pushSnapshot(pod: RoomStatePod, receivedMs = performance.now()): void {
    if (this.buffer.length > 0 && pod.tick <= this.buffer[this.buffer.length - 1].pod.tick) {
      // Replace latest if duplicate tick or ignore stale out-of-order snapshot
      if (pod.tick === this.buffer[this.buffer.length - 1].pod.tick) {
        this.buffer[this.buffer.length - 1] = { receivedMs, pod };
      }
      return;
    }
    this.buffer.push({ receivedMs, pod });
    while (this.buffer.length > this.maxBufferedSnapshots) {
      this.buffer.shift();
    }
  }

  sampleAt(renderNowMs = performance.now()): RoomStatePod | null {
    if (this.buffer.length === 0) return null;
    if (this.buffer.length === 1) return this.buffer[0].pod;

    const targetMs = renderNowMs - this.interpolationDelayMs;
    let prev = this.buffer[0];
    let next = this.buffer[this.buffer.length - 1];

    if (targetMs <= prev.receivedMs) return prev.pod;
    if (targetMs >= next.receivedMs) return next.pod;

    for (let i = 0; i < this.buffer.length - 1; i++) {
      const a = this.buffer[i];
      const b = this.buffer[i + 1];
      if (targetMs >= a.receivedMs && targetMs <= b.receivedMs) {
        prev = a;
        next = b;
        break;
      }
    }

    const spanMs = Math.max(1e-3, next.receivedMs - prev.receivedMs);
    const alpha = Math.max(0, Math.min(1, (targetMs - prev.receivedMs) / spanMs));
    const dtSeconds = spanMs / 1000;

    const prevCarBySlot = new Map<number, RoomCarPodState>();
    for (let i = 0; i < prev.pod.cars.length; i++) {
      prevCarBySlot.set(prev.pod.cars[i].slot, prev.pod.cars[i]);
    }

    const cars: RoomCarPodState[] = next.pod.cars.map((carNext) => {
      const carPrev = prevCarBySlot.get(carNext.slot);
      if (!carPrev) return carNext;
      const q = slerpShortestArcQuat(
        { x: carPrev.quat[0], y: carPrev.quat[1], z: carPrev.quat[2], w: carPrev.quat[3] },
        { x: carNext.quat[0], y: carNext.quat[1], z: carNext.quat[2], w: carNext.quat[3] },
        alpha
      );
      return {
        ...carNext,
        pos: hermiteVec3(carPrev.pos, carPrev.vel, carNext.pos, carNext.vel, alpha, dtSeconds),
        quat: [q.x, q.y, q.z, q.w],
        vel: [
          carPrev.vel[0] + (carNext.vel[0] - carPrev.vel[0]) * alpha,
          carPrev.vel[1] + (carNext.vel[1] - carPrev.vel[1]) * alpha,
          carPrev.vel[2] + (carNext.vel[2] - carPrev.vel[2]) * alpha,
        ],
      };
    });

    const ball =
      prev.pod.ball && next.pod.ball
        ? {
            pos: hermiteVec3(
              prev.pod.ball.pos,
              prev.pod.ball.vel,
              next.pod.ball.pos,
              next.pod.ball.vel,
              alpha,
              dtSeconds
            ),
            vel: next.pod.ball.vel,
            angVel: next.pod.ball.angVel,
          }
        : next.pod.ball;

    return {
      ...next.pod,
      ball,
      cars,
    };
  }
}
