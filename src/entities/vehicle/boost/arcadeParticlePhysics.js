import { boostParticleRuntimeConfig } from '../../../ui-core/config/vehicleTunerConfig.js';
import {
  ARCADE_DRIVE_COUNT,
  ARCADE_DRIVE_LIFE,
  ARCADE_DRIVE_SPAWN_RATE,
  ARCADE_TRAIL_COUNT,
  ARCADE_TRAIL_LIFE,
  ARCADE_TRAIL_DISTANCE,
  ARCADE_MAX_PARTICLES_PER_FRAME,
} from './boostCurves.js';
import * as THREE from 'three';

/**
 * Cartoon Boost particle state machine, distance-based spawning, and physics updates.
 */
export class ArcadeParticlePhysics {
  constructor(driveMesh, trailMesh, nozzleLocal) {
    const { Vector3 } = THREE;
    this.drive = driveMesh;
    this.trail = trailMesh;
    this.nozzleLocal = nozzleLocal;

    this.driveAge = new Float32Array(ARCADE_DRIVE_COUNT).fill(Infinity);
    this.driveBaseSize = new Float32Array(ARCADE_DRIVE_COUNT * 2);
    this.driveVelocity = new Float32Array(ARCADE_DRIVE_COUNT * 3);
    this.driveHead = 0;
    this.driveSpawnAccumulator = 0;
    this.driveParticlesActive = false;

    this.trailAge = new Float32Array(ARCADE_TRAIL_COUNT).fill(Infinity);
    this.trailMaxLife = new Float32Array(ARCADE_TRAIL_COUNT).fill(ARCADE_TRAIL_LIFE);
    this.trailScaleRefLife = new Float32Array(ARCADE_TRAIL_COUNT).fill(0.6);
    this.trailOpacityWeight = new Float32Array(ARCADE_TRAIL_COUNT).fill(1.0);
    this.trailBaseSize = new Float32Array(ARCADE_TRAIL_COUNT * 2);
    this.trailAcceleration = new Float32Array(ARCADE_TRAIL_COUNT);
    this.trailVelocity = new Float32Array(ARCADE_TRAIL_COUNT * 3);
    this.trailHead = 0;
    this.trailParticlesActive = false;

    this.previousNozzle = new Vector3();
    this.currentNozzle = new Vector3();
    this.hasPreviousNozzle = false;
    this.spawnRemainder = 0;
    this.shortSpawnRemainder = 0;
    this.longSpawnRemainder = 0;

    this._scratchPrevNozzle = new Vector3();
    this._scratchDelta = new Vector3();
    this._scratchParticlePos = new Vector3();
  }

  reset() {
    this.driveAge.fill(Infinity);
    this.trailAge.fill(Infinity);
    this.trailMaxLife.fill(ARCADE_TRAIL_LIFE);
    this.trailScaleRefLife.fill(0.6);
    this.trailOpacityWeight.fill(1.0);
    this.drive.opacity.fill(0);
    this.trail.opacity.fill(0);
    this.drive.markDirty();
    this.trail.markDirty();
    this.drive.mesh.visible = false;
    this.trail.mesh.visible = false;
    this.driveParticlesActive = false;
    this.trailParticlesActive = false;
    this.hasPreviousNozzle = false;
    this.spawnRemainder = 0;
    this.shortSpawnRemainder = 0;
    this.longSpawnRemainder = 0;
    this.driveSpawnAccumulator = 0;
  }

