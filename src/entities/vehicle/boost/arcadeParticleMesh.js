import * as THREE from 'three';

const ARCADE_PARTICLE_ATTRS = ["aOffset", "aSize", "aOpacity", "aLife", "aRotation"];

/**
 * Arcade Instanced Particle Mesh
 */
export class ArcadeBoostParticleMesh {
  constructor(count, isDriving, renderOrder) {
    const {
      Mesh,
      InstancedBufferGeometry,
      BufferAttribute,
      InstancedBufferAttribute,
      ShaderMaterial,
      DynamicDrawUsage
    } = THREE;

    this.mesh = null;
    this.offsets = new Float32Array(count * 3);
    this.sizes = new Float32Array(count * 2);
    this.opacity = new Float32Array(count);
    this.life = new Float32Array(count);
    this.rotations = new Float32Array(count);

    const geom = new InstancedBufferGeometry();
    geom.setAttribute("position", new BufferAttribute(new Float32Array([
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
       0.5,  0.5, 0,
      -0.5,  0.5, 0
    ]), 3));
    geom.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geom.setIndex([0, 1, 2, 0, 2, 3]);

    geom.setAttribute("aOffset", new InstancedBufferAttribute(this.offsets, 3));
    geom.setAttribute("aSize", new InstancedBufferAttribute(this.sizes, 2));
    geom.setAttribute("aOpacity", new InstancedBufferAttribute(this.opacity, 1));
    geom.setAttribute("aLife", new InstancedBufferAttribute(this.life, 1));
    geom.setAttribute("aRotation", new InstancedBufferAttribute(this.rotations, 1));

    for (const attr of ARCADE_PARTICLE_ATTRS) {
      geom.attributes[attr].setUsage(DynamicDrawUsage);
    }
    geom.instanceCount = count;

    const mat = new ShaderMaterial({
      uniforms: {
        driving: { value: isDriving ? 1 : 0 }
      },
      vertexShader: `
        attribute vec3 aOffset;
        attribute vec2 aSize;
        attribute float aOpacity;
        attribute float aLife;
        attribute float aRotation;
        varying vec2 vUv;
        varying float vOpacity;
        varying float vLife;
        varying float vSpark;
        void main() {
          vec4 viewPosition = modelViewMatrix * vec4(aOffset, 1.0);
          float rotationSin = sin(aRotation);
          float rotationCos = cos(aRotation);
          vSpark = step(0.55, fract(aRotation * 2.7));
          vec2 corner = position.xy * aSize * mix(1.0, 0.55, vSpark);
          viewPosition.xy += vec2(
            rotationCos * corner.x - rotationSin * corner.y,
            rotationSin * corner.x + rotationCos * corner.y
          );
          gl_Position = projectionMatrix * viewPosition;
          vUv = uv;
          vOpacity = aOpacity;
          vLife = aLife;
        }
      `,
      fragmentShader: `
        uniform float driving;
        varying vec2 vUv;
        varying float vOpacity;
        varying float vLife;
        varying float vSpark;
        float cloud(vec2 p) {
          float d = length(p) - 0.72;
          d = min(d, length(p - vec2(-0.36, 0.08)) - 0.42);
          d = min(d, length(p - vec2(0.30, 0.27)) - 0.43);
          d = min(d, length(p - vec2(0.18, -0.33)) - 0.39);
          return d;
        }
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float d = mix(cloud(p), abs(p.x) + abs(p.y) - 0.72, vSpark);
          float aa = max(fwidth(d), 0.008);
          float alpha = (1.0 - smoothstep(-aa, aa, d)) * vOpacity;
          if (alpha < 0.003) discard;
          float inset = 1.0 - smoothstep(-0.12 - aa, -0.12 + aa, d);
          float highlight = 1.0 - smoothstep(-aa, aa, cloud(p * 1.65 + vec2(0.10, -0.24)));
          vec3 edge = mix(vec3(0.88, 0.18, 0.015), vec3(0.25, 0.33, 0.41), driving);
          vec3 fill = mix(vec3(1.0, 0.46, 0.065), vec3(0.53, 0.63, 0.71), driving);
          vec3 cream = mix(vec3(1.25, 0.72, 0.23), vec3(0.76, 0.83, 0.86), driving);
          vec3 color = mix(edge, fill, inset);
          color = mix(color, cream, highlight * inset * (1.0 - smoothstep(0.2, 0.85, vLife)));
          gl_FragColor = vec4(color, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      toneMapped: true
    });
    mat.name = isDriving ? "Arcade / exhaust puffs" : "Arcade / boost puffs";

    this.mesh = new Mesh(geom, mat);
    this.mesh.name = isDriving ? "drive-puffs" : "boost-trail";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  markDirty() {
    if (!this.mesh?.geometry?.attributes) return;
    for (const attr of ARCADE_PARTICLE_ATTRS) {
      const a = this.mesh.geometry.attributes[attr];
      if (a) a.needsUpdate = true;
    }
  }
}
