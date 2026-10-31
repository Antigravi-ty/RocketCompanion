import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import * as THREE from 'three';
/**
 * SupersonicSpeedLinesPass.js
 * Full-screen instanced postprocessing pass simulating high-speed supersonic travel lines.
 * Projective lines deform along the camera velocity vector with center clear-mask and smooth fade.
 */

export const SPEED_LINES_COUNT = 80;

export const SPEED_LINES_VERTEX_SHADER = `
  attribute vec4 seed;
  uniform float time, strength, aspect;
  uniform vec3 travel;
  uniform mat4 cameraProjection;
  varying vec2 vStroke;
  varying vec2 vScreen;
  varying float vOpacity;
  void main() {
    vec3 reference = abs(travel.y) > 0.95 ? vec3(1., 0., 0.) : vec3(0., 1., 0.);
    vec3 side = normalize(cross(travel, reference));
    vec3 up = cross(side, travel);
    float angle = seed.x * 6.2831853;
    float radius = mix(240., 1550., sqrt(seed.y));
    float phase = fract(seed.z + time * (0.58 + seed.w * 0.22));
    vec3 head = (side * cos(angle) + up * sin(angle)) * radius
      + travel * mix(2400., -2400., phase);
    vec3 tail = head + travel * mix(240., 440., seed.w);
    // Clip in camera space before division, including a camera looking backward.
    float visible = step(30., -min(head.z, tail.z));
    if (visible < 0.5) {
      gl_Position = vec4(2., 2., 2., 1.);
      vScreen = vec2(2.);
      vStroke = position.xy;
      vOpacity = 0.;
      return;
    }
    if (head.z > -30.) head = mix(head, tail, (-30. - head.z) / (tail.z - head.z));
    if (tail.z > -30.) tail = mix(tail, head, (-30. - tail.z) / (head.z - tail.z));
    vec4 a = cameraProjection * vec4(head, 1.);
    vec4 b = cameraProjection * vec4(tail, 1.);
    vec2 start = a.xy / max(a.w, 0.01);
    vec2 end = b.xy / max(b.w, 0.01);
    vec2 delta = (end - start) * vec2(aspect, 1.);
    vec2 normal = vec2(-delta.y, delta.x) / max(length(delta), 0.0001);
    float width = mix(0.0018, 0.0028, seed.w);
    vec2 point = mix(start, end, position.x)
      + normal / vec2(aspect, 1.) * position.y * width;
    gl_Position = vec4(point, 0., 1.);
    vScreen = point * 0.5 + 0.5;
    vStroke = position.xy;
    vOpacity = visible * strength * mix(0.30, 0.48, seed.w)
      * smoothstep(0., 0.08, phase) * (1. - smoothstep(0.88, 1., phase));
  }
`;

export const SPEED_LINES_FRAGMENT_SHADER = `
  uniform float aspect;
  varying vec2 vStroke;
  varying vec2 vScreen;
  varying float vOpacity;
  void main() {
    float width = 1. - smoothstep(0.15, 1., abs(vStroke.y));
    float cap = smoothstep(0., 0.08, vStroke.x) * (1. - smoothstep(0.35, 1., vStroke.x));
    float centerClear = smoothstep(0.12, 0.34, length((vScreen - 0.5) * vec2(aspect, 1.)));
    gl_FragColor = vec4(vec3(0.88, 0.96, 1.), width * cap * centerClear * vOpacity);
  }
`;

