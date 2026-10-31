import { registerThemeSubtree } from '../effects/ThemeMaterialPipeline.js';
import * as THREE from 'three';
import { BoostPadStateView } from '../physics/RocketSimStateViews.js';
import {
  computeAllPadRotations,
  exportRotationsAsCode
} from '../ui-core/config/boostPadGeometry.js';
import {
  BOOST_PAD_BIG_HEIGHT,
  BOOST_PAD_SMALL_HEIGHT,
  BOOST_PAD_BIG_RADIUS,
  BOOST_PAD_SMALL_RADIUS,
  BOOST_PAD_BASE_HEIGHT,
  DEFAULT_BOOST_PAD_TUNER,
  prepareGlowGeometry,
  createUpwardGlowMaterial,
  createBigOrbShadowMesh,
  createFallbackPadMeshes,
  cloneModelWithMaterials,
  applyBoostPadVisualTuning
} from './arena/BoostPadShadersAndMeshes.js';
import {
  loadBoostPadTemplates,
  disposeBoostPadSystem
} from './arena/BoostPadTemplateLoader.js';
import { createCubicBezier } from '../utils/CubicBezier.js';

export {
  BOOST_PAD_BIG_HEIGHT,
  BOOST_PAD_SMALL_HEIGHT,
  BOOST_PAD_BIG_RADIUS,
  BOOST_PAD_SMALL_RADIUS,
  BOOST_PAD_BASE_HEIGHT,
  DEFAULT_BOOST_PAD_TUNER,
  prepareGlowGeometry,
  createUpwardGlowMaterial,
  createFallbackPadMeshes
};

/**
 * BoostPadSystem.js
 * Advanced manager for Rocket League's 34 boost pads (6 Large + 28 Small).
 */
