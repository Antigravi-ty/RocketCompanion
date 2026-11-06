/**
 * SpatialAudioDebugVisualizer.ts
 * Decoupled Three.js SubController for In-Arena 3D Spatial Audio Attenuation Visualization.
 */

import * as THREE from 'three';
import {
  evaluateProfileDistanceGain,
  getArenaAcousticScale,
  isDistanceCulled,
  solveIsoGainRadiusUU,
} from '../../audio/SpatialAttenuationEvaluator.ts';
import {
  getSpatialAttenuationProfile,
  spatialAttenuationProfiles,
} from '../../ui-core/config/spatialAttenuationProfiles';
import {
  getSpatialAudioVisualizerConfig,
  publishSpatialAudioVisualizerTelemetry,
  registerSpatialAudioVisualizerApplier,
  type SpatialAudioVisualizerConfig,
} from '../../ui-core/config/spatialAudioVisualizerConfig';
import {
  INNER_COLOR_HEX,
  ISO25_COLOR_HEX,
  ISO50_COLOR_HEX,
  ISO75_COLOR_HEX,
  OUTER_CULL_HEX,
  OUTER_FLOOR_HEX,
  createSpatialAudioBillboard,
  createUnitCircleLineGeometry,
  createUnitSphereWireframeGeometry,
  renderSpatialAudioBillboardLabel,
  type SpatialAudioBillboardResources,
} from './SpatialAudioDebugGeometries.ts';

export interface SpatialAudioArenaHost {
  ball?: THREE.Object3D | null;
  cars?: Array<THREE.Object3D | null | undefined>;
  camera?: THREE.Camera | null;
  playerCarIndex?: number;
  focusedCarIndex?: number;
  markRenderTreeChanged?(): void;
}

export class SpatialAudioDebugVisualizer {
  public readonly scene: THREE.Scene;
  public readonly rootGroup: THREE.Group;

  private _innerSphereGroup: THREE.Group | null = null;
  private _innerSphereWire: THREE.LineSegments | null = null;
  private _innerSphereShell: THREE.Mesh | null = null;
  private _innerGroundRing: THREE.LineSegments | null = null;

  private _outerSphereGroup: THREE.Group | null = null;
  private _outerSphereWire: THREE.LineSegments | null = null;
  private _outerSphereShell: THREE.Mesh | null = null;
  private _outerGroundRing: THREE.LineSegments | null = null;

  private _iso50GroundRing: THREE.LineSegments | null = null;
  private _iso50EquatorRing: THREE.LineSegments | null = null;
  private _iso75GroundRing: THREE.LineSegments | null = null;
  private _iso25GroundRing: THREE.LineSegments | null = null;

  private _rulerGroup: THREE.Group | null = null;
  private _rulerLine3D: THREE.Line | null = null;
  private _rulerGroundLine: THREE.Line | null = null;
  private _emitterBeacon: THREE.Mesh | null = null;
  private _listenerBeacon: THREE.Mesh | null = null;
  private _billboard: SpatialAudioBillboardResources | null = null;

  private readonly _emitterPos = new THREE.Vector3();
  private readonly _listenerPos = new THREE.Vector3();
  private readonly _anchorPos = new THREE.Vector3();
  private readonly _midPos = new THREE.Vector3();

  private _lastTelemetryMs = 0;
  private _unsubConfig: (() => void) | null = null;
  private _unsubProfiles: (() => boolean) | null = null;
  private _onChangedCallback: (() => void) | null = null;

  constructor(scene: THREE.Scene, onChangedCallback: (() => void) | null = null) {
    this.scene = scene;
    this._onChangedCallback = onChangedCallback;
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'SpatialAudioDebugVisualizer';
    this.rootGroup.visible = false;
    this.rootGroup.frustumCulled = false;
    this.scene.add(this.rootGroup);

    const weakThis = new WeakRef(this);
    this._unsubConfig = registerSpatialAudioVisualizerApplier(() => {
      weakThis.deref()?._onChangedCallback?.();
    });
    this._unsubProfiles = spatialAttenuationProfiles.subscribe(() => {
      weakThis.deref()?._onChangedCallback?.();
    });
  }

