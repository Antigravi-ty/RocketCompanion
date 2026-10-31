import * as THREE from 'three';

const REALISTIC_PARTICLE_ATTRS = [
  "aOffset",
  "aSize",
  "aOpacity",
  "aColorScale",
  "aDynamic",
  "aRotation"
];

/**
 * Realistic Boost Instanced Particle Mesh
 */
export class RealisticBoostParticleMesh {
  constructor(count, textures, renderOrder) {
    const {
      Mesh,
      InstancedBufferGeometry,
      BufferAttribute,
      InstancedBufferAttribute,
      ShaderMaterial,
      DynamicDrawUsage,
      NormalBlending
    } = THREE;

    this.mesh = null;
    this.offsets = new Float32Array(count * 3);
    this.sizes = new Float32Array(count * 2);
    this.opacity = new Float32Array(count);
    this.colorScale = new Float32Array(count).fill(1);
    this.dynamic = new Float32Array(count * 4);
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
    geom.setAttribute("aColorScale", new InstancedBufferAttribute(this.colorScale, 1));
    geom.setAttribute("aDynamic", new InstancedBufferAttribute(this.dynamic, 4));
    geom.setAttribute("aRotation", new InstancedBufferAttribute(this.rotations, 1));

    for (let i = 0; i < REALISTIC_PARTICLE_ATTRS.length; i++) {
      geom.attributes[REALISTIC_PARTICLE_ATTRS[i]].setUsage(DynamicDrawUsage);
    }
    geom.instanceCount = count;

    const mat = new ShaderMaterial({
      uniforms: {
        cloudMap: { value: textures.cloud },
        dustMap: { value: textures.dust },
        grainMap: { value: textures.grain },
        smokeMap: { value: textures.smoke },
        time: { value: 0 },
        plumeLuminance: { value: 1.0 }
      },
      vertexShader: `
        attribute vec3 aOffset;
        attribute vec2 aSize;
        attribute float aOpacity;
        attribute float aColorScale;
        attribute vec4 aDynamic;
        attribute float aRotation;
        varying vec2 vUv;
        varying vec4 vParticleColor;
        varying vec4 vDynamic;
        void main() {
          vec4 viewPosition = modelViewMatrix * vec4(aOffset, 1.0);
          float rotationSin = sin(aRotation);
          float rotationCos = cos(aRotation);
          vec2 corner = position.xy * aSize;
          viewPosition.xy += vec2(
            rotationCos * corner.x - rotationSin * corner.y,
            rotationSin * corner.x + rotationCos * corner.y
          );
          gl_Position = projectionMatrix * viewPosition;
          vUv = uv;
          vParticleColor = vec4(
            vec3(2.5, 1.0, 0.125) * aColorScale,
            aOpacity
          );
          vDynamic = aDynamic;
        }
      `,
      fragmentShader: `
        uniform sampler2D cloudMap;
        uniform sampler2D dustMap;
        uniform sampler2D grainMap;
        uniform sampler2D smokeMap;
        uniform float time;
        uniform float plumeLuminance;
        varying vec2 vUv;
        varying vec4 vParticleColor;
        varying vec4 vDynamic;
        void main() {
          float angle = -0.125 * time;
          float cs = cos(angle);
          float sn = sin(angle);
          vec2 centered = vUv * 0.5 - 0.5;
          vec2 smokeUv = vec2(
            dot(vec2(cs, -sn), centered),
            dot(vec2(sn,  cs), centered)
          ) + 0.5;

          vec2 smoke = texture2D(smokeMap, smokeUv).rg;
          vec2 distortedUv = vUv + smoke * 0.08;

          vec3 grain = max(abs(texture2D(grainMap, distortedUv).rgb), vec3(0.000001));
          vec3 grain2 = grain * grain;
          grain *= grain2;
          grain2 *= grain2;
          grain *= grain2;
          grain2 *= grain2;
          grain *= grain2 * 50.0;

          float cloud = texture2D(cloudMap, distortedUv).r;
          vec2 dustPan = fract(time * vec2(0.1, 0.5));
          vec3 dust = texture2D(dustMap, distortedUv + dustPan).rgb;
          float dustOffset = dust.r - 0.2;
          vec3 shaped = (dust + vec3(0.5 * dustOffset)) * dust + vec3(vDynamic.w);
          shaped = clamp(shaped * cloud, 0.0, 1.0) * 3.0;

          vec3 signal = cloud * grain + shaped;
          float alpha = clamp(2.0 * (vParticleColor.a * shaped.r - 0.01), 0.0, 1.0);
          vec3 color = vDynamic.y * signal * vParticleColor.rgb * plumeLuminance;
          gl_FragColor = vec4(color, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      blending: NormalBlending,
      depthWrite: false,
      toneMapped: true
    });
    mat.name = "Realistic / textured exhaust particles";

    this.mesh = new Mesh(geom, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  setPlumeLuminance(val) {
    if (this.mesh?.material?.uniforms?.plumeLuminance) {
      this.mesh.material.uniforms.plumeLuminance.value = val;
    }
  }

  setTime(t) {
    if (this.mesh?.material?.uniforms?.time) {
      this.mesh.material.uniforms.time.value = t;
    }
  }

  markDirty() {
    if (!this.mesh?.geometry?.attributes) return;
    for (let i = 0; i < REALISTIC_PARTICLE_ATTRS.length; i++) {
      const attr = this.mesh.geometry.attributes[REALISTIC_PARTICLE_ATTRS[i]];
      if (attr) attr.needsUpdate = true;
    }
  }
}
