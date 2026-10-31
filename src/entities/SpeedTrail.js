import * as THREE from 'three';
/**
 * SpeedTrail.js
 * Luminous ribbon particle trail emitted behind high-speed objects (such as the ball or supersonic vehicles).
 * Dynamically computes camera-facing ribbon geometry and smooth opacity based on velocity.
 */

export const SPEED_TRAIL_THRESHOLD_SPEED = 2000;
export const SPEED_TRAIL_OPACITY_LERP_RATE = 3;
export const SPEED_TRAIL_MAX_TIME_DILATION = 4;
export const SPEED_TRAIL_EMISSION_RATE = 15;
export const SPEED_TRAIL_MAX_POINT_AGE = 1.0;
export const SPEED_TRAIL_RIBBON_WIDTH = 64;
export const SPEED_TRAIL_MAX_OPACITY = 0.2;
export const SPEED_TRAIL_MAX_POINTS = 60;
export const SPEED_TRAIL_MAX_VERTICES = SPEED_TRAIL_MAX_POINTS + 1; // 61
export const SPEED_TRAIL_TELEPORT_RESET_DISTANCE = 1024;
export const SPEED_TRAIL_ACTIVATION_GLOW_DURATION = 0.25;
export const SPEED_TRAIL_ACTIVATION_GLOW_SCALE = 256;

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

