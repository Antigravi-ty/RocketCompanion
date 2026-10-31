import * as THREE from 'three';
/**
 * DemolitionEffect.js
 * Vehicle demolition explosion effect composed of an instanced smoke plume and impact burst flash.
 * Features realistic turbulence noise, warmth glow, and smooth fade transitions.
 */

import { getTheme } from '../ui-core/config/themeConfig.js';
import { getMaterialsConfig } from '../ui-core/config/materialsConfig.js';

export const DEMOLITION_PARTICLES_COUNT = 12;
export const DEMOLITION_SMOKE_DURATION = 1.05;
export const DEMOLITION_FLASH_DURATION = 0.18;
export const DEMOLITION_TOTAL_DURATION = 1.2;
export const DEMOLITION_ATTRIBUTES = ["aOffset", "aSize", "aOpacity", "aWarmth", "aRotation"];
export const DEMOLITION_DYNAMIC_DRAW_USAGE = 35048; // DynamicDrawUsage

export const DEMOLITION_SMOKE_VERTEX_SHADER = `
  attribute vec3 aOffset;
  attribute float aSize;
  attribute float aOpacity;
  attribute float aWarmth;
  attribute float aRotation;
  varying vec2 vUv;
  varying float vOpacity;
  varying float vWarmth;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(aOffset, 1.0);
    float s = sin(aRotation), c = cos(aRotation);
    vec2 corner = position.xy * aSize;
    viewPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
    gl_Position = projectionMatrix * viewPosition;
    vUv = uv;
    vOpacity = aOpacity;
    vWarmth = aWarmth;
  }
`;

export const DEMOLITION_SMOKE_FRAGMENT_SHADER = `
  uniform float realistic;
  uniform float time;
  varying vec2 vUv;
  varying float vOpacity;
  varying float vWarmth;
  float cloud(vec2 p) {
    float d = length(p) - 0.60;
    d = min(d, length(p - vec2(-0.34, 0.10)) - 0.43);
    d = min(d, length(p - vec2(0.28, 0.30)) - 0.45);
    d = min(d, length(p - vec2(0.22, -0.30)) - 0.42);
    return d;
  }
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float turbulence(vec2 p) {
    float result = 0.0, weight = 0.5;
    for (int i = 0; i < 4; i++) {
      result += weight * noise(p);
      p = p * 2.03 + vec2(5.2, 1.3);
      weight *= 0.5;
    }
    return result;
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = cloud(p);
    float aa = max(fwidth(d), 0.012);
    float alpha = (1.0 - smoothstep(-aa, aa, d)) * vOpacity;
    float inset = 1.0 - smoothstep(-0.08 - aa, -0.08 + aa, d);
    float highlight = 1.0 - smoothstep(-aa, aa, cloud(p * 1.42 + vec2(0.12, -0.23)));
    vec3 color = mix(vec3(0.036, 0.047, 0.065), vec3(0.13, 0.16, 0.185), inset);
    color = mix(color, vec3(0.31, 0.345, 0.36), highlight * inset);
    color = mix(color, vec3(1.1, 0.38, 0.05), vWarmth * inset * 0.65);
    if (realistic > 0.5) {
      float billow = turbulence(p * 3.0 + vec2(0.0, -time * 0.65));
      float detail = turbulence(p * 7.0 + billow + time * 0.12);
      float density = 1.0 - smoothstep(-0.20, 0.30, d + (billow - 0.46) * 0.45);
      float lighting = clamp(0.32 + billow * 0.75 - p.y * 0.12, 0.0, 1.0);
      color = mix(vec3(0.024, 0.028, 0.034), vec3(0.27, 0.28, 0.29), lighting);
      color = mix(color, vec3(1.0, 0.27, 0.025), vWarmth * detail * 0.7);
      alpha = density * (0.5 + 0.5 * detail) * vOpacity;
    }
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const DEMOLITION_FLASH_VERTEX_SHADER = `
  uniform float size;
  varying vec2 vUv;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(0.0, size * 0.45, 0.0, 1.0);
    viewPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * viewPosition;
    vUv = uv;
  }
