import * as THREE from 'three';
/**
 * SpeedTrail.ts
 * Luminous ribbon particle trail emitted behind high-speed objects (such as the ball or supersonic vehicles).
 * Dynamically computes camera-facing ribbon geometry and smooth opacity based on velocity.
 */

export const SPEED_TRAIL_THRESHOLD_SPEED = 2000;
export const SPEED_TRAIL_OPACITY_LERP_RATE = 3;
export const SPEED_TRAIL_MAX_TIME_DILATION = 4;
export const SPEED_TRAIL_EMISSION_RATE = 45;
export const SPEED_TRAIL_MAX_POINT_AGE = 1.0;
export const SPEED_TRAIL_RIBBON_WIDTH = 64;
export const SPEED_TRAIL_MAX_OPACITY = 0.2;
export const SPEED_TRAIL_MAX_POINTS = 60;
export const SPEED_TRAIL_MAX_VERTICES = SPEED_TRAIL_MAX_POINTS + 1; // 61
export const SPEED_TRAIL_TELEPORT_RESET_DISTANCE = 512;
export const SPEED_TRAIL_ACTIVATION_GLOW_DURATION = 0.25;
export const SPEED_TRAIL_ACTIVATION_GLOW_SCALE = 256;
export const SPEED_TRAIL_VISIBLE_OPACITY_THRESHOLD = 0.015;

