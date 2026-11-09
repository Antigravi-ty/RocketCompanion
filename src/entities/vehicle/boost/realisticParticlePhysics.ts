import { boostParticleRuntimeConfig } from '../../../ui-core/config/vehicleTunerConfig.ts';
import {
  REALISTIC_DRIVE_COUNT,
  REALISTIC_DRIVE_LIFE,
  REALISTIC_DRIVE_RATE,
  REALISTIC_TRAIL_COUNT,
  REALISTIC_TRAIL_LIFE,
  REALISTIC_TRAIL_INTERVAL,
  REALISTIC_MAX_PARTICLES_PER_FRAME,
  CURVE_SCALE,
  CURVE_OPACITY,
  CURVE_VELOCITY,
  CURVE_DRIVE_SIZE,
  CURVE_DRIVE_COLOR,
  CURVE_DRIVE_OPACITY,
  CURVE_DYNAMIC_X,
  CURVE_DYNAMIC_Y,
  CURVE_DYNAMIC_Z,
  CURVE_DYNAMIC_W,
  evalCurveLut,
} from './boostCurves.ts';
import * as THREE from 'three';

import type { RealisticBoostParticleMesh } from './RealisticBoostParticleMesh.ts';

/**
 * Gold Rush Boost particle state machine, distance-based spawning, and physics updates.
 */
export class RealisticParticlePhysics {
  public _scratchB = new THREE.Vector3();
  public _scratchC = new THREE.Vector3();
  public _scratchD = new THREE.Vector3();
  public currentNozzle = new THREE.Vector3();
  public drive: RealisticBoostParticleMesh;
  public driveAge = new Float32Array(REALISTIC_DRIVE_COUNT).fill(Infinity);
  public driveBaseSize = new Float32Array(REALISTIC_DRIVE_COUNT * 2);
  public driveHead = 0;
  public driveParticlesActive = false;
  public driveSpawnAccumulator = 0;
  public driveVelocity = new Float32Array(REALISTIC_DRIVE_COUNT * 3);
  public hasPreviousNozzle = false;
  public longSpawnRemainder = 0;
  public nozzleLocal: THREE.Vector3;
  public previousNozzle = new THREE.Vector3();
  public shortSpawnRemainder = 0;
  public spawnRemainder = 0;
  public trail: RealisticBoostParticleMesh;
  public trailAcceleration = new Float32Array(REALISTIC_TRAIL_COUNT);
  public trailAge = new Float32Array(REALISTIC_TRAIL_COUNT).fill(Infinity);
  public trailBaseSize = new Float32Array(REALISTIC_TRAIL_COUNT * 2);
  public trailHead = 0;
  public trailMaxLife = new Float32Array(REALISTIC_TRAIL_COUNT).fill(REALISTIC_TRAIL_LIFE);
  public trailOpacityWeight = new Float32Array(REALISTIC_TRAIL_COUNT).fill(1.0);
  public trailParticlesActive = false;
  public trailScaleRefLife = new Float32Array(REALISTIC_TRAIL_COUNT).fill(0.6);
  public trailVelocity = new Float32Array(REALISTIC_TRAIL_COUNT * 3);

  constructor(
    driveMesh: RealisticBoostParticleMesh,
    trailMesh: RealisticBoostParticleMesh,
    nozzleLocal: THREE.Vector3
  ) {
    this.drive = driveMesh;
    this.trail = trailMesh;
    this.nozzleLocal = nozzleLocal;
  }