export class BoostPadSystem {
  constructor() {
    this.pads = [];
    this._padView = new BoostPadStateView();
    this.tunerConfig = { ...DEFAULT_BOOST_PAD_TUNER };
    this.padPeakY = 6.6614;
    this.bigOrbs = [];
    this.bigShadows = [];
    this.padTemplates = null;

    this._glowBezierSolver = createCubicBezier(
      this.tunerConfig.bezierP1X,
      this.tunerConfig.bezierP1Y,
      this.tunerConfig.bezierP2X,
      this.tunerConfig.bezierP2Y
    );
    this._orbBezierSolver = createCubicBezier(
      this.tunerConfig.orbBezierP1X !== undefined ? this.tunerConfig.orbBezierP1X : 0,
      this.tunerConfig.orbBezierP1Y !== undefined ? this.tunerConfig.orbBezierP1Y : -1.15,
      this.tunerConfig.orbBezierP2X !== undefined ? this.tunerConfig.orbBezierP2X : 0,
      this.tunerConfig.orbBezierP2Y !== undefined ? this.tunerConfig.orbBezierP2Y : 1
    );
    this._bezierSolver = this._glowBezierSolver;

    this.collectAnimations = new Map();
    this.simulatedRefills = new Map();
    this.prevActiveStates = new Uint8Array(34);
    this.prevBufferCooldowns = new Float32Array(34);
    this.padCooldownTimers = new Float32Array(34);
    this._edgeStatesInitialized = false;

    this.sharedOrbMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.tunerConfig.orbColor),
      emissive: new THREE.Color(this.tunerConfig.orbColor),
      emissiveIntensity: this.tunerConfig.orbEmissiveIntensity,
      roughness: 0.2,
      metalness: 0.1
    });
  }

  async loadTemplates() {
    return loadBoostPadTemplates(this);
  }

  addPads(padsData, padTemplates = null, scene = null, onPadMeshAdded = null) {
    const { Group } = THREE;
    for (const oldPad of this.pads) {
      oldPad?.group?.removeFromParent?.();
    }
    this.pads.length = 0;
    this.bigOrbs.length = 0;
    this.bigShadows.length = 0;
    this.collectAnimations.clear();
    this.prevActiveStates.fill(0);
    this.prevBufferCooldowns.fill(0);
    this.padCooldownTimers.fill(0);
    this._edgeStatesInitialized = false;

    const templates = padTemplates || this.padTemplates;
    if (!templates && padsData.length > 0) {
      console.warn(
        `[BoostPadSystem] GLB boost pad templates are unavailable; falling back to procedural whitebox pad meshes for ${padsData.length} pads.`
      );
    }
    const computedAngles = computeAllPadRotations(this.tunerConfig);

    for (let padIndex = 0; padIndex < padsData.length; padIndex++) {
      const data = padsData[padIndex];
      let fullMesh, baseMesh, glowMesh = null, orbMesh = null;

      if (templates) {
        const srcFull = data.isBig ? templates.bigFull : templates.smallFull;
        const srcBase = data.isBig ? templates.bigBase : templates.smallBase;
        fullMesh = cloneModelWithMaterials(srcFull);
        baseMesh = cloneModelWithMaterials(srcBase);
      } else {
        const fallbacks = createFallbackPadMeshes(data.isBig);
        fullMesh = fallbacks.full;
        baseMesh = fallbacks.base;
      }

      const padGlowMaterial = createUpwardGlowMaterial(this.tunerConfig);

      fullMesh.traverse((child) => {
        if (child.isMesh) {
          if (child.name.includes('Glow') || child.name === 'Active_Glow_Overlay' || child.name.includes('02_SM')) {
            prepareGlowGeometry(child);
            child.material = padGlowMaterial;
            child.castShadow = false;
            child.receiveShadow = false;
            glowMesh = child;
          } else if (child.name === 'BoostFloatingOrb') {
            orbMesh = child;
            this.bigOrbs.push(child);
          }
        }
      });

      let shadowMesh = null;
      if (data.isBig) {
        shadowMesh = createBigOrbShadowMesh(this.tunerConfig);
        shadowMesh.position.set(0, this.padPeakY + (this.tunerConfig.orbHeightOffset || 70), 0);
        this.bigShadows.push(shadowMesh);
      }

      const padGroup = new Group();
      padGroup.position.set(data.pos[0], this.tunerConfig.padHeightOffset || 0, data.pos[1]);
      padGroup.rotation.y = (computedAngles[padIndex] || 0) * (Math.PI / 180);
      padGroup.add(fullMesh, baseMesh);
      if (shadowMesh) {
        padGroup.add(shadowMesh);
      }
      baseMesh.visible = false;

      if (typeof onPadMeshAdded === 'function') {
        onPadMeshAdded(padGroup);
      }

      this.pads.push({
        id: padIndex,
        full: fullMesh,
        base: baseMesh,
        glowMesh,
        glowMaterial: padGlowMaterial,
        orbMesh,
        shadowMesh,
        group: padGroup,
        isBig: data.isBig,
        pos: data.pos,
        angleDeg: computedAngles[padIndex] || 0
      });

      if (scene && typeof scene.add === 'function') {
        scene.add(padGroup);
      }
    }

    this.applyCurrentTuning();
  }

  updateVisualTuningParams(config) {
    if (!config) return;
    this.tunerConfig = { ...this.tunerConfig, ...config };

    if (
      config.bezierP1X !== undefined ||
      config.bezierP1Y !== undefined ||
      config.bezierP2X !== undefined ||
      config.bezierP2Y !== undefined
    ) {
      this._glowBezierSolver = createCubicBezier(
        this.tunerConfig.bezierP1X,
        this.tunerConfig.bezierP1Y,
        this.tunerConfig.bezierP2X,
        this.tunerConfig.bezierP2Y
      );
      this._bezierSolver = this._glowBezierSolver;
    }

    if (
      config.orbBezierP1X !== undefined ||
      config.orbBezierP1Y !== undefined ||
      config.orbBezierP2X !== undefined ||
      config.orbBezierP2Y !== undefined
    ) {
      this._orbBezierSolver = createCubicBezier(
        this.tunerConfig.orbBezierP1X !== undefined ? this.tunerConfig.orbBezierP1X : 0,
        this.tunerConfig.orbBezierP1Y !== undefined ? this.tunerConfig.orbBezierP1Y : -1.15,
        this.tunerConfig.orbBezierP2X !== undefined ? this.tunerConfig.orbBezierP2X : 0,
        this.tunerConfig.orbBezierP2Y !== undefined ? this.tunerConfig.orbBezierP2Y : 1
      );
    }

    this.applyCurrentTuning();
  }

  applyCurrentTuning() {
    applyBoostPadVisualTuning(this);
  }

  simulateCollect(padIndex = 0) {
    this.startCollectAnimation(padIndex);
  }

  simulateCollectAll() {
    for (let i = 0; i < this.pads.length; i++) {
      this.startCollectAnimation(i);
    }
  }

  simulateRefill(padIndex = 0, duration = null) {
    const pad = this.pads[padIndex];
    if (!pad) return;
    const dur = duration || (pad.isBig ? (this.tunerConfig.bigRefillThreshold || 3) : (this.tunerConfig.smallRefillThreshold || 1));
    this.simulatedRefills.set(padIndex, {
      startTime: performance.now(),
      duration: Math.max(0.1, dur * 1000),
      isBig: pad.isBig
    });
  }

  simulateRefillAll(duration = null) {
    for (let i = 0; i < this.pads.length; i++) {
      this.simulateRefill(i, duration);
    }
  }

  startCollectAnimation(padIndex) {
    const pad = this.pads[padIndex];
    if (!pad) return;

    const rawGlowDur = this.tunerConfig.collectDuration;
    const glowDurMs = (rawGlowDur !== undefined && rawGlowDur > 10) ? rawGlowDur : (rawGlowDur || 0.3) * 1000;

    const rawOrbDur = this.tunerConfig.orbCollectDuration;
    const orbDurMs = (rawOrbDur !== undefined && rawOrbDur > 10) ? rawOrbDur : (rawOrbDur !== undefined ? rawOrbDur * 1000 : 200);

    const overallDuration = Math.max(glowDurMs, orbDurMs);

    this.collectAnimations.set(padIndex, {
      startTime: performance.now(),
      glowDuration: Math.max(50, glowDurMs),
      orbDuration: Math.max(50, orbDurMs),
      duration: Math.max(50, overallDuration),
      isBig: pad.isBig
    });

    if (pad.shadowMesh) {
      pad.shadowMesh.visible = false;
    }
  }

  update(stateBuffer, boostPadStatesOffset, dt = 0.016, camera = null) {
    if (!stateBuffer || this.pads.length === 0) return;

    const now = performance.now();
    const safeDt = Number.isFinite(dt) && dt > 0 ? Math.min(0.25, dt) : 0.016;
    const c = this.tunerConfig;
    const bigThreshold = c.bigRefillThreshold || 3.0;
    const smallThreshold = c.smallRefillThreshold || 1.0;
    const firstFrame = !this._edgeStatesInitialized;

    for (let i = 0; i < this.pads.length; i++) {
      const pad = this.pads[i];
      this._padView.attach(stateBuffer, i);

      const isActive = this._padView.isActive;
      const fullTimeout = pad.isBig ? 10.0 : 4.0;
      const bufferCooldown = this._padView.cooldown;

      if (firstFrame) {
        this.prevActiveStates[i] = isActive ? 1 : 0;
        this.prevBufferCooldowns[i] = isActive ? 0.0 : bufferCooldown;
        this.padCooldownTimers[i] = isActive
          ? 0.0
          : (bufferCooldown > 0 && bufferCooldown <= fullTimeout ? bufferCooldown : fullTimeout);
      } else {
        const wasActive = this.prevActiveStates[i] === 1;
        const prevBufferCd = this.prevBufferCooldowns[i];
        const respawnedAndCollected =
          !wasActive && !isActive && prevBufferCd > 0 && bufferCooldown > prevBufferCd + 0.5;
        if ((wasActive && !isActive) || respawnedAndCollected) {
          this.startCollectAnimation(i);
          this.padCooldownTimers[i] =
            bufferCooldown > 0 && bufferCooldown <= fullTimeout ? bufferCooldown : fullTimeout;
        } else if (!isActive) {
          this.padCooldownTimers[i] = Math.max(0.0, this.padCooldownTimers[i] - safeDt);
          if (
            bufferCooldown > 0 &&
            bufferCooldown < fullTimeout &&
            Math.abs(this.padCooldownTimers[i] - bufferCooldown) > 0.5
          ) {
            this.padCooldownTimers[i] = bufferCooldown;
          }
        } else {
          this.padCooldownTimers[i] = 0.0;
        }
        this.prevActiveStates[i] = isActive ? 1 : 0;
        this.prevBufferCooldowns[i] = isActive ? 0.0 : bufferCooldown;
      }

      const cooldownTimer = isActive ? 0.0 : this.padCooldownTimers[i];

      const simRefill = this.simulatedRefills.get(i);
      let isSimulatingRefill = false;
      let simProgress = 0;
      if (simRefill) {
        const elapsed = now - simRefill.startTime;
        if (elapsed < simRefill.duration) {
          isSimulatingRefill = true;
          simProgress = elapsed / simRefill.duration;
        } else {
          this.simulatedRefills.delete(i);
        }
      }

      const anim = this.collectAnimations.get(i);
      let animProgress = 1.0;
      if (anim) {
        const elapsed = now - anim.startTime;
        animProgress = Math.min(1.0, elapsed / anim.duration);
        const glowProgress = Math.min(1.0, elapsed / anim.glowDuration);
        const orbProgress = Math.min(1.0, elapsed / anim.orbDuration);

        const glowEased = this._glowBezierSolver ? this._glowBezierSolver(glowProgress) : glowProgress;
        const orbEased = this._orbBezierSolver ? this._orbBezierSolver(orbProgress) : orbProgress;

        if (pad.glowMesh) {
          pad.glowMesh.scale.y = Math.max(0.001, 1.0 - glowEased);
        }

        if (pad.isBig && pad.orbMesh) {
          const baseRadius = c.orbRadius || DEFAULT_BOOST_PAD_TUNER.orbRadius;
          const baseY = this.padPeakY + (c.orbHeightOffset !== undefined ? c.orbHeightOffset : DEFAULT_BOOST_PAD_TUNER.orbHeightOffset);
          const dropDistance = c.orbDropDistance !== undefined ? c.orbDropDistance : 175;
          pad.orbMesh.position.y = baseY - orbEased * dropDistance;
          pad.orbMesh.scale.set(baseRadius, baseRadius, baseRadius);
          pad.orbMesh.visible = elapsed < anim.orbDuration;
        }

        if (animProgress >= 1.0) {
          this.collectAnimations.delete(i);
        }
      } else {
        if (pad.glowMesh) pad.glowMesh.scale.y = 1.0;
        if (pad.isBig && pad.orbMesh) {
          const baseRadius = c.orbRadius || DEFAULT_BOOST_PAD_TUNER.orbRadius;
          const baseY = this.padPeakY + (c.orbHeightOffset !== undefined ? c.orbHeightOffset : DEFAULT_BOOST_PAD_TUNER.orbHeightOffset);
          pad.orbMesh.scale.set(baseRadius, baseRadius, baseRadius);
          pad.orbMesh.position.y = baseY;
        }
      }

      const threshold = pad.isBig ? bigThreshold : smallThreshold;
      const isRefilling = isSimulatingRefill || (c.refillEnabled && cooldownTimer <= threshold && cooldownTimer > 0);

      if (isRefilling) {
        pad.full.visible = true;
        pad.base.visible = true;
        if (pad.orbMesh) pad.orbMesh.visible = false;
        if (pad.shadowMesh) pad.shadowMesh.visible = false;

        const progress = isSimulatingRefill
          ? simProgress
          : Math.min(1.0, Math.max(0.0, 1.0 - (cooldownTimer / threshold)));

        if (pad.glowMaterial?.uniforms?.uRefillActive) {
          pad.glowMaterial.uniforms.uRefillActive.value = 1.0;
          pad.glowMaterial.uniforms.uRefillProgress.value = progress;
        }
      } else if (isActive && animProgress >= 1.0) {
        pad.full.visible = true;
        pad.base.visible = false;
        if (pad.orbMesh) pad.orbMesh.visible = true;
        if (pad.shadowMesh) {
          pad.shadowMesh.visible = c.shadowEnabled !== false;
          if (pad.shadowMesh.visible && camera) {
            const dist = camera.position.distanceTo(pad.group.position);
            const baseScale = c.shadowRadius !== undefined ? c.shadowRadius : 10.0;
            const distScale = baseScale + dist * (c.shadowDistanceScale !== undefined ? c.shadowDistanceScale : 0.012);
            pad.shadowMesh.scale.set(distScale, distScale, 1.0);
          }
        }

        if (pad.glowMaterial?.uniforms?.uRefillActive) {
          pad.glowMaterial.uniforms.uRefillActive.value = 0.0;
        }
      } else {
        pad.full.visible = anim !== undefined;
        pad.base.visible = true;
        if (pad.orbMesh) {
          if (anim) {
            const elapsed = now - anim.startTime;
            pad.orbMesh.visible = elapsed < anim.orbDuration;
          } else {
            pad.orbMesh.visible = false;
          }
        }
        if (pad.shadowMesh) pad.shadowMesh.visible = false;
        if (pad.glowMaterial?.uniforms?.uRefillActive) {
          pad.glowMaterial.uniforms.uRefillActive.value = 0.0;
        }
      }
    }
    this._edgeStatesInitialized = true;
  }

  exportRotations() {
    const angles = computeAllPadRotations(this.tunerConfig);
    return exportRotationsAsCode(angles);
  }

  dispose() {
    disposeBoostPadSystem(this);
  }
}