  spawnDrive(dt) {
    this.driveSpawnAccumulator += dt * ARCADE_DRIVE_SPAWN_RATE;
    if (!Number.isFinite(this.driveAge[(this.driveHead + ARCADE_DRIVE_COUNT - 1) % ARCADE_DRIVE_COUNT])) {
      this.driveSpawnAccumulator = Math.max(this.driveSpawnAccumulator, 1);
    }
    let spawned = 0;
    while (this.driveSpawnAccumulator >= 1 && spawned < ARCADE_MAX_PARTICLES_PER_FRAME) {
      this.driveSpawnAccumulator -= 1;
      const head = this.driveHead;
      this.driveHead = (head + 1) % ARCADE_DRIVE_COUNT;
      const pIdx = head * 3;
      const sIdx = head * 2;

      this.drive.offsets[pIdx] = this.nozzleLocal.x;
      this.drive.offsets[pIdx + 1] = this.nozzleLocal.y;
      this.drive.offsets[pIdx + 2] = this.nozzleLocal.z;

      this.driveVelocity[pIdx] = -(50 + Math.random() * 50);
      this.driveVelocity[pIdx + 1] = -5 + Math.random() * 10;
      this.driveVelocity[pIdx + 2] = -5 + Math.random() * 10;

      this.driveBaseSize[sIdx] = 6 + Math.random() * 3;
      this.driveBaseSize[sIdx + 1] = this.driveBaseSize[sIdx];

      this.drive.rotations[head] = Math.random() * Math.PI * 2;
      this.driveAge[head] = 0;
      this.driveParticlesActive = true;
      spawned++;
    }
  }

  spawnTrailByDistance(pos, dt) {
    const { MathUtils } = THREE;
    this.currentNozzle.copy(pos);

    const dualStream = Boolean(boostParticleRuntimeConfig.dualStreamEnabled);
    const baseSpawnMul = Math.max(0, boostParticleRuntimeConfig.trailSpawnMultiplier ?? 1.0);
    const shortMul = Math.max(0, boostParticleRuntimeConfig.shortTrailSpawnMultiplier ?? 1.0);
    const longMul = Math.max(0, boostParticleRuntimeConfig.longTrailSpawnMultiplier ?? 0.1);

    if (dualStream ? (shortMul <= 0.01 && longMul <= 0.01) : (baseSpawnMul <= 0.01)) {
      return;
    }

    if (!this.hasPreviousNozzle) {
      this.previousNozzle.copy(pos);
      this.hasPreviousNozzle = true;
      return;
    }

    this._scratchPrevNozzle.copy(this.previousNozzle);
    this._scratchDelta.subVectors(pos, this._scratchPrevNozzle);
    const dist = this._scratchDelta.length();
    if (dist < 1e-4) return;
    this._scratchDelta.divideScalar(dist);

    if (dist > 600) {
      this.previousNozzle.copy(pos);
      this.spawnRemainder = 0;
      this.shortSpawnRemainder = 0;
      this.longSpawnRemainder = 0;
      return;
    }

    if (dualStream) {
      const shortLife = Math.max(0.05, Number(boostParticleRuntimeConfig.shortTrailLifetime) || 0.1);
      const scaleRefLife = Math.max(0.1, Number(boostParticleRuntimeConfig.shortTrailScaleRefLife) || 0.6);
      const longLife = Math.max(shortLife + 0.05, Number(boostParticleRuntimeConfig.longTrailLifetime) || 2.0);
      const smoothBridge = boostParticleRuntimeConfig.smoothStreamTransition !== false;

      if (shortMul > 0.01) {
        const remS = this.shortSpawnRemainder;
        const invIntervalS = (1 / ARCADE_TRAIL_DISTANCE) * shortMul;
        const progS = remS + dist * invIntervalS;
        const countS = Math.floor(progS);
        const cappedS = Math.min(countS, ARCADE_MAX_PARTICLES_PER_FRAME);
        this.shortSpawnRemainder = progS - countS;
        for (let i = 0; i < cappedS; i++) {
          const t = (i + 1 - remS) / invIntervalS;
          this._scratchParticlePos.copy(this._scratchPrevNozzle).addScaledVector(this._scratchDelta, MathUtils.clamp(t, 0, dist));
          let particleLife = shortLife;
          let opacityWeight = 1.0;
          if (smoothBridge) {
            const u = Math.random();
            const bridgeSpan = Math.min(longLife, shortLife * 4.5);
            particleLife = shortLife * (0.85 + 0.3 * u) + (bridgeSpan - shortLife) * Math.pow(u, 2.8);
            const bridgeRatio = MathUtils.clamp((particleLife - shortLife) / Math.max(0.05, bridgeSpan - shortLife), 0, 1);
            opacityWeight = 1.0 - 0.55 * Math.sqrt(bridgeRatio);
          }
          this.spawnTrailParticle(this._scratchParticlePos, particleLife, scaleRefLife, opacityWeight);
        }
      }

      if (longMul > 0.01) {
        const remL = this.longSpawnRemainder;
        const invIntervalL = (1 / ARCADE_TRAIL_DISTANCE) * longMul;
        const progL = remL + dist * invIntervalL;
        const countL = Math.floor(progL);
        const cappedL = Math.min(countL, ARCADE_MAX_PARTICLES_PER_FRAME);
        this.longSpawnRemainder = progL - countL;
        for (let i = 0; i < cappedL; i++) {
          const t = (i + 1 - remL) / invIntervalL;
          this._scratchParticlePos.copy(this._scratchPrevNozzle).addScaledVector(this._scratchDelta, MathUtils.clamp(t, 0, dist));
          const jitteredLongLife = smoothBridge
            ? longLife * (0.7 + 0.45 * Math.random())
            : longLife;
          const farRefLife = Math.max(scaleRefLife, jitteredLongLife * 0.65);
          this.spawnTrailParticle(this._scratchParticlePos, jitteredLongLife, farRefLife, smoothBridge ? 0.78 : 1.0);
        }
      }
    } else {
      const singleLife = Math.max(0.08, ARCADE_TRAIL_LIFE * (boostParticleRuntimeConfig.trailLifeMultiplier ?? 1.0));
      const scaleRefLife = Math.max(0.1, Number(boostParticleRuntimeConfig.shortTrailScaleRefLife) || 0.6);
      const rem = this.spawnRemainder;
      const invInterval = (1 / ARCADE_TRAIL_DISTANCE) * baseSpawnMul;
      const progress = rem + dist * invInterval;
      const count = Math.floor(progress);
      const capped = Math.min(count, ARCADE_MAX_PARTICLES_PER_FRAME);

      this.spawnRemainder = progress - count;

      for (let i = 0; i < capped; i++) {
        const t = (i + 1 - rem) / invInterval;
        this._scratchParticlePos.copy(this._scratchPrevNozzle).addScaledVector(this._scratchDelta, MathUtils.clamp(t, 0, dist));
        this.spawnTrailParticle(this._scratchParticlePos, singleLife, scaleRefLife, 1.0);
      }
    }
    this.previousNozzle.copy(pos);
  }