  reset() {
    if (
      !this.driveParticlesActive &&
      !this.trailParticlesActive &&
      !this.drive.mesh.visible &&
      !this.trail.mesh.visible
    ) {
      this.hasPreviousNozzle = false;
      this.spawnRemainder = 0;
      this.shortSpawnRemainder = 0;
      this.longSpawnRemainder = 0;
      return;
    }
    this.driveAge.fill(Infinity);
    this.trailAge.fill(Infinity);
    this.trailMaxLife.fill(REALISTIC_TRAIL_LIFE);
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

  spawnDrive(dt: number) {
    this.driveSpawnAccumulator += dt * REALISTIC_DRIVE_RATE;
    const prevIdx = (this.driveHead + REALISTIC_DRIVE_COUNT - 1) % REALISTIC_DRIVE_COUNT;
    if (!Number.isFinite(this.driveAge[prevIdx])) {
      this.driveSpawnAccumulator = Math.max(this.driveSpawnAccumulator, 1);
    }
    let spawned = 0;
    while (this.driveSpawnAccumulator >= 1 && spawned < REALISTIC_MAX_PARTICLES_PER_FRAME) {
      this.driveSpawnAccumulator -= 1;
      const head = this.driveHead;
      this.driveHead = (head + 1) % REALISTIC_DRIVE_COUNT;
      const pIdx = head * 3;
      const sIdx = head * 2;

      this.drive.offsets[pIdx] = this.nozzleLocal.x;
      this.drive.offsets[pIdx + 1] = this.nozzleLocal.y;
      this.drive.offsets[pIdx + 2] = this.nozzleLocal.z;

      this.driveVelocity[pIdx] = -(50 + Math.random() * 50);
      this.driveVelocity[pIdx + 1] = -5 + Math.random() * 10;
      this.driveVelocity[pIdx + 2] = -5 + Math.random() * 10;

      this.driveBaseSize[sIdx] = 6.5 + Math.random() * 6;
      this.driveBaseSize[sIdx + 1] = this.driveBaseSize[sIdx];

      this.drive.rotations[head] = Math.random() * Math.PI * 2;
      this.driveAge[head] = 0;
      this.driveParticlesActive = true;
      spawned++;
    }
  }

  spawnTrailByDistance(pos: THREE.Vector3, _dt?: number) {
    const { MathUtils } = THREE;
    this.currentNozzle.copy(pos);

    const dualStream = Boolean(boostParticleRuntimeConfig.dualStreamEnabled);
    const baseSpawnMul = Math.max(0, boostParticleRuntimeConfig.trailSpawnMultiplier ?? 1.0);
    const shortMul = Math.max(0, boostParticleRuntimeConfig.shortTrailSpawnMultiplier ?? 1.0);
    const longMul = Math.max(0, boostParticleRuntimeConfig.longTrailSpawnMultiplier ?? 0.1);

    if (dualStream ? shortMul <= 0.01 && longMul <= 0.01 : baseSpawnMul <= 0.01) {
      return;
    }

    if (!this.hasPreviousNozzle) {
      this.previousNozzle.copy(pos);
      this.hasPreviousNozzle = true;
      return;
    }

    this._scratchB.copy(this.previousNozzle);
    this._scratchC.subVectors(pos, this._scratchB);
    const dist = this._scratchC.length();
    if (dist < 1e-4) return;
    this._scratchC.divideScalar(dist);

    if (dist > 600) {
      this.previousNozzle.copy(pos);
      this.spawnRemainder = 0;
      this.shortSpawnRemainder = 0;
      this.longSpawnRemainder = 0;
      return;
    }

    const scaleRefLife = Math.max(
      0.1,
      Number(boostParticleRuntimeConfig.shortTrailScaleRefLife) || 0.6
    );

    if (dualStream) {
      const shortLife = Math.max(
        0.05,
        Number(boostParticleRuntimeConfig.shortTrailLifetime) || 0.1
      );
      const longLife = Math.max(
        shortLife + 0.05,
        Number(boostParticleRuntimeConfig.longTrailLifetime) || 2.0
      );
      const smoothBridge = boostParticleRuntimeConfig.smoothStreamTransition !== false;

      if (shortMul > 0.01) {
        const remS = this.shortSpawnRemainder;
        const stepS = ((Math.random() * 4) / REALISTIC_TRAIL_INTERVAL) * shortMul;
        const progS = remS + dist * stepS;
        const countS = Math.floor(progS);
        const cappedS = Math.min(countS, REALISTIC_MAX_PARTICLES_PER_FRAME);
        this.shortSpawnRemainder = progS - countS;
        if (stepS > 0) {
          const bridgeSpan = Math.min(longLife, shortLife * 4.5);
          for (let i = 0; i < cappedS; i++) {
            const t = (i + 1 - remS) / stepS;
            this._scratchD
              .copy(this._scratchB)
              .addScaledVector(this._scratchC, MathUtils.clamp(t, 0, dist));
            let particleLife = shortLife;
            let opacityWeight = 1.0;
            if (smoothBridge) {
              const u = Math.random();
              particleLife =
                shortLife * (0.85 + 0.3 * u) + (bridgeSpan - shortLife) * Math.pow(u, 2.8);
              const bridgeRatio = MathUtils.clamp(
                (particleLife - shortLife) / Math.max(0.05, bridgeSpan - shortLife),
                0,
                1
              );
              opacityWeight = 1.0 - 0.55 * Math.sqrt(bridgeRatio);
            }
            this.spawnTrailParticle(this._scratchD, particleLife, scaleRefLife, opacityWeight);
          }
        }
      }

      if (longMul > 0.01) {
        const remL = this.longSpawnRemainder;
        const stepL = ((Math.random() * 4) / REALISTIC_TRAIL_INTERVAL) * longMul;
        const progL = remL + dist * stepL;
        const countL = Math.floor(progL);
        const cappedL = Math.min(countL, REALISTIC_MAX_PARTICLES_PER_FRAME);
        this.longSpawnRemainder = progL - countL;
        if (stepL > 0) {
          for (let i = 0; i < cappedL; i++) {
            const t = (i + 1 - remL) / stepL;
            this._scratchD
              .copy(this._scratchB)
              .addScaledVector(this._scratchC, MathUtils.clamp(t, 0, dist));
            const jitteredLongLife = smoothBridge
              ? longLife * (0.7 + 0.45 * Math.random())
              : longLife;
            const farRefLife = Math.max(scaleRefLife, jitteredLongLife * 0.65);
            this.spawnTrailParticle(
              this._scratchD,
              jitteredLongLife,
              farRefLife,
              smoothBridge ? 0.78 : 1.0
            );
          }
        }
      }
    } else {
      const singleLife = Math.max(
        0.08,
        REALISTIC_TRAIL_LIFE * (boostParticleRuntimeConfig.trailLifeMultiplier ?? 1.0)
      );
      const rem = this.spawnRemainder;
      const step = ((Math.random() * 4) / REALISTIC_TRAIL_INTERVAL) * baseSpawnMul;
      const progress = rem + dist * step;
      const count = Math.floor(progress);
      const capped = Math.min(count, REALISTIC_MAX_PARTICLES_PER_FRAME);
      this.spawnRemainder = progress - count;

      if (step > 0) {
        for (let i = 0; i < capped; i++) {
          const t = (i + 1 - rem) / step;
          this._scratchD
            .copy(this._scratchB)
            .addScaledVector(this._scratchC, MathUtils.clamp(t, 0, dist));
          this.spawnTrailParticle(this._scratchD, singleLife, scaleRefLife, 1.0);
        }
      }
    }
    this.previousNozzle.copy(pos);
  }

  spawnTrailParticle(
    pos: THREE.Vector3,
    customLifetime: number | null = null,
    customScaleRefLife: number | null = null,
    opacityWeight = 1.0
  ) {
    const head = this.trailHead;
    this.trailHead = (head + 1) % REALISTIC_TRAIL_COUNT;
    const pIdx = head * 3;
    const sIdx = head * 2;

    this.trail.offsets[pIdx] = pos.x;
    this.trail.offsets[pIdx + 1] = pos.y;
    this.trail.offsets[pIdx + 2] = pos.z;

    this.trailVelocity[pIdx] = 0;
    this.trailVelocity[pIdx + 1] = 0;
    this.trailVelocity[pIdx + 2] = 0;

    this.trailAcceleration[head] = 15 + Math.random() * 15;
    this.trailBaseSize[sIdx] = 35 + Math.random() * 15;
    this.trailBaseSize[sIdx + 1] = this.trailBaseSize[sIdx];

    this.trail.rotations[head] = Math.random() * Math.PI * 2;
    this.trailAge[head] = 0;
    this.trailMaxLife[head] =
      customLifetime !== null
        ? customLifetime
        : Math.max(
            0.08,
            REALISTIC_TRAIL_LIFE * (boostParticleRuntimeConfig.trailLifeMultiplier ?? 1.0)
          );
    this.trailScaleRefLife[head] =
      customScaleRefLife !== null
        ? customScaleRefLife
        : Math.max(0.1, Number(boostParticleRuntimeConfig.shortTrailScaleRefLife) || 0.6);
    this.trailOpacityWeight[head] = opacityWeight;
    this.trailParticlesActive = true;
  }

  updateDrive(dt: number) {
    let active = false;
    for (let i = 0; i < REALISTIC_DRIVE_COUNT; i++) {
      this.driveAge[i] += dt;
      const progress = this.driveAge[i] / REALISTIC_DRIVE_LIFE;
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

      const sizeScale = evalCurveLut(CURVE_DRIVE_SIZE, progress);
      this.drive.sizes[sIdx] = this.driveBaseSize[sIdx] * sizeScale;
      this.drive.sizes[sIdx + 1] = this.driveBaseSize[sIdx + 1] * sizeScale;

      this.drive.opacity[i] = evalCurveLut(CURVE_DRIVE_OPACITY, progress);
      this.drive.colorScale[i] = evalCurveLut(CURVE_DRIVE_COLOR, progress);

      const dIdx = i * 4;
      this.drive.dynamic[dIdx] = evalCurveLut(CURVE_DYNAMIC_X, progress);
      this.drive.dynamic[dIdx + 1] = evalCurveLut(CURVE_DYNAMIC_Y, progress);
      this.drive.dynamic[dIdx + 2] = 1;
      this.drive.dynamic[dIdx + 3] = evalCurveLut(CURVE_DYNAMIC_W, progress);
    }
    this.driveParticlesActive = active;
    return active;
  }

  updateTrail(dt: number) {
    const { MathUtils } = THREE;
    let active = false;
    const useDistDecay = Boolean(boostParticleRuntimeConfig.distanceDecayEnabled);
    const falloffDist = Math.max(
      100,
      Number(boostParticleRuntimeConfig.distanceDecayFalloff) || 1200
    );
    const nozX = this.currentNozzle.x;
    const nozY = this.currentNozzle.y;
    const nozZ = this.currentNozzle.z;

    for (let i = 0; i < REALISTIC_TRAIL_COUNT; i++) {
      this.trailAge[i] += dt;
      const age = this.trailAge[i];
      const effectiveLife = Math.max(0.05, this.trailMaxLife[i] || REALISTIC_TRAIL_LIFE);
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

      const velScale = evalCurveLut(CURVE_VELOCITY, scaleProgress);
      this.trailVelocity[pIdx + 2] += this.trailAcceleration[i] * dt;
      this.trail.offsets[pIdx] += this.trailVelocity[pIdx] * velScale * dt;
      this.trail.offsets[pIdx + 1] += this.trailVelocity[pIdx + 1] * velScale * dt;
      this.trail.offsets[pIdx + 2] += this.trailVelocity[pIdx + 2] * velScale * dt;

      let distAttenuation = 1.0;
      if (useDistDecay) {
        const dx = this.trail.offsets[pIdx] - nozX;
        const dy = this.trail.offsets[pIdx + 1] - nozY;
        const dz = this.trail.offsets[pIdx + 2] - nozZ;
        const distFromCar = Math.sqrt(dx * dx + dy * dy + dz * dz);
        distAttenuation = 1.0 - MathUtils.smoothstep(distFromCar, falloffDist * 0.15, falloffDist);
      }

      this.trail.sizes[sIdx] = this.trailBaseSize[sIdx] * evalCurveLut(CURVE_SCALE, scaleProgress);
      this.trail.sizes[sIdx + 1] = this.trailBaseSize[sIdx + 1];

      const rampInProgress = Math.max(scaleProgress, Math.min(0.35, lifeProgress * 0.7));
      const baseOpacity = evalCurveLut(CURVE_OPACITY, rampInProgress);
      const cutoffFade = 1.0 - MathUtils.smoothstep(lifeProgress, 0.45, 1.0);
      const weight = this.trailOpacityWeight[i] ?? 1.0;
      this.trail.opacity[i] = baseOpacity * cutoffFade * distAttenuation * weight;
      this.trail.colorScale[i] = 1;

      const dIdx = i * 4;
      this.trail.dynamic[dIdx] = evalCurveLut(CURVE_DYNAMIC_X, scaleProgress);
      this.trail.dynamic[dIdx + 1] = evalCurveLut(CURVE_DYNAMIC_Y, scaleProgress);
      this.trail.dynamic[dIdx + 2] = 1;
      this.trail.dynamic[dIdx + 3] = evalCurveLut(CURVE_DYNAMIC_Z, lifeProgress);
    }
    this.trailParticlesActive = active;
    return active;
  }
}