`;

export const DEMOLITION_FLASH_FRAGMENT_SHADER = `
  uniform float opacity;
  uniform float realistic;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float angle = atan(p.y, p.x);
    float radius = length(p) / (0.72 + 0.18 * cos(angle * 7.0));
    float aa = max(fwidth(radius), 0.015);
    float alpha = (1.0 - smoothstep(1.0 - aa, 1.0 + aa, radius)) * opacity;
    float inner = 1.0 - smoothstep(0.72 - aa, 0.72 + aa, radius);
    float core = 1.0 - smoothstep(0.4 - aa, 0.4 + aa, radius);
    vec3 color = mix(vec3(1.0, 0.21, 0.015), vec3(1.3, 0.62, 0.09), inner);
    color = mix(color, vec3(1.7, 1.3, 0.65), core);
    if (realistic > 0.5) {
      float r2 = dot(p, p);
      float glow = exp(-r2 * 4.5);
      float hot = exp(-r2 * 18.0);
      alpha = glow * (1.0 - smoothstep(0.65, 1.0, length(p))) * opacity;
      color = mix(vec3(2.2, 0.38, 0.018), vec3(4.0, 2.2, 0.8), hot);
    }
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createDemolitionQuadGeometry() {
  const { BufferGeometry, BufferAttribute } = THREE;
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geo.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

export class DemolitionEffect {
  constructor() {
    const {
      Group,
      InstancedBufferAttribute,
      PlaneGeometry,
      ShaderMaterial,
      Mesh,
      DynamicDrawUsage
    } = THREE;

    this.object = new Group();
    this.object.name = "demolition-effect";
    this.object.visible = false;

    this.offsets = new Float32Array(DEMOLITION_PARTICLES_COUNT * 3);
    this.sizes = new Float32Array(DEMOLITION_PARTICLES_COUNT);
    this.opacity = new Float32Array(DEMOLITION_PARTICLES_COUNT);
    this.warmth = new Float32Array(DEMOLITION_PARTICLES_COUNT);
    this.rotations = new Float32Array(DEMOLITION_PARTICLES_COUNT);

    this.wasDemolished = null;
    this.elapsed = Infinity;

    const smokeGeo = createDemolitionQuadGeometry();
    const attrDefs = [
      ["aOffset", this.offsets, 3],
      ["aSize", this.sizes, 1],
      ["aOpacity", this.opacity, 1],
      ["aWarmth", this.warmth, 1],
      ["aRotation", this.rotations, 1]
    ];
    for (const [name, arr, itemSize] of attrDefs) {
      smokeGeo.setAttribute(name, new InstancedBufferAttribute(arr, itemSize).setUsage(DynamicDrawUsage));
    }
    smokeGeo.instanceCount = DEMOLITION_PARTICLES_COUNT;

    const smokeMaterial = new ShaderMaterial({
      name: "Demolition / smoke",
      uniforms: {
        realistic: { value: 0 },
        time: { value: 0 }
      },
      vertexShader: DEMOLITION_SMOKE_VERTEX_SHADER,
      fragmentShader: DEMOLITION_SMOKE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      toneMapped: true
    });

    this.smoke = new Mesh(smokeGeo, smokeMaterial);
    this.smoke.name = "demolition-plume";
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 5;
    this.object.add(this.smoke);

    const flashMaterial = new ShaderMaterial({
      name: "Demolition / impact",
      uniforms: {
        size: { value: 0 },
        opacity: { value: 0 },
        realistic: { value: 0 }
      },
      vertexShader: DEMOLITION_FLASH_VERTEX_SHADER,
      fragmentShader: DEMOLITION_FLASH_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      toneMapped: true
    });

    this.flash = new Mesh(new PlaneGeometry(1, 1), flashMaterial);
    this.flash.name = "demolition-flash";
    this.flash.frustumCulled = false;
    this.flash.renderOrder = 6;
    this.object.add(this.flash);
  }

  update(dt, isDemolished, position, isMatchActive = true) {
    if (!isMatchActive) {
      this.wasDemolished = null;
      this.stop();
      return;
    }

    const justDemolished = this.wasDemolished === false && isDemolished;
    this.wasDemolished = isDemolished;

    if (!isDemolished) {
      this.stop();
      return;
    }

    if (justDemolished) {
      if (this.object.position?.copy && position) {
        this.object.position.copy(position);
      }
      this.elapsed = 0;
      this.object.visible = true;
      for (let i = 0; i < DEMOLITION_PARTICLES_COUNT; i++) {
        this.rotations[i] = Math.random() * Math.PI * 2;
      }
      this.updateVisual();
      return;
    }

    if (this.object.visible) {
      this.elapsed += dt;
      if (this.elapsed >= DEMOLITION_TOTAL_DURATION) {
        this.stop();
      } else {
        this.updateVisual();
      }
    }
  }

  updateVisual() {
    let isSmoke = 0;
    try {
      const mats = getMaterialsConfig();
      if (mats?.demolishedEffect) {
        isSmoke = mats.demolishedEffect === 'smoke' ? 1 : 0;
      }
    } catch (err) {
      console.warn('[DemolitionEffect] Failed to resolve demolishedEffect material theme:', err);
    }
    if (this.smoke?.material?.uniforms) {
      this.smoke.material.uniforms.realistic.value = isSmoke;
      this.smoke.material.uniforms.time.value = this.elapsed;
    }
    if (this.flash?.material?.uniforms) {
      this.flash.material.uniforms.realistic.value = isSmoke;
    }

    const { MathUtils } = THREE;
    const flashProgress = MathUtils.clamp(this.elapsed / DEMOLITION_FLASH_DURATION, 0, 1);
    this.flash.visible = flashProgress < 1;
    if (this.flash?.material?.uniforms) {
      this.flash.material.uniforms.size.value = 110 + 90 * (1 - Math.pow(1 - flashProgress, 3));
      this.flash.material.uniforms.opacity.value = 0.95 * (1 - flashProgress * flashProgress);
    }

    for (let i = 0; i < DEMOLITION_PARTICLES_COUNT; i++) {
      const isLateParticle = i >= 6;
      const delay = isLateParticle ? 0.05 + (i - 6) * 0.018 : 0;
      const particleAge = this.elapsed - delay;
      const smokeProgress = MathUtils.clamp(particleAge / DEMOLITION_SMOKE_DURATION, 0, 1);
      const easeExpansion = 1 - Math.pow(1 - smokeProgress, 3);
      const angle = i * 2.39996; // Golden angle
      const spread = (isLateParticle ? 8 : 16) + easeExpansion * (isLateParticle ? 34 : 62);

      this.offsets[i * 3] = Math.cos(angle) * spread;
      this.offsets[i * 3 + 1] = 8 + (isLateParticle ? 24 : 0) + Math.max(0, particleAge) * (isLateParticle ? 130 : 62);
      this.offsets[i * 3 + 2] = Math.sin(angle) * spread;

      this.sizes[i] = (isLateParticle ? 80 : 92) * (0.45 + 0.85 * easeExpansion) * (1 - 0.25 * smokeProgress);
      this.opacity[i] = particleAge < 0 ? 0 : 0.88 * (1 - MathUtils.smoothstep(smokeProgress, 0.32, 1));
      this.warmth[i] = 1 - MathUtils.smoothstep(particleAge, 0.02, 0.24);
    }

    if (this.smoke?.geometry?.attributes) {
      for (const attr of DEMOLITION_ATTRIBUTES) {
        if (this.smoke.geometry.attributes[attr]) {
          this.smoke.geometry.attributes[attr].needsUpdate = true;
        }
      }
    }
  }

  stop() {
    this.elapsed = Infinity;
    this.object.visible = false;
    if (this.flash) this.flash.visible = false;
  }

  dispose() {
    this.stop();
    if (this.object) {
      this.object.parent?.remove?.(this.object);
      this.object.traverse?.((node) => {
        node.geometry?.dispose?.();
        node.material?.dispose?.();
      });
    }
  }
}