  spawnTrailParticle(pos, customLifetime = null, customScaleRefLife = null, opacityWeight = 1.0) {
    const head = this.trailHead;
    this.trailHead = (head + 1) % ARCADE_TRAIL_COUNT;
    const pIdx = head * 3;
    const sIdx = head * 2;

    this.trail.offsets[pIdx] = pos.x;
    this.trail.offsets[pIdx + 1] = pos.y;
    this.trail.offsets[pIdx + 2] = pos.z;

    this.trailVelocity[pIdx] = 0;
    this.trailVelocity[pIdx + 1] = 0;
    this.trailVelocity[pIdx + 2] = 0;

    this.trailAcceleration[head] = 15 + Math.random() * 15;
    this.trailBaseSize[sIdx] = 16 + Math.random() * 6;
    this.trailBaseSize[sIdx + 1] = this.trailBaseSize[sIdx];

    this.trail.rotations[head] = Math.random() * Math.PI * 2;
    this.trailAge[head] = 0;
    this.trailMaxLife[head] = customLifetime !== null
      ? customLifetime
      : Math.max(0.08, ARCADE_TRAIL_LIFE * (boostParticleRuntimeConfig.trailLifeMultiplier ?? 1.0));
    this.trailScaleRefLife[head] = customScaleRefLife !== null
      ? customScaleRefLife
      : Math.max(0.1, Number(boostParticleRuntimeConfig.shortTrailScaleRefLife) || 0.6);
    this.trailOpacityWeight[head] = opacityWeight;
    this.trailParticlesActive = true;
  }