export const SPEED_TRAIL_VERTEX_SHADER = `
  attribute float aAcross;
  attribute float aLifeAlpha;
  varying float vAcross;
  varying float vLifeAlpha;
  void main() {
    vAcross = aAcross;
    vLifeAlpha = aLifeAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const SPEED_TRAIL_FRAGMENT_SHADER = `
  uniform float uOpacity;
  uniform vec3 uColor;
  varying float vAcross;
  varying float vLifeAlpha;
  void main() {
    // The recovered 64uu Size.X is the ribbon envelope, not a 64uu
    // opaque band. Preserve that geometry while matching the material's
    // much narrower cross-ribbon luminous profile.
    float crossSection = 1.0 - smoothstep(0.0, 0.32, abs(vAcross));
    float alpha = uOpacity * vLifeAlpha * crossSection;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

export function createSpeedTrailGlowTexture() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.28, "rgba(220,239,255,0.82)");
  gradient.addColorStop(0.7, "rgba(139,190,255,0.18)");
  gradient.addColorStop(1, "rgba(100,160,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);

  const { CanvasTexture, SRGBColorSpace } = THREE;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export interface SpeedTrailPoint {
  position: THREE.Vector3;
  age: number;
}

export class SpeedTrail {
  public side = new THREE.Vector3();
  public opacity = 0;
  public across = new Float32Array(SPEED_TRAIL_MAX_VERTICES * 2);
  public activationGlow: THREE.Sprite;
  public activationGlowAge = SPEED_TRAIL_ACTIVATION_GLOW_DURATION;
  public cameraPosition = new THREE.Vector3();
  public emissionClock = 0;
  public fallbackAxis = new THREE.Vector3(0, 1, 0);
  public geometry = new THREE.BufferGeometry();
  public geometryDirty = true;
  public glowGeometry: THREE.BufferGeometry | undefined;
  public glowMaterial: THREE.SpriteMaterial | undefined;
  public hasSourcePosition = false;
  public hasSpawnedStartupGlow = false;
  public indices = new Uint16Array((SPEED_TRAIL_MAX_VERTICES - 1) * 6);
  public isEmitting = false;
  public lastEmitting = false;
  public lifeAlpha = new Float32Array(SPEED_TRAIL_MAX_VERTICES * 2);
  public lifeAlphaAttribute: THREE.BufferAttribute;
  public material: THREE.ShaderMaterial;
  public object = new THREE.Group();
  public pointPool: SpeedTrailPoint[];
  public points: SpeedTrailPoint[] = [];
  public positionAttribute: THREE.BufferAttribute;
  public positions = new Float32Array(SPEED_TRAIL_MAX_VERTICES * 2 * 3);
  public previousSourcePosition = new THREE.Vector3();
  public previousSpeed = 0;
  public ribbon: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  public sourcePosition = new THREE.Vector3();
  public tangent = new THREE.Vector3();
  public timeDilation = 1;
  public viewDirection = new THREE.Vector3();
  private readonly _lastCameraPosition = new THREE.Vector3(NaN, NaN, NaN);

  constructor() {
    const {
      BufferAttribute,
      ShaderMaterial,
      Mesh,
      Sprite,
      SpriteMaterial,
      Vector3,
      Color,
      DynamicDrawUsage,
      AdditiveBlending,
      DoubleSide,
      NormalBlending
    } = THREE;

    this.pointPool = Array.from({ length: SPEED_TRAIL_MAX_POINTS }, () => ({
      position: new Vector3(),
      age: 0
    }));

    this.positionAttribute = new BufferAttribute(this.positions, 3);
    this.lifeAlphaAttribute = new BufferAttribute(this.lifeAlpha, 1);

    this.object.name = "ball-speed-trail";
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: NormalBlending,
      uniforms: {
        uOpacity: { value: 0 },
        uColor: { value: new Color(15398399) }
      },
      vertexShader: SPEED_TRAIL_VERTEX_SHADER,
      fragmentShader: SPEED_TRAIL_FRAGMENT_SHADER
    });
    this.material.toneMapped = true;

    for (let i = 0; i < SPEED_TRAIL_MAX_VERTICES; i++) {
      this.across[i * 2] = -1;
      this.across[i * 2 + 1] = 1;
    }
    for (let i = 0; i < SPEED_TRAIL_MAX_VERTICES - 1; i++) {
      const idx = i * 6;
      const v = i * 2;
      this.indices[idx] = v;
      this.indices[idx + 1] = v + 2;
      this.indices[idx + 2] = v + 1;
      this.indices[idx + 3] = v + 1;
      this.indices[idx + 4] = v + 2;
      this.indices[idx + 5] = v + 3;
    }

    this.positionAttribute.setUsage(DynamicDrawUsage);
    this.lifeAlphaAttribute.setUsage(DynamicDrawUsage);

    this.geometry.setAttribute("position", this.positionAttribute);
    this.geometry.setAttribute("aAcross", new BufferAttribute(this.across, 1));
    this.geometry.setAttribute("aLifeAlpha", this.lifeAlphaAttribute);
    this.geometry.setIndex(new BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, 0);

    this.ribbon = new Mesh(this.geometry, this.material);
    this.ribbon.name = "SpeedTrail_PS-ribbon";
    this.ribbon.visible = false;
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 1;

    const glowMaterial = new SpriteMaterial({
      map: createSpeedTrailGlowTexture(),
      color: 15332863,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: true
    });

    this.activationGlow = new Sprite(glowMaterial);
    this.activationGlow.name = "SpeedTrail_PS-activation-glow";
    this.activationGlow.scale?.setScalar?.(SPEED_TRAIL_ACTIVATION_GLOW_SCALE);
    this.activationGlow.visible = false;
    this.activationGlow.renderOrder = 2;

    this.object.add(this.ribbon, this.activationGlow);
  }

  private _acquirePoint(): SpeedTrailPoint {
    return (this.points.length >= SPEED_TRAIL_MAX_POINTS ? this.points.pop() : this.pointPool.pop())!;
  }

  private _clearPoints() {
    while (this.points.length > 0) {
      this.pointPool.push(this.points.pop()!);
    }
    this.emissionClock = 0;
    this.isEmitting = false;
    this.lastEmitting = false;
  }

  reset() {
    this._clearPoints();
    this.hasSourcePosition = false;
    this.previousSpeed = 0;
    this.hasSpawnedStartupGlow = false;
    this.activationGlowAge = SPEED_TRAIL_ACTIVATION_GLOW_DURATION;
    this.opacity = 0;
    if (this.material?.uniforms?.uOpacity) {
      this.material.uniforms.uOpacity.value = 0;
    }
    this.ribbon.visible = false;
    this.activationGlow.visible = false;
    this.geometry.setDrawRange(0, 0);
    this.geometryDirty = true;
  }

  update(sourcePos: THREE.Vector3, velocity: THREE.Vector3, dt: number) {
    const clampedDt = Math.max(0, Math.min(dt, 0.1));
    const speed = velocity.length();
    const isSupersonic = speed >= SPEED_TRAIL_THRESHOLD_SPEED;

    if (!this.hasSourcePosition) {
      this.sourcePosition.copy(sourcePos);
      this.previousSourcePosition.copy(sourcePos);
      this.previousSpeed = speed;
      this.hasSourcePosition = true;
    }

    const stepDist = sourcePos.distanceTo(this.previousSourcePosition);

    // Freeze trail state in place when replay or simulation is paused mid-flight.
    if (stepDist < 1e-3 && speed > 10 && clampedDt > 0) {
      return;
    }

    const maxStepSpeed = Math.max(speed, this.previousSpeed, SPEED_TRAIL_THRESHOLD_SPEED);
    const maxPlausibleStepDist = Math.max(320, maxStepSpeed * Math.max(clampedDt, 1 / 30) * 2.5 + 120);
    if (
      stepDist > SPEED_TRAIL_TELEPORT_RESET_DISTANCE ||
      (this.points.length > 0 && stepDist > maxPlausibleStepDist)
    ) {
      this._clearPoints();
      this.opacity = isSupersonic ? this.opacity : 0;
      this.previousSourcePosition.copy(sourcePos);
    }

    this.timeDilation = THREE.MathUtils.clamp(speed / SPEED_TRAIL_THRESHOLD_SPEED, 1, SPEED_TRAIL_MAX_TIME_DILATION);
    const targetOpacity = isSupersonic ? 1 : 0;
    const opacityLerpRate = isSupersonic || speed >= 1700 ? SPEED_TRAIL_OPACITY_LERP_RATE : 7.5;

    this.opacity += (targetOpacity - this.opacity) * Math.min(1, clampedDt * opacityLerpRate);
    if (!isSupersonic && this.opacity < SPEED_TRAIL_VISIBLE_OPACITY_THRESHOLD) {
      this.opacity = 0;
    } else if (Math.abs(this.opacity - targetOpacity) < 5e-4) {
      this.opacity = targetOpacity;
    }
    if (this.material?.uniforms?.uOpacity) {
      this.material.uniforms.uOpacity.value = this.opacity * SPEED_TRAIL_MAX_OPACITY;
    }

    const scaledDeltaTime = clampedDt * this.timeDilation;
    for (let i = 0; i < this.points.length; i++) {
      this.points[i].age += scaledDeltaTime;
    }
    while (this.points.length && this.points[this.points.length - 1].age >= SPEED_TRAIL_MAX_POINT_AGE) {
      this.pointPool.push(this.points.pop()!);
    }

    const shouldEmit = isSupersonic || (this.lastEmitting && this.opacity >= SPEED_TRAIL_VISIBLE_OPACITY_THRESHOLD);
    this.isEmitting = shouldEmit;

    if (shouldEmit) {
      const interval = 1 / SPEED_TRAIL_EMISSION_RATE;
      if (!this.lastEmitting) {
        const anchor = this._acquirePoint();
        anchor.position.copy(this.previousSourcePosition);
        anchor.age = scaledDeltaTime;
        this.points.unshift(anchor);
        this.emissionClock = 0;
      }

      if (stepDist >= 0.5) {
        this.emissionClock += scaledDeltaTime;
        while (this.emissionClock >= interval) {
          this.emissionClock -= interval;
          const subTime = this.emissionClock / this.timeDilation;
          const factor = clampedDt > 0 ? THREE.MathUtils.clamp(1 - subTime / clampedDt, 0, 1) : 1;
          if (this.points.length > 0) {
            const headPos = this.points[0].position;
            const dx = THREE.MathUtils.lerp(this.previousSourcePosition.x, sourcePos.x, factor) - headPos.x;
            const dy = THREE.MathUtils.lerp(this.previousSourcePosition.y, sourcePos.y, factor) - headPos.y;
            const dz = THREE.MathUtils.lerp(this.previousSourcePosition.z, sourcePos.z, factor) - headPos.z;
            if (dx * dx + dy * dy + dz * dz < 4.0) continue;
          }
          const pt = this._acquirePoint();
          pt.position.lerpVectors(this.previousSourcePosition, sourcePos, factor);
          pt.age = this.emissionClock;
          this.points.unshift(pt);
        }
      }
      this.lastEmitting = true;
    } else if (this.lastEmitting || this.points.length > 0) {
      this._clearPoints();
    }

    this.sourcePosition.copy(sourcePos);
    this.previousSourcePosition.copy(sourcePos);
    this.previousSpeed = speed;

    if (isSupersonic && !this.hasSpawnedStartupGlow) {
      this.hasSpawnedStartupGlow = true;
      this.activationGlowAge = 0;
      this.activationGlow.position?.copy?.(sourcePos);
      this.activationGlow.visible = true;
    } else if (!isSupersonic) {
      this.hasSpawnedStartupGlow = false;
    }

    if (this.activationGlowAge < SPEED_TRAIL_ACTIVATION_GLOW_DURATION) {
      this.activationGlowAge += scaledDeltaTime;
      const progress = THREE.MathUtils.clamp(this.activationGlowAge / SPEED_TRAIL_ACTIVATION_GLOW_DURATION, 0, 1);
      if (this.activationGlow.material) {
        this.activationGlow.material.opacity = (1 - progress) * (1 - progress);
      }
      this.activationGlow.position?.copy?.(sourcePos);
      this.activationGlow.visible = progress < 1;
    } else {
      this.activationGlow.visible = false;
    }

    this.ribbon.visible = this.opacity >= SPEED_TRAIL_VISIBLE_OPACITY_THRESHOLD && this.points.length > 0;
    this.geometryDirty = true;
  }

  prepare(camera: THREE.Camera | null | undefined) {
    this.rebuildGeometry(camera);
  }

  rebuildGeometry(camera: THREE.Camera | null | undefined) {
    if (!this.ribbon.visible) return;
    if (camera?.getWorldPosition) {
      camera.getWorldPosition(this.cameraPosition);
      if (this.cameraPosition.distanceToSquared(this._lastCameraPosition) > 1e-2) {
        this._lastCameraPosition.copy(this.cameraPosition);
        this.geometryDirty = true;
      }
    }
    if (!this.geometryDirty) return;
    this.geometryDirty = false;

    if (this.points.length === 0) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    const firstPointSkip =
      this.points.length >= 2 &&
      this.sourcePosition.distanceToSquared(this.points[0].position) < 4.0
        ? 1
        : 0;
    const activePointCount = this.points.length - firstPointSkip;
    if (
      activePointCount <= 0 ||
      (activePointCount === 1 &&
        this.sourcePosition.distanceToSquared(this.points[firstPointSkip].position) < 1.0)
    ) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    const totalVertices = Math.min(SPEED_TRAIL_MAX_VERTICES, activePointCount + 1);
    const halfWidth = SPEED_TRAIL_RIBBON_WIDTH * 0.5;

    const getPointPosition = (idx: number): THREE.Vector3 =>
      idx === 0 ? this.sourcePosition : this.points[firstPointSkip + idx - 1].position;
    const getPointAge = (idx: number): number =>
      idx === 0 ? 0 : this.points[firstPointSkip + idx - 1].age;

    for (let i = 0; i < totalVertices; i++) {
      const pos = getPointPosition(i);
      const prevPos = getPointPosition(Math.max(0, i - 1));
      const nextPos = getPointPosition(Math.min(totalVertices - 1, i + 1));

      this.tangent.subVectors(nextPos, prevPos);
      if (this.tangent.lengthSq() < 1e-4) {
        this.tangent.subVectors(pos, prevPos);
        if (this.tangent.lengthSq() < 1e-4) {
          this.tangent.set(1, 0, 0);
        }
      }
      this.tangent.normalize();

      this.viewDirection.subVectors(this.cameraPosition, pos).normalize();
      this.side.crossVectors(this.tangent, this.viewDirection);
      if (this.side.lengthSq() < 1e-6) {
        this.side.crossVectors(this.tangent, this.fallbackAxis);
        if (this.side.lengthSq() < 1e-6) {
          this.side.set(1, 0, 0);
        }
      }
      this.side.normalize().multiplyScalar(halfWidth);

      const age = getPointAge(i);
      const lifeFade = Math.pow(1 - THREE.MathUtils.clamp(age / SPEED_TRAIL_MAX_POINT_AGE, 0, 1), 1.35);

      for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
        const vertexIndex = i * 2 + sideIdx;
        const sign = sideIdx === 0 ? -1 : 1;
        this.positions[vertexIndex * 3] = pos.x + this.side.x * sign;
        this.positions[vertexIndex * 3 + 1] = pos.y + this.side.y * sign;
        this.positions[vertexIndex * 3 + 2] = pos.z + this.side.z * sign;
        this.lifeAlpha[vertexIndex] = lifeFade;
      }
    }

    this.positionAttribute.needsUpdate = true;
    this.lifeAlphaAttribute.needsUpdate = true;
    this.geometry.setDrawRange(0, (totalVertices - 1) * 6);
  }

  dispose() {
    this.geometry?.dispose?.();
    this.material?.dispose?.();
    this.glowGeometry?.dispose?.();
    this.glowMaterial?.dispose?.();
    this.object?.parent?.remove(this.object);
  }
}

