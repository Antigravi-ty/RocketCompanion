import * as THREE from 'three';
/**
 * FlipResetVisual.js
 * Flip reset visual indicator attached to vehicle chassis.
 * Displays an arcade starburst ring or realistic shockwave pulse along with spark particles.
 */

import { getTheme } from '../ui-core/config/themeConfig.js';

export const RESET_INDICATOR_HEIGHT = -12;
export const RESET_PULSE_DURATION = 0.24;
export const RESET_SPARKS_DELAY = 0.05;
export const RESET_SPARKS_DURATION = 0.18;
export const RESET_SPARKS_COUNT = 8;
export const RESET_ARCADE_COLOR_HEX = 16773836; // 0xFFF12C

export function createStarShapeGeometry() {
  const shape = new THREE.Shape();
  for (let e = 0; e < 8; e++) {
    const angle = Math.PI / 2 + (e * Math.PI) / 4;
    const radius = e % 2 === 0 ? 1 : 0.25;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (e === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

export function createSparksMaterial() {
  return new THREE.ShaderMaterial({
    name: "Arcade / reset sparkles",
    uniforms: {
      opacity: { value: 0 },
      size: { value: 20 },
      viewportHeight: { value: 1 }
    },
    vertexShader: `
      #include <common>
      uniform float size;
      uniform float viewportHeight;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        gl_PointSize = size * projectionMatrix[1][1] * viewportHeight * 0.5;
        if (isPerspectiveMatrix(projectionMatrix)) gl_PointSize /= max(1.0, -viewPosition.z);
      }
    `,
    fragmentShader: `
      uniform float opacity;
      void main() {
        vec2 p = abs(gl_PointCoord * 2.0 - 1.0);
        float d = sqrt(p.x) + sqrt(p.y);
        float aa = max(fwidth(d), 0.02);
        float alpha = (1.0 - smoothstep(1.0 - aa, 1.0 + aa, d)) * opacity;
        float inside = 1.0 - smoothstep(0.74 - aa, 0.74 + aa, d);
        vec3 color = mix(vec3(0.02, 0.15, 0.38), vec3(1.8, 1.6, 1.0), inside);
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    toneMapped: true
  });
}

export function enableLayerOne(object) {
  if (object && typeof object.traverse === 'function') {
    object.traverse(child => child.layers?.enable?.(1));
  }
}

export class FlipResetVisual {
  constructor(parentObject) {
    const {
      Group,
      MeshBasicMaterial,
      Mesh,
      RingGeometry,
      BufferGeometry,
      BufferAttribute,
      Points,
      Color,
      Vector4,
      DoubleSide
    } = THREE;

    this.root = new Group();
    this.root.name = "flip-reset-indicator";
    this.root.position.y = RESET_INDICATOR_HEIGHT;
    this.root.visible = false;
    if (parentObject && typeof parentObject.add === 'function') {
      parentObject.add(this.root);
    }

    this.viewportRect = new Vector4();
    this.sparkPositions = new Float32Array(RESET_SPARKS_COUNT * 3);
    this.sparkOrigins = new Float32Array(RESET_SPARKS_COUNT * 3);
    this.sparkVelocities = new Float32Array(RESET_SPARKS_COUNT * 3);
    this.elapsed = Infinity;

    const baseMaterial = new MeshBasicMaterial({
      name: "Arcade / reset ring",
      color: new Color(RESET_ARCADE_COLOR_HEX),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: true
    });

    this.ring = new Mesh(new RingGeometry(0.83, 1, 48), baseMaterial);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 9;
    this.root.add(this.ring);

    this.core = new Mesh(createStarShapeGeometry(), baseMaterial.clone());
    this.core.material?.color?.setRGB?.(1.6, 1.4, 0.9);
    this.core.rotation.x = -Math.PI / 2;
    this.core.position.y = 0.5;
    this.core.renderOrder = 10;
    this.root.add(this.core);

    this.outlineMaterial = baseMaterial.clone();
    this.outlineMaterial.color?.set?.(1460613);

    const outlineMesh = new Mesh(new RingGeometry(0.78, 1.05, 48), this.outlineMaterial);
    outlineMesh.renderOrder = 8;
    this.ring.add(outlineMesh);

    this.sparksGeometry = new BufferGeometry();
    this.sparksGeometry.setAttribute("position", new BufferAttribute(this.sparkPositions, 3));
    this.sparksMaterial = createSparksMaterial();
    this.sparks = new Points(this.sparksGeometry, this.sparksMaterial);
    this.sparks.onBeforeRender = (renderer) => {
      if (renderer?.getCurrentViewport) {
        renderer.getCurrentViewport(this.viewportRect);
        if (this.sparksMaterial?.uniforms?.viewportHeight) {
          this.sparksMaterial.uniforms.viewportHeight.value = this.viewportRect.w;
        }
      }
    };
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 10;
    this.root.add(this.sparks);

    enableLayerOne(this.root);
  }

  preloadAudio() {
    return Promise.resolve();
  }

  get bloomActive() {
    return this.root.visible;
  }

  update(dt, isAlive = true) {
    if (Number.isFinite(this.elapsed)) {
      this.elapsed += dt;
      if (this.elapsed >= RESET_PULSE_DURATION || !isAlive) {
        this.stopVisual();
        return;
      }
      this.updateVisual();
    }
  }

  trigger() {
    this.play();
  }

  play() {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this._lastTriggerMs !== undefined && nowMs - this._lastTriggerMs < 500) {
      return;
    }
    this._lastTriggerMs = nowMs;
    this.elapsed = 0;
    this.root.visible = true;
    this.seedSparks();
    this.updateVisual();
  }

  seedSparks() {
    for (let e = 0; e < RESET_SPARKS_COUNT; e += 1) {
      const idx = e * 3;
      const angle = ((e + Math.random() * 0.25) / RESET_SPARKS_COUNT) * Math.PI * 2;
      const radius = 42 + Math.random() * 8;
      const speed = 100 + Math.random() * 60;
      const height = -4 + Math.random() * 8;

      this.sparkOrigins[idx] = Math.cos(angle) * radius;
      this.sparkOrigins[idx + 1] = height;
      this.sparkOrigins[idx + 2] = Math.sin(angle) * radius;

      this.sparkVelocities[idx] = Math.cos(angle) * speed;
      this.sparkVelocities[idx + 1] = 25 + Math.random() * 45;
      this.sparkVelocities[idx + 2] = Math.sin(angle) * speed;

      this.sparkPositions[idx] = this.sparkOrigins[idx];
      this.sparkPositions[idx + 1] = this.sparkOrigins[idx + 1];
      this.sparkPositions[idx + 2] = this.sparkOrigins[idx + 2];
    }
    if (this.sparksGeometry?.attributes?.position) {
      this.sparksGeometry.attributes.position.needsUpdate = true;
    }
  }

  updateVisual() {
    this.ring.visible = true;
    this.core.visible = true;

    const progress = THREE.MathUtils.clamp(this.elapsed / RESET_PULSE_DURATION, 0, 1);
    const alphaFade = Math.pow(1 - progress, 1.65);
    const scaleFactor = 1 - Math.pow(1 - progress, 3);

    this.ring.scale?.setScalar?.(48 + scaleFactor * 58);
    if (this.ring?.material) this.ring.material.opacity = 0.62 * alphaFade;
    if (this.outlineMaterial) this.outlineMaterial.opacity = 0.8 * alphaFade;

    this.core.scale?.setScalar?.(28 + scaleFactor * 26);
    this.core.rotation.z = scaleFactor * 0.3;
    if (this.core?.material) this.core.material.opacity = 0.72 * Math.pow(1 - progress, 2.5);

    const sparkElapsed = this.elapsed - RESET_SPARKS_DELAY;
    const sparkAlpha = THREE.MathUtils.clamp(sparkElapsed / RESET_SPARKS_DURATION, 0, 1);
    const sparksActive = sparkElapsed >= 0 && sparkElapsed < RESET_SPARKS_DURATION;
    this.sparks.visible = sparksActive;

    if (sparksActive) {
      const gravity = -280 * sparkElapsed * sparkElapsed;
      for (let i = 0; i < RESET_SPARKS_COUNT; i += 1) {
        const idx = i * 3;
        this.sparkPositions[idx] = this.sparkOrigins[idx] + this.sparkVelocities[idx] * sparkElapsed;
        this.sparkPositions[idx + 1] = this.sparkOrigins[idx + 1] + this.sparkVelocities[idx + 1] * sparkElapsed + gravity;
        this.sparkPositions[idx + 2] = this.sparkOrigins[idx + 2] + this.sparkVelocities[idx + 2] * sparkElapsed;
      }
      if (this.sparksMaterial?.uniforms?.opacity) {
        this.sparksMaterial.uniforms.opacity.value = 1 - sparkAlpha * sparkAlpha;
      }
      if (this.sparksMaterial?.uniforms?.size) {
        this.sparksMaterial.uniforms.size.value = 20 * (1 - sparkAlpha * 0.65);
      }
      if (this.sparksGeometry?.attributes?.position) {
        this.sparksGeometry.attributes.position.needsUpdate = true;
      }
    }
  }

  stopVisual() {
    this.elapsed = Infinity;
    this.root.visible = false;
    this.sparks.visible = false;
    if (this.ring?.material) this.ring.material.opacity = 0;
    if (this.core?.material) this.core.material.opacity = 0;
    if (this.outlineMaterial) this.outlineMaterial.opacity = 0;
    if (this.sparksMaterial?.uniforms?.opacity) this.sparksMaterial.uniforms.opacity.value = 0;
  }
}