  updateDrive(dt) {
    let active = false;
    for (let i = 0; i < ARCADE_DRIVE_COUNT; i++) {
      this.driveAge[i] += dt;
      const progress = this.driveAge[i] / ARCADE_DRIVE_LIFE;
      const pIdx = i * 3;
      const sIdx = i * 2;

      if (progress >= 1) {
        this.drive.opacity[i] = 0;
        this.drive.sizes[sIdx] = this.drive.sizes[sIdx + 1] = 0;
        continue;
      }

      active = true;
      this.drive.offsets[pIdx] += this.driveVelocity[pIdx] * dt;
      this.drive.offsets[pIdx + 1] += this.driveVelocity[pIdx + 1] * dt;
      this.drive.offsets[pIdx + 2] += this.driveVelocity[pIdx + 2] * dt;

      const scale = (1 + progress * 1.5) * (1 - progress * progress);
      this.drive.sizes[sIdx] = this.driveBaseSize[sIdx] * scale;
      this.drive.sizes[sIdx + 1] = this.driveBaseSize[sIdx + 1] * scale;
      this.drive.opacity[i] = 0.5 * (1 - progress);
      this.drive.life[i] = progress;
    }
    this.driveParticlesActive = active;
    return active;
  }

  updateTrail(dt) {
    const { MathUtils } = THREE;
    let active = false;
    const useDistDecay = Boolean(boostParticleRuntimeConfig.distanceDecayEnabled);
    const falloffDist = Math.max(100, Number(boostParticleRuntimeConfig.distanceDecayFalloff) || 1200);
    const nozX = this.currentNozzle.x;
    const nozY = this.currentNozzle.y;
    const nozZ = this.currentNozzle.z;

    for (let i = 0; i < ARCADE_TRAIL_COUNT; i++) {
      this.trailAge[i] += dt;
      const age = this.trailAge[i];
      const effectiveLife = Math.max(0.05, this.trailMaxLife[i] || ARCADE_TRAIL_LIFE);
      const lifeProgress = age / effectiveLife;
      const pIdx = i * 3;
      const sIdx = i * 2;

      if (lifeProgress >= 1) {
        this.trail.opacity[i] = 0;
        this.trail.sizes[sIdx] = this.trail.sizes[sIdx + 1] = 0;
        continue;
      }

      active = true;
      const scaleRefLife = Math.max(0.1, this.trailScaleRefLife[i] || 0.6);
      const scaleProgress = Math.min(1.0, age / scaleRefLife);

      this.trailVelocity[pIdx + 1] += this.trailAcceleration[i] * dt;
      this.trail.offsets[pIdx + 1] += this.trailVelocity[pIdx + 1] * dt;

      let distAttenuation = 1.0;
      if (useDistDecay) {
        const dx = this.trail.offsets[pIdx] - nozX;
        const dy = this.trail.offsets[pIdx + 1] - nozY;
        const dz = this.trail.offsets[pIdx + 2] - nozZ;
        const distFromCar = Math.sqrt(dx * dx + dy * dy + dz * dz);
        distAttenuation = 1.0 - MathUtils.smoothstep(distFromCar, falloffDist * 0.15, falloffDist);
      }

      const scale = (0.65 + 0.6 * Math.sin(scaleProgress * Math.PI)) * (1 - scaleProgress * scaleProgress);
      this.trail.sizes[sIdx] = this.trailBaseSize[sIdx] * scale;
      this.trail.sizes[sIdx + 1] = this.trailBaseSize[sIdx + 1] * scale;
      const weight = this.trailOpacityWeight[i] ?? 1.0;
      this.trail.opacity[i] = 0.9 * (1 - MathUtils.smoothstep(lifeProgress, 0.5, 1)) * distAttenuation * weight;
      this.trail.life[i] = lifeProgress;
    }
    this.trailParticlesActive = active;
    return active;
  }
}