export class SpeedTrail {
  constructor() {
    const {
      Group,
      BufferGeometry,
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

    this.object = new Group();
    this.geometry = new BufferGeometry();
    this.points = [];
    this.pointPool = Array.from({ length: SPEED_TRAIL_MAX_POINTS }, () => ({
      position: new Vector3(),
      age: 0
    }));

    this.positions = new Float32Array(SPEED_TRAIL_MAX_VERTICES * 2 * 3);
    this.across = new Float32Array(SPEED_TRAIL_MAX_VERTICES * 2);
    this.lifeAlpha = new Float32Array(SPEED_TRAIL_MAX_VERTICES * 2);
    this.indices = new Uint16Array((SPEED_TRAIL_MAX_VERTICES - 1) * 6);

    this.positionAttribute = new BufferAttribute(this.positions, 3);
    this.lifeAlphaAttribute = new BufferAttribute(this.lifeAlpha, 1);

    this.sourcePosition = new Vector3();
    this.previousSourcePosition = new Vector3();
    this.cameraPosition = new Vector3();
    this.tangent = new Vector3();
    this.viewDirection = new Vector3();
    this.side = new Vector3();
    this.fallbackAxis = new Vector3(0, 1, 0);

    this.hasSourcePosition = false;
    this.emissionClock = 0;
    this.opacity = 0;
    this.hasSpawnedStartupGlow = false;
    this.activationGlowAge = SPEED_TRAIL_ACTIVATION_GLOW_DURATION;
    this.timeDilation = 1;
    this.geometryDirty = true;

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

    const glowTexture = createSpeedTrailGlowTexture();
    const glowMaterial = new SpriteMaterial({
      map: glowTexture,
      color: 15332863,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: true
    });

    this.activationGlow = new Sprite(glowMaterial);
    this.activationGlow.name = "SpeedTrail_PS-activation-glow";
    if (this.activationGlow.scale?.setScalar) {
      this.activationGlow.scale.setScalar(SPEED_TRAIL_ACTIVATION_GLOW_SCALE);
    }
    this.activationGlow.visible = false;
    this.activationGlow.renderOrder = 2;

    this.object.add(this.ribbon, this.activationGlow);
  }

  reset() {
    while (this.points.length > 0) {
      this.pointPool.push(this.points.pop());
    }
    this.emissionClock = 0;
    this.hasSourcePosition = false;
    this.opacity = 0;
    this.geometry.setDrawRange(0, 0);
    this.geometryDirty = true;
  }

  update(sourcePos, velocity, dt) {
    const clampedDt = Math.max(0, Math.min(dt, 0.1));
    const speed = velocity.length();
    const isSupersonic = speed >= SPEED_TRAIL_THRESHOLD_SPEED;

    this.timeDilation = THREE.MathUtils.clamp(speed / SPEED_TRAIL_THRESHOLD_SPEED, 1, SPEED_TRAIL_MAX_TIME_DILATION);
    const targetOpacity = isSupersonic ? 1 : 0;

    this.opacity += (targetOpacity - this.opacity) * Math.min(1, clampedDt * SPEED_TRAIL_OPACITY_LERP_RATE);
    if (Math.abs(this.opacity - targetOpacity) < 5e-4) {
      this.opacity = targetOpacity;
    }
    if (this.material?.uniforms?.uOpacity) {
      this.material.uniforms.uOpacity.value = this.opacity * SPEED_TRAIL_MAX_OPACITY;
    }

    if (!this.hasSourcePosition) {
      this.sourcePosition.copy(sourcePos);
      this.previousSourcePosition.copy(sourcePos);
      this.hasSourcePosition = true;
    }

    if (sourcePos.distanceTo(this.previousSourcePosition) > SPEED_TRAIL_TELEPORT_RESET_DISTANCE) {
      while (this.points.length > 0) {
        this.pointPool.push(this.points.pop());
      }
      this.emissionClock = 0;
      this.previousSourcePosition.copy(sourcePos);
    }

    const scaledDeltaTime = clampedDt * this.timeDilation;
    for (let i = 0; i < this.points.length; i++) {
      this.points[i].age += scaledDeltaTime;
    }
    while (this.points.length && this.points[this.points.length - 1].age >= SPEED_TRAIL_MAX_POINT_AGE) {
      this.pointPool.push(this.points.pop());
    }

    if (isSupersonic) {
      this.emissionClock += scaledDeltaTime;
      const interval = 1 / SPEED_TRAIL_EMISSION_RATE;
      while (this.emissionClock >= interval) {
        this.emissionClock -= interval;
        const subTime = this.emissionClock / this.timeDilation;
        const factor = clampedDt > 0 ? THREE.MathUtils.clamp(1 - subTime / clampedDt, 0, 1) : 1;
        const pt = this.points.length >= SPEED_TRAIL_MAX_POINTS ? this.points.pop() : this.pointPool.pop();
        pt.position.lerpVectors(this.previousSourcePosition, sourcePos, factor);
        pt.age = this.emissionClock;
        this.points.unshift(pt);
      }
    }

    this.sourcePosition.copy(sourcePos);
    this.previousSourcePosition.copy(sourcePos);

    if (!this.hasSpawnedStartupGlow) {
      this.hasSpawnedStartupGlow = true;
      this.activationGlowAge = 0;
      if (this.activationGlow.position?.copy) {
        this.activationGlow.position.copy(sourcePos);
      }
      this.activationGlow.visible = true;
    }

    if (this.activationGlowAge < SPEED_TRAIL_ACTIVATION_GLOW_DURATION) {
      this.activationGlowAge += scaledDeltaTime;
      const progress = THREE.MathUtils.clamp(this.activationGlowAge / SPEED_TRAIL_ACTIVATION_GLOW_DURATION, 0, 1);
      if (this.activationGlow.material) {
        this.activationGlow.material.opacity = (1 - progress) * (1 - progress);
      }
      this.activationGlow.visible = progress < 1;
    } else {
      this.activationGlow.visible = false;
    }

    this.ribbon.visible = this.opacity > 0.002 && this.points.length > 0;
    this.geometryDirty = true;
  }

  prepare(camera) {
    this.rebuildGeometry(camera);
  }

  rebuildGeometry(camera) {
    if (!this.geometryDirty || !this.ribbon.visible) return;
    this.geometryDirty = false;

    const count = this.points.length + 1;
    if (count < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    if (camera?.getWorldPosition) {
      camera.getWorldPosition(this.cameraPosition);
    }
    const halfWidth = SPEED_TRAIL_RIBBON_WIDTH * 0.5;

    for (let i = 0; i < count; i++) {
      const prevPt = i === 0 ? null : this.points[i - 1];
      const pos = (prevPt?.position) || this.sourcePosition;
      const prevIdx = Math.max(0, i - 1);
      const nextIdx = Math.min(count - 1, i + 1);
      const prevPos = prevIdx === 0 ? this.sourcePosition : this.points[prevIdx - 1].position;
      const nextPos = nextIdx === 0 ? this.sourcePosition : this.points[nextIdx - 1].position;

      this.tangent.subVectors(nextPos, prevPos).normalize();
      this.viewDirection.subVectors(this.cameraPosition, pos).normalize();
      this.side.crossVectors(this.tangent, this.viewDirection);
      if (this.side.lengthSq() < 1e-6) {
        this.side.crossVectors(this.tangent, this.fallbackAxis);
        if (this.side.lengthSq() < 1e-6) {
          this.side.set(1, 0, 0);
        }
      }
      this.side.normalize().multiplyScalar(halfWidth);

      const age = prevPt?.age || 0;
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
    this.geometry.setDrawRange(0, (count - 1) * 6);
  }

  dispose() {
    if (this.geometry?.dispose) this.geometry.dispose();
    if (this.material?.dispose) this.material.dispose();
    if (this.glowGeometry?.dispose) this.glowGeometry.dispose();
    if (this.glowMaterial?.dispose) this.glowMaterial.dispose();
    if (this.object?.parent) this.object.parent.remove(this.object);
  }
}