  private _ensureMeshes(): void {
    if (this._innerSphereGroup) return;

    const unitSphereWireGeo = createUnitSphereWireframeGeometry(64);
    const unitSphereShellGeo = new THREE.SphereGeometry(1, 28, 18);
    const solidCircleGeo = createUnitCircleLineGeometry(96, false);
    const dashedCircleGeo = createUnitCircleLineGeometry(96, true);

    // 1. Inner Sphere (R_min)
    this._innerSphereGroup = new THREE.Group();
    this._innerSphereWire = new THREE.LineSegments(
      unitSphereWireGeo,
      new THREE.LineBasicMaterial({
        color: INNER_COLOR_HEX,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      })
    );
    this._innerSphereShell = new THREE.Mesh(
      unitSphereShellGeo,
      new THREE.MeshBasicMaterial({
        color: INNER_COLOR_HEX,
        transparent: true,
        opacity: 0.05,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this._innerSphereGroup.add(this._innerSphereWire, this._innerSphereShell);
    this._innerSphereGroup.renderOrder = 990;

    this._innerGroundRing = new THREE.LineSegments(
      solidCircleGeo,
      new THREE.LineBasicMaterial({
        color: INNER_COLOR_HEX,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
    );
    this._innerGroundRing.renderOrder = 992;

    // 2. Outer Sphere (R_max)
    this._outerSphereGroup = new THREE.Group();
    this._outerSphereWire = new THREE.LineSegments(
      unitSphereWireGeo,
      new THREE.LineBasicMaterial({
        color: OUTER_CULL_HEX,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
    );
    this._outerSphereShell = new THREE.Mesh(
      unitSphereShellGeo,
      new THREE.MeshBasicMaterial({
        color: OUTER_CULL_HEX,
        transparent: true,
        opacity: 0.025,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this._outerSphereGroup.add(this._outerSphereWire, this._outerSphereShell);
    this._outerSphereGroup.renderOrder = 988;

    this._outerGroundRing = new THREE.LineSegments(
      solidCircleGeo,
      new THREE.LineBasicMaterial({
        color: OUTER_CULL_HEX,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
    );
    this._outerGroundRing.renderOrder = 991;

    // 3. Iso-Gain Contour Rings (50% Half-Power + 75% / 25% contours)
    this._iso50GroundRing = new THREE.LineSegments(
      dashedCircleGeo,
      new THREE.LineBasicMaterial({
        color: ISO50_COLOR_HEX,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      })
    );
    this._iso50GroundRing.renderOrder = 993;

    this._iso50EquatorRing = new THREE.LineSegments(
      dashedCircleGeo,
      new THREE.LineBasicMaterial({
        color: ISO50_COLOR_HEX,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      })
    );
    this._iso50EquatorRing.renderOrder = 991;

    this._iso75GroundRing = new THREE.LineSegments(
      dashedCircleGeo,
      new THREE.LineBasicMaterial({
        color: ISO75_COLOR_HEX,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
    );
    this._iso75GroundRing.renderOrder = 991;

    this._iso25GroundRing = new THREE.LineSegments(
      dashedCircleGeo,
      new THREE.LineBasicMaterial({
        color: ISO25_COLOR_HEX,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
    );
    this._iso25GroundRing.renderOrder = 991;

    // 4. Radial Attenuation Ruler & Beacons
    this._rulerGroup = new THREE.Group();
    const rulerGeo3D = new THREE.BufferGeometry();
    rulerGeo3D.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this._rulerLine3D = new THREE.Line(
      rulerGeo3D,
      new THREE.LineBasicMaterial({
        color: ISO50_COLOR_HEX,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      })
    );
    this._rulerLine3D.frustumCulled = false;
    this._rulerLine3D.renderOrder = 996;

    const rulerGeoGround = new THREE.BufferGeometry();
    rulerGeoGround.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this._rulerGroundLine = new THREE.Line(
      rulerGeoGround,
      new THREE.LineBasicMaterial({
        color: 0x94a3b8,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
    );
    this._rulerGroundLine.frustumCulled = false;
    this._rulerGroundLine.renderOrder = 994;

    const beaconGeo = new THREE.SphereGeometry(28, 14, 10);
    this._emitterBeacon = new THREE.Mesh(
      beaconGeo,
      new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      })
    );
    this._emitterBeacon.renderOrder = 998;

    this._listenerBeacon = new THREE.Mesh(
      beaconGeo,
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
    );
    this._listenerBeacon.renderOrder = 998;

    this._billboard = createSpatialAudioBillboard();
    if (this._billboard) {
      this._rulerGroup.add(this._billboard.sprite);
    }

    this._rulerGroup.add(
      this._rulerLine3D,
      this._rulerGroundLine,
      this._emitterBeacon,
      this._listenerBeacon
    );

    this.rootGroup.add(
      this._innerSphereGroup,
      this._innerGroundRing,
      this._outerSphereGroup,
      this._outerGroundRing,
      this._iso50GroundRing,
      this._iso50EquatorRing,
      this._iso75GroundRing,
      this._iso25GroundRing,
      this._rulerGroup
    );
  }

  private _resolveEntityPositions(
    arena: SpatialAudioArenaHost,
    camera: THREE.Camera | null,
    cfg: SpatialAudioVisualizerConfig
  ): void {
    const localIdx =
      typeof arena.focusedCarIndex === 'number'
        ? arena.focusedCarIndex
        : (arena.playerCarIndex ?? 0);
    const localCar = arena.cars?.[localIdx] || arena.cars?.[0] || null;

    if (cfg.emitterTarget === 'ball' && arena.ball) {
      this._emitterPos.copy(arena.ball.position);
    } else if (cfg.emitterTarget === 'local_car' && localCar) {
      this._emitterPos.copy(localCar.position);
      this._emitterPos.y += 25;
    } else if (cfg.emitterTarget === 'bot_car') {
      const targetIdx = cfg.targetCarIndex ?? 1;
      const botCar =
        arena.cars?.[targetIdx] ||
        arena.cars?.find((c, idx) => Boolean(c && c.visible && idx !== localIdx)) ||
        arena.ball;
      if (botCar) {
        this._emitterPos.copy(botCar.position);
        this._emitterPos.y += 25;
      } else {
        this._emitterPos.set(0, 93, 0);
      }
    } else {
      this._emitterPos.set(
        cfg.fixedPointUU.x,
        cfg.fixedPointUU.z,
        cfg.fixedPointUU.y
      );
    }

    if (cfg.listenerTarget === 'local_car' && localCar) {
      this._listenerPos.copy(localCar.position);
      this._listenerPos.y += 35;
    } else if (camera) {
      this._listenerPos.copy(camera.position);
    } else if (localCar) {
      this._listenerPos.copy(localCar.position);
      this._listenerPos.y += 35;
    } else {
      this._listenerPos.set(0, 150, -1500);
    }

    if (cfg.anchorMode === 'listener') {
      this._anchorPos.copy(this._listenerPos);
    } else {
      this._anchorPos.copy(this._emitterPos);
    }
  }

  public update(arena: SpatialAudioArenaHost | null | undefined, camera: THREE.Camera | null = null): void {
    if (!arena) return;
    const cfg = getSpatialAudioVisualizerConfig();
    if (!cfg.enabled) {
      if (this.rootGroup.visible) {
        this.rootGroup.visible = false;
      }
      return;
    }

    this._ensureMeshes();
    this.rootGroup.visible = true;

    const activeCamera = camera || arena.camera || null;
    const profile = getSpatialAttenuationProfile(cfg.activeCategory);
    this._resolveEntityPositions(arena, activeCamera, cfg);

    const acousticScale = getArenaAcousticScale();
    const rMin = Math.max(10, profile.minDistanceUU * acousticScale);
    const rMax = Math.max(rMin + 20, profile.maxDistanceUU * acousticScale);
    const r75 = solveIsoGainRadiusUU(profile, 0.75);
    const r50 = solveIsoGainRadiusUU(profile, 0.5);
    const r25 = solveIsoGainRadiusUU(profile, 0.25);

    const distUU = this._emitterPos.distanceTo(this._listenerPos);
    const culled = isDistanceCulled(distUU, profile);
    const gain = culled ? 0.0 : evaluateProfileDistanceGain(distUU, profile);

    const opacityScale = cfg.sphereOpacity;
    const depthTest = cfg.depthTest;
    const groundY = 5.0;

    if (this._innerSphereGroup && this._innerGroundRing && this._innerSphereWire && this._innerSphereShell) {
      this._innerSphereGroup.visible = cfg.showInnerSphere;
      this._innerGroundRing.visible = cfg.showInnerSphere;
      if (cfg.showInnerSphere) {
        this._innerSphereGroup.position.copy(this._anchorPos);
        this._innerSphereGroup.scale.setScalar(rMin);
        this._innerGroundRing.position.set(this._anchorPos.x, groundY, this._anchorPos.z);
        this._innerGroundRing.scale.setScalar(rMin);

        const wireMat = this._innerSphereWire.material as THREE.LineBasicMaterial;
        wireMat.opacity = 0.7 * opacityScale;
        wireMat.depthTest = depthTest;
        const shellMat = this._innerSphereShell.material as THREE.MeshBasicMaterial;
        shellMat.opacity = 0.06 * opacityScale;
        shellMat.depthTest = depthTest;
      }
    }

    const outerColor =
      profile.cullBeyondMax && profile.minGainFloor <= 1e-5 ? OUTER_CULL_HEX : OUTER_FLOOR_HEX;
    if (this._outerSphereGroup && this._outerGroundRing && this._outerSphereWire && this._outerSphereShell) {
      this._outerSphereGroup.visible = cfg.showOuterSphere;
      this._outerGroundRing.visible = cfg.showOuterSphere;
      if (cfg.showOuterSphere) {
        this._outerSphereGroup.position.copy(this._anchorPos);
        this._outerSphereGroup.scale.setScalar(rMax);
        this._outerGroundRing.position.set(this._anchorPos.x, groundY, this._anchorPos.z);
        this._outerGroundRing.scale.setScalar(rMax);

        const wireMat = this._outerSphereWire.material as THREE.LineBasicMaterial;
        wireMat.color.setHex(outerColor);
        wireMat.opacity = 0.5 * opacityScale;
        wireMat.depthTest = depthTest;
        const shellMat = this._outerSphereShell.material as THREE.MeshBasicMaterial;
        shellMat.color.setHex(outerColor);
        shellMat.opacity = 0.025 * opacityScale;
        shellMat.depthTest = depthTest;
        const ringMat = this._outerGroundRing.material as THREE.LineBasicMaterial;
        ringMat.color.setHex(outerColor);
      }
    }

    if (this._iso50GroundRing && this._iso50EquatorRing && this._iso75GroundRing && this._iso25GroundRing) {
      this._iso50GroundRing.visible = cfg.showIsoRing50;
      this._iso50EquatorRing.visible = cfg.showIsoRing50;
      this._iso75GroundRing.visible = cfg.showIsoRing50 && r75 > rMin + 10 && r75 < rMax - 10;
      this._iso25GroundRing.visible = cfg.showIsoRing50 && r25 > rMin + 10 && r25 < rMax - 10;

      if (cfg.showIsoRing50) {
        this._iso50GroundRing.position.set(this._anchorPos.x, groundY + 1, this._anchorPos.z);
        this._iso50GroundRing.scale.setScalar(r50);

        this._iso50EquatorRing.position.copy(this._anchorPos);
        this._iso50EquatorRing.scale.setScalar(r50);

        this._iso75GroundRing.position.set(this._anchorPos.x, groundY + 0.5, this._anchorPos.z);
        this._iso75GroundRing.scale.setScalar(r75);

        this._iso25GroundRing.position.set(this._anchorPos.x, groundY + 0.5, this._anchorPos.z);
        this._iso25GroundRing.scale.setScalar(r25);
      }
    }

    if (this._rulerGroup && this._rulerLine3D && this._rulerGroundLine && this._emitterBeacon && this._listenerBeacon) {
      this._rulerGroup.visible = cfg.showRadialRuler;
      if (cfg.showRadialRuler) {
        const pos3D = this._rulerLine3D.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos3D.setXYZ(0, this._emitterPos.x, this._emitterPos.y, this._emitterPos.z);
        pos3D.setXYZ(1, this._listenerPos.x, this._listenerPos.y, this._listenerPos.z);
        pos3D.needsUpdate = true;

        const posGround = this._rulerGroundLine.geometry.getAttribute('position') as THREE.BufferAttribute;
        posGround.setXYZ(0, this._emitterPos.x, groundY + 2, this._emitterPos.z);
        posGround.setXYZ(1, this._listenerPos.x, groundY + 2, this._listenerPos.z);
        posGround.needsUpdate = true;

        const rulerMat = this._rulerLine3D.material as THREE.LineBasicMaterial;
        rulerMat.color.setHex(
          culled ? 0xf43f5e : gain >= 0.999 ? INNER_COLOR_HEX : ISO50_COLOR_HEX
        );

        this._emitterBeacon.position.copy(this._emitterPos);
        this._listenerBeacon.position.copy(this._listenerPos);

        if (this._billboard) {
          this._midPos.lerpVectors(this._emitterPos, this._listenerPos, 0.35);
          this._midPos.y = Math.max(this._emitterPos.y, this._listenerPos.y, 120) + 140;
          this._billboard.sprite.position.copy(this._midPos);

          const camDist = activeCamera
            ? Math.max(400, activeCamera.position.distanceTo(this._midPos))
            : 1800;
          const spriteScale = Math.min(1800, Math.max(260, camDist * 0.28));
          this._billboard.sprite.scale.set(spriteScale, spriteScale * (144 / 512), 1);

          renderSpatialAudioBillboardLabel(
            this._billboard,
            profile,
            cfg,
            distUU,
            gain,
            culled,
            r50,
            rMin,
            rMax
          );
        }
      }
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this._lastTelemetryMs >= 60) {
      this._lastTelemetryMs = now;
      publishSpatialAudioVisualizerTelemetry({
        distanceUU: Math.round(distUU),
        gain,
        gainDb: gain <= 1e-4 ? -100 : Number((20 * Math.log10(gain)).toFixed(1)),
        isCulled: culled,
        isoRadius25UU: Math.round(r25),
        isoRadius50UU: Math.round(r50),
        isoRadius75UU: Math.round(r75),
        emitterPosUU: [
          Math.round(this._emitterPos.x),
          Math.round(this._emitterPos.z),
          Math.round(this._emitterPos.y),
        ],
        listenerPosUU: [
          Math.round(this._listenerPos.x),
          Math.round(this._listenerPos.z),
          Math.round(this._listenerPos.y),
        ],
      });
    }
  }

  public dispose(): void {
    this._unsubConfig?.();
    this._unsubConfig = null;
    this._unsubProfiles?.();
    this._unsubProfiles = null;
    this._billboard?.texture.dispose();
    this._billboard = null;
    this.rootGroup.traverse((node: THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }) => {
      node.geometry?.dispose?.();
      if (node.material) {
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
          m?.dispose?.();
        }
      }
    });
    this.scene?.remove?.(this.rootGroup);
  }
}