export const DEFAULT_COPY_SHADER = {
  name: "CopyShader",
  uniforms: {
    tDiffuse: { value: null },
    opacity: { value: 1.0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float opacity;
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      gl_FragColor = opacity * texel;
    }
  `
};

export class SpeedLinesEffectPass {
  constructor(material) {
    const {
      ShaderMaterial,
      Scene,
      OrthographicCamera,
      BufferGeometry,
      BufferAttribute,
      InstancedBufferAttribute,
      Mesh
    } = THREE;

    // Inherit from Pass instance & fulfill Pass contract
    if (Pass) {
      Object.assign(this, new Pass());
    }

    this.isPass = true;
    this.enabled = false;
    this.needsSwap = true;
    this.clear = false;
    this.renderToScreen = false;

    const copyUniforms = {
      tDiffuse: { value: null },
      opacity: { value: 1.0 }
    };
    this.copy = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: copyUniforms,
        vertexShader: CopyShader.vertexShader,
        fragmentShader: CopyShader.fragmentShader,
        depthTest: false,
        depthWrite: false
      })
    );

    this.scene = new Scene();
    this.camera = new OrthographicCamera();

    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 0, 1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3)
    );

    const seedArray = new Float32Array(SPEED_LINES_COUNT * 4);
    for (let seedIndex = 0; seedIndex < seedArray.length; seedIndex++) {
      const pseudoRandom = Math.sin((seedIndex + 1) * 127.1) * 43758.5453;
      seedArray[seedIndex] = pseudoRandom - Math.floor(pseudoRandom);
    }
    geometry.setAttribute("seed", new InstancedBufferAttribute(seedArray, 4));
    geometry.instanceCount = SPEED_LINES_COUNT;

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /**
   * Called by EffectComposer on pass addition and viewport resize.
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    // Pass contract method required by EffectComposer.addPass / EffectComposer.setSize
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!renderer) return;
    if (this.copy?.material?.uniforms?.tDiffuse) {
      this.copy.material.uniforms.tDiffuse.value = readBuffer ? readBuffer.texture : null;
    }
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.copy?.render?.(renderer);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    if (this.scene && this.camera) {
      renderer.render(this.scene, this.camera);
    }
    renderer.autoClear = autoClear;
  }

  dispose() {
    if (this.copy && typeof this.copy.dispose === 'function') {
      this.copy.dispose();
    }
  }
}

/**
 * SupersonicSpeedLinesPass (Original mangled class `Zw`)
 */
export class SupersonicSpeedLinesPass {
  constructor() {
    const { ShaderMaterial, Vector3, Quaternion, Matrix4, DoubleSide } = THREE;

    this.strength = 0;
    this.time = 0;
    this.viewVelocity = new Vector3();
    this.inverseCamera = new Quaternion();

    this.material = new ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        strength: { value: 0 },
        aspect: { value: 1 },
        travel: { value: new Vector3(0, 0, -1) },
        cameraProjection: { value: new Matrix4() }
      },
      vertexShader: SPEED_LINES_VERTEX_SHADER,
      fragmentShader: SPEED_LINES_FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: DoubleSide
    });

    this.pass = new SpeedLinesEffectPass(this.material);
  }

  update(dt, isSupersonic, velocity, camera) {
    if (!camera) return;
    const clampedDt = Math.max(0, Math.min(dt, 0.1));

    const dampFunc = THREE.MathUtils.damp || ((curr, target, lambda, step) => target + (curr - target) * Math.exp(-lambda * step));
    this.strength = dampFunc(this.strength, isSupersonic ? 1 : 0, isSupersonic ? 12 : 18, clampedDt);
    this.time += clampedDt;
    this.pass.enabled = this.strength > 0.002;

    const uniforms = this.material.uniforms;
    uniforms.time.value = this.time;
    uniforms.strength.value = this.strength;
    uniforms.aspect.value = camera.aspect ?? 1;

    if (camera.projectionMatrix && uniforms.cameraProjection.value?.copy) {
      uniforms.cameraProjection.value.copy(camera.projectionMatrix);
    }

    if (camera.quaternion && this.inverseCamera?.copy) {
      this.inverseCamera.copy(camera.quaternion);
      if (typeof this.inverseCamera.invert === 'function') {
        this.inverseCamera.invert();
      }
    }

    if (velocity && this.viewVelocity?.copy) {
      this.viewVelocity.copy(velocity);
      if (typeof this.viewVelocity.applyQuaternion === 'function') {
        this.viewVelocity.applyQuaternion(this.inverseCamera);
      }
      if (typeof this.viewVelocity.lengthSq === 'function' && this.viewVelocity.lengthSq() > 1) {
        uniforms.travel.value.copy(this.viewVelocity).normalize();
      }
    }
  }

  setSize(width, height) {
    if (this.pass && typeof this.pass.setSize === 'function') {
      this.pass.setSize(width, height);
    }
  }

  dispose() {
    if (this.pass && typeof this.pass.dispose === 'function') {
      this.pass.dispose();
    }
    if (this.material && typeof this.material.dispose === 'function') {
      this.material.dispose();
    }
  }
}
