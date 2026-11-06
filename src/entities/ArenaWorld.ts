import * as THREE from 'three';
import { BoostPadSystem, DEFAULT_BOOST_PAD_TUNER } from './BoostPadSystem.ts';
import { BallLocatorArrow } from './BallLocatorArrow.ts';
import { SpeedTrail } from './SpeedTrail.ts';
import { onThemeChange } from '../ui-core/config/themeConfig';
import { ArenaHeaderView, CarStateView, BallStateView, type NumericStateBuffer } from '../physics/RocketSimStateViews.ts';
import { BOT_CAR_INDEX } from './arena/ArenaConstants.ts';
import { unrealToThreeCoords, interpolatePhysicsTransform } from './arena/ArenaMath.ts';
import { createStadiumDomeSky, updateSkyboxConfig, updateSkyboxFrame } from './arena/ArenaSky.ts';
import { ArenaLightingManager } from './arena/ArenaLighting.ts';
import {
  ArenaVehicleRegistry,
  updateBoostVisuals,
  type CarControlInput,
  type CarControlsResolver,
  type CarLoadoutConfig,
  type VehicleVisualInput,
  type VehicleWheelSet,
} from './arena/ArenaVehicleRegistry.ts';
import type { TraversableMaterialNode } from './arena/VehiclePaint.ts';
import { loadBallAssetInto, loadCarAndPadAssets, loadArenaStadiumMeshes, preloadRemainingVehicleAssets, runParallelArenaAssetSteps } from './arena/ArenaAssetLoader.ts';
import { updateBallVisualConfig, type BallVisualConfig } from '../ui-core/config/ballVisualConfig';
import { updateBallGoalEffect } from './BallVisual.ts';
import { updateCarSuspensionAndSteering } from './VehicleSuspensionSystem.ts';
import { updateVehicleBrakeLamps } from './vehicle/vehicleWheelsAndLamps.ts';
import { VehicleNameTagSystem } from './arena/VehicleNameTagSystem.ts';
import { VehicleAerialClimbTracker, type CarAerialClimbStatus } from './arena/VehicleAerialClimbTracker.ts';
import { getNameTagConfig } from '../game/runtimeUiPort.ts';
import { createDriftwoodsManager, type DriftwoodsMaterialManager } from './stadium/driftwoods/DriftwoodsMaterialManager.ts';
import { setExperimentalWallFxRuntimeConfig, updateShadowRuntimeConfig, type ExperimentalWallFxConfig, type ShadowConfig } from '../ui-core/config/atmosphereFxConfig';
import type { DriftwoodsTunerConfig } from '../ui-core/config/driftwoodsConfig';
import type { SkyboxConfig } from '../ui-core/config/skyboxConfig';
import type { GoalBarrierDecomposition, GoalBarrierTargetGoal } from '../ui-core/config/goalBarrierConfig';
import {
  loadThrowbackStadiumField,
  loadThrowbackCollisionOverlay,
  preloadThrowbackStadiumAssets,
} from './stadium/ThrowbackStadiumLoader.ts';
import { preloadThrowbackCollisionMeshes } from '../physics/RocketSimMeshLoader.ts';
import { GoalBarrierVisual } from './arena/GoalBarrierVisual.ts';
import { GoalVolumeHitboxVisual } from './arena/GoalVolumeHitboxVisual.ts';
import { RespawnGhostPreview } from './arena/RespawnGhostPreview.ts';
import { SpatialAudioDebugVisualizer } from './arena/SpatialAudioDebugVisualizer.ts';
import { SupersonicWheelTrailSystem } from './vehicle/supersonic-trail/SupersonicWheelTrailSystem.ts';
import type { VehicleBoostEmitter } from './vehicle/boost/vehicleBoostEmitter.ts';
import type { DemolitionEffect } from './DemolitionEffect.ts';

export interface BoostPadDefinition { isBig: boolean; pos: [number, number] | number[]; }
export interface BoostPadTemplates {
  bigFull: THREE.Group; bigBase: THREE.Group; bigGlow: THREE.Group;
  smallFull: THREE.Group; smallBase: THREE.Group; smallGlow: THREE.Group;
}
export interface BoostPadInstance {
  id: number; full: THREE.Object3D; base: THREE.Object3D;
  glowMesh: THREE.Mesh | null; glowMaterial: THREE.Material;
  orbMesh: THREE.Mesh | null; shadowMesh: THREE.Mesh | null;
  group: THREE.Group; isBig: boolean; pos: [number, number] | number[] | Float32Array; angleDeg: number;
}
export type BoostPadTunerConfig = typeof DEFAULT_BOOST_PAD_TUNER;

function disposeMaterialSlot(material: THREE.Material | THREE.Material[] | null | undefined): void {
  if (!material) return;
  for (const mat of Array.isArray(material) ? material : [material]) mat?.dispose?.();
}

export class ArenaWorld {
  public scene: THREE.Scene;
  public ball: THREE.Group;
  public pads: BoostPadInstance[];
  public boostPadSystem: BoostPadSystem;
  public padTemplates: BoostPadTemplates | null;
  public ballRadius: number;
  public ballSpeedTrail: SpeedTrail;
  public ballLocatorArrow: BallLocatorArrow;
  public ballVelocity: THREE.Vector3;
  public _renderTreeVersion: number;
  public playerCarIndex: number;
  public vehiclePreset: string;
  public carVisual: string;
  public pA: THREE.Vector3;
  public pB: THREE.Vector3;
  public qA: THREE.Quaternion;
  public qB: THREE.Quaternion;
  public lighting: ArenaLightingManager;
  public sky: THREE.Mesh;
  public goalBarrierVisual: GoalBarrierVisual;
  public goalVolumeHitboxVisual: GoalVolumeHitboxVisual;
  public indicatorRing: THREE.Mesh;
  public indicatorHeightRing: THREE.Mesh;
  public vehicleRegistry: ArenaVehicleRegistry;
  public cars: Array<THREE.Group | null>;
  public vehiclePresets: Array<string | null>;
  public carWheels: Array<VehicleWheelSet | null>;
  public carBoosts: Array<VehicleBoostEmitter[] | null>;
  public carDemolitions: Array<DemolitionEffect | null>;
  public carBoostAmounts: Float32Array;
  public carVerticalVelZUu: Float32Array;
  public carAirborneFlipExhausted: Uint8Array;
  public aerialClimbTracker: VehicleAerialClimbTracker;
  public carAerialClimbStatuses: CarAerialClimbStatus[];
  public nameTagSystem: VehicleNameTagSystem;
  public respawnGhostPreview: RespawnGhostPreview;
  public spatialAudioVisualizer: SpatialAudioDebugVisualizer;
  public supersonicWheelTrailSystem: SupersonicWheelTrailSystem;
  public stadiumVisible: boolean;
  public driftwoodsStadiumVisible: boolean;
  public driftwoodsStadium: THREE.Group | null;
  public driftwoodsManager: DriftwoodsMaterialManager | null;
  public pendingDriftwoodsConfig: Partial<DriftwoodsTunerConfig> | null;
  public throwbackStadium: THREE.Group | null;
  public throwbackCollisionOverlay: THREE.Group | null;
  public isThrowbackStadiumActive: boolean;
  public collisionOverlayRequested: boolean;
  public _headerView: ArenaHeaderView;
  public _currCarView: CarStateView;
  public _prevCarView: CarStateView;
  public _currBallView: BallStateView;
  public _prevBallView: BallStateView;
  public camera?: THREE.Camera | null;
  public cameraMode?: string;
  public isPovCamera?: boolean;
  public isFreeCam?: boolean;
  public focusedCarIndex?: number;
  public isLobbyMode?: boolean;
  public isHostLobby?: boolean;
  public isGoalReplayActive?: boolean;

  constructor(ballRadius: number, defaultCarVisual = "fennec") {
    this.scene = new THREE.Scene();
    this.ball = new THREE.Group();
    this.pads = [];
    this.boostPadSystem = new BoostPadSystem();
    this.padTemplates = null;
    this.ballRadius = ballRadius;
    this.ballSpeedTrail = new SpeedTrail();
    this.ballLocatorArrow = new BallLocatorArrow();
    this.ballVelocity = new THREE.Vector3();
    this._renderTreeVersion = 0;
    this.playerCarIndex = 0;
    this.vehiclePreset = defaultCarVisual;
    this.carVisual = defaultCarVisual;

    this.pA = new THREE.Vector3();
    this.pB = new THREE.Vector3();
    this.qA = new THREE.Quaternion();
    this.qB = new THREE.Quaternion();

    this.scene.background = new THREE.Color(4679561);
    this.scene.fog = new THREE.Fog(6586005, 15000, 34000);

    this.lighting = new ArenaLightingManager(this.scene);

    this.sky = createStadiumDomeSky();
    this.goalBarrierVisual = new GoalBarrierVisual();
    this.goalVolumeHitboxVisual = new GoalVolumeHitboxVisual();
    this.scene.add(this.sky, this.ball, this.goalBarrierVisual.group, this.goalVolumeHitboxVisual.group);
    if (this.ballLocatorArrow?.object) this.scene.add(this.ballLocatorArrow.object);
    if (this.ballSpeedTrail?.object) this.scene.add(this.ballSpeedTrail.object);

    const ringRadius = ballRadius * 1.15;
    const ringGeom = new THREE.RingGeometry(ringRadius * 0.92, ringRadius, 48);
    const ringMat = new THREE.MeshBasicMaterial({ color: 16777215, transparent: true, opacity: 0.2, depthWrite: false });
    this.indicatorRing = new THREE.Mesh(ringGeom, ringMat);
    this.indicatorHeightRing = new THREE.Mesh(ringGeom, ringMat);
    for (const r of [this.indicatorRing, this.indicatorHeightRing]) {
      r.rotation.x = -Math.PI / 2;
      r.renderOrder = 2;
      this.scene.add(r);
    }

    const vr = this.vehicleRegistry = new ArenaVehicleRegistry(this.scene, () => this.markRenderTreeChanged());
    this.cars = vr.cars;
    this.vehiclePresets = vr.vehiclePresets;
    this.carWheels = vr.carWheels;
    this.carBoosts = vr.carBoosts;
    this.carDemolitions = vr.carDemolitions;
    this.carBoostAmounts = new Float32Array(8);
    this.carVerticalVelZUu = new Float32Array(8);
    this.carAirborneFlipExhausted = new Uint8Array(8);
    this.aerialClimbTracker = new VehicleAerialClimbTracker(8);
    this.carAerialClimbStatuses = Array.from({ length: 8 }, (_, idx) =>
      this.aerialClimbTracker.getStatus(idx)
    );
    this.nameTagSystem = new VehicleNameTagSystem(this.scene);
    this.respawnGhostPreview = new RespawnGhostPreview(this);
    this.spatialAudioVisualizer = new SpatialAudioDebugVisualizer(this.scene, () => this.markRenderTreeChanged());
    this.supersonicWheelTrailSystem = new SupersonicWheelTrailSystem(this.scene);

    this.stadiumVisible = true;
    this.driftwoodsStadiumVisible = true;
    this.driftwoodsStadium = null;
    this.driftwoodsManager = null;
    this.pendingDriftwoodsConfig = null;
    this.throwbackStadium = null;
    this.throwbackCollisionOverlay = null;
    this.isThrowbackStadiumActive = false;
    this.collisionOverlayRequested = false;

    this._headerView = new ArenaHeaderView();
    this._currCarView = new CarStateView();
    this._prevCarView = new CarStateView();
    this._currBallView = new BallStateView();
    this._prevBallView = new BallStateView();

    this.markRenderTreeChanged();
    if (typeof onThemeChange === 'function') {
      const weakThis = new WeakRef(this);
      onThemeChange(() => weakThis.deref()?.markRenderTreeChanged());
    }
  }

  get carHitboxesVisible() { return this.vehicleRegistry.carHitboxesVisible; }
  set carHitboxesVisible(v) { this.vehicleRegistry.carHitboxesVisible = v; }
  get carColors() { return this.vehicleRegistry.carColors; }
  set carColors(v) { this.vehicleRegistry.carColors = v; }

  resetBallTrail() { this.ballSpeedTrail?.reset(); }
  resetCarBoosts(carIndex: number | null = null) {
    this.vehicleRegistry?.resetCarBoosts?.(carIndex);
    this.supersonicWheelTrailSystem?.resetCar(carIndex);
  }
  resetAllCarEffects() {
    this.vehicleRegistry?.resetAllCarEffects?.();
    this.supersonicWheelTrailSystem?.resetCar(null);
    this.ballSpeedTrail?.reset?.();
  }
  get renderTreeVersion() { return this._renderTreeVersion; }
  markRenderTreeChanged() { this._renderTreeVersion++; }

  get boostBloomActive() {
    if (!Array.isArray(this.carBoosts)) return false;
    for (const group of this.carBoosts) {
      if (Array.isArray(group) && group.some((emitter: VehicleBoostEmitter) => emitter?.bloomActive)) return true;
    }
    return false;
  }

  async loadBall() {
    await loadBallAssetInto(this.ball);
    this.markRenderTreeChanged();
  }

  updateBallLocatorArrow(ballCamActive: boolean, carIndex = 0, targetBall: THREE.Object3D | null = this.ball, targetCar: THREE.Object3D | null = null) {
    this.ballLocatorArrow?.update(targetCar || this.cars[carIndex] || this.cars[0], targetBall || this.ball, ballCamActive);
  }

  async loadAllAssets(onProgress: ((progress: number, name: string) => void) | null = null) {
    await runParallelArenaAssetSteps(
      [
        { label: "Stadium Architecture & Boundary", run: () => this.loadArena() },
        { label: "Ball Geometry", run: () => this.loadBall() },
        { label: "Vehicle Models & Boost Pads", run: () => this.loadCarAndPadAssets() }
      ],
      onProgress
    );
    this.markRenderTreeChanged();
  }

  async loadCarAndPadAssets() {
    this.padTemplates = await loadCarAndPadAssets(this.vehicleRegistry, this.boostPadSystem, this.vehiclePreset);
    this.markRenderTreeChanged();
  }

  async loadArena() {
    const meshes = await loadArenaStadiumMeshes();
    if (meshes.driftwoodsStadium) {
      this.driftwoodsStadium = meshes.driftwoodsStadium;
      this.driftwoodsManager = createDriftwoodsManager(this.driftwoodsStadium);
      if (this.pendingDriftwoodsConfig) this.driftwoodsManager.applyConfig(this.pendingDriftwoodsConfig);
      const teamCols = this.driftwoodsManager.getResolvedTeamColors?.();
      if (teamCols) this.goalBarrierVisual?.setTeamColors?.(teamCols.blue, teamCols.orange);
      this.driftwoodsStadiumVisible = true;
      if (!this.driftwoodsStadium.parent) {
        this.scene.add(this.driftwoodsStadium);
      }
      this.driftwoodsStadium.visible = Boolean(this.stadiumVisible && !this.isThrowbackStadiumActive);
    }
    this.markRenderTreeChanged();
  }

  async setThrowbackStadiumActive(enabled: boolean, showCollisionOverlay = false) {
    const next = Boolean(enabled);
    this.isThrowbackStadiumActive = next;
    this.goalVolumeHitboxVisual?.setArenaPreset(next);
    if (next) {
      if (!this.throwbackStadium) this.throwbackStadium = await loadThrowbackStadiumField();
      if (this.throwbackStadium && !this.throwbackStadium.parent) this.scene.add(this.throwbackStadium);
      if (this.throwbackStadium) this.throwbackStadium.visible = Boolean(this.stadiumVisible);
      if (this.driftwoodsStadium) this.driftwoodsStadium.visible = false;
      await this.setThrowbackCollisionVisible(showCollisionOverlay);
    } else {
      if (this.throwbackStadium) this.throwbackStadium.visible = false;
      if (this.throwbackCollisionOverlay) this.throwbackCollisionOverlay.visible = false;
      if (this.driftwoodsStadium) this.driftwoodsStadium.visible = Boolean(this.stadiumVisible);
      this.collisionOverlayRequested = Boolean(showCollisionOverlay);
    }
    this.markRenderTreeChanged();
  }

  async setThrowbackCollisionVisible(visible: boolean) {
    const next = Boolean(visible);
    this.collisionOverlayRequested = next;
    if (next && this.isThrowbackStadiumActive) {
      if (!this.throwbackCollisionOverlay) this.throwbackCollisionOverlay = await loadThrowbackCollisionOverlay();
      if (this.throwbackCollisionOverlay && !this.throwbackCollisionOverlay.parent) this.scene.add(this.throwbackCollisionOverlay);
    }
    if (this.throwbackCollisionOverlay) {
      this.throwbackCollisionOverlay.visible = Boolean(next && this.isThrowbackStadiumActive);
    }
    this.markRenderTreeChanged();
  }

  updateDriftwoodsTuner(config: Partial<DriftwoodsTunerConfig> | null | undefined) {
    if (!config) return;
    this.pendingDriftwoodsConfig = config;
    this.driftwoodsManager?.applyConfig(config);
    const teamCols = this.driftwoodsManager?.getResolvedTeamColors?.();
    if (teamCols) this.goalBarrierVisual?.setTeamColors?.(teamCols.blue, teamCols.orange);
  }

  setStadiumVisible(visible: boolean) {
    if (this.stadiumVisible !== visible) {
      this.stadiumVisible = visible;
      if (this.sky) {
        visible ? this.scene.add(this.sky) : this.sky.removeFromParent?.();
      }
      const activeStadium = this.isThrowbackStadiumActive ? this.throwbackStadium : this.driftwoodsStadium;
      if (activeStadium) {
        activeStadium.visible = Boolean(visible);
      }
      this.scene.background = new THREE.Color(visible ? 4679561 : 0);
      this.markRenderTreeChanged();
    }
    if (this.isThrowbackStadiumActive && this.driftwoodsStadium) {
      this.driftwoodsStadium.visible = false;
    }
  }
  setCarColor(carIndex: number, colorVal: string | number | null | undefined) { this.vehicleRegistry.setCarColor(carIndex, colorVal); }
  setCarPaintFinish(carIndex: number, paintFinish: string | null) { this.vehicleRegistry.setCarPaintFinish?.(carIndex, paintFinish); }
  setCarBoostVisual(carIndex: number, boostVisual: string | null) { this.vehicleRegistry.setCarBoostVisual?.(carIndex, boostVisual); }
  setCarLoadout(carIndex: number, loadout: CarLoadoutConfig | null | undefined) { this.vehicleRegistry.setCarLoadout?.(carIndex, loadout); }
  async ensureOpponent() { await this.vehicleRegistry.ensureOpponent(() => this.lighting.ensureOpponentSun()); }

  async prepareAssets(onProgress: ((loaded: number, total: number, label: string) => void) | null = null) {
    let completed = 0;
    const total = 4;
    const report = (label: string) => {
      completed++;
      if (typeof onProgress === 'function') {
        onProgress(completed, total, label);
      }
    };
    await Promise.all([
      this.ensureOpponent().then(() => {
        if (this.cars[BOT_CAR_INDEX]) this.cars[BOT_CAR_INDEX]!.visible = false;
        report('Opponent Vehicle Rig');
      }),
      preloadRemainingVehicleAssets(this.vehicleRegistry).then(() => {
        report('Additional Vehicle GLB Models');
      }),
      Promise.all(
        this.carBoosts.flatMap(list => Array.isArray(list) ? list.map((emitter: VehicleBoostEmitter) => emitter?.preload?.()) : [])
      ).then(() => {
        report('Boost Emitter Textures');
      }),
      Promise.all([
        preloadThrowbackStadiumAssets().catch((err) => {
          console.warn('[ArenaWorld] Throwback stadium GLB preload warning:', err);
        }),
        preloadThrowbackCollisionMeshes().catch((err) => {
          console.warn('[ArenaWorld] Throwback collision mesh preload warning:', err);
        }),
      ]).then(() => {
        report('Throwback Stadium & Collision Meshes');
      }),
    ]);
  }

  addCar(teamIndex: number, visual: VehicleVisualInput = this.carVisual, targetIndex: number | null = null) { return this.vehicleRegistry.addCar(teamIndex, visual, targetIndex); }
  ensureCar(carIndex: number, teamIndex: number | null = null, visual: VehicleVisualInput = this.carVisual) { return this.vehicleRegistry.ensureCar(carIndex, teamIndex, visual); }
  setCarTeam(carIndex: number, teamIndex: number) { return this.vehicleRegistry.setCarTeam(carIndex, teamIndex); }
  get carTeams() { return this.vehicleRegistry.carTeams; }
  swapCarVisual(carIndex: number, newVisual: VehicleVisualInput) { return this.vehicleRegistry.swapCarVisual(carIndex, newVisual); }
  refreshCustomVehicle(vehicleId?: string) { return this.vehicleRegistry.refreshCustomVehicle?.(vehicleId); }
  removeCar(carIndex: number) { return this.vehicleRegistry.removeCar(carIndex); }
  setCarHitboxesVisible(visible: boolean, allVisible?: boolean) {
    this.vehicleRegistry.setCarHitboxesVisible(visible, allVisible, this.playerCarIndex ?? 0);
  }
  setCarGhostOpacity(carIndex: number, isGhost = true, opacity = 0.7) { return this.vehicleRegistry.setCarGhostOpacity(carIndex, isGhost, opacity); }
  clearAllGhostOpacities() { this.vehicleRegistry.clearAllGhostOpacities(); }
  prepareBallSpeedTrail(camera: THREE.Camera | null | undefined) {
    this.ballSpeedTrail?.prepare(camera);
    this.supersonicWheelTrailSystem?.prepare(camera, this);
  }

  addPads(padDefs: BoostPadDefinition[]) {
    this.boostPadSystem.addPads(padDefs, this.padTemplates, this.scene);
    this.pads = this.boostPadSystem.pads;
    this.markRenderTreeChanged();
  }

  updateExperimentalWallConfig(patch: Partial<ExperimentalWallFxConfig>) {
    setExperimentalWallFxRuntimeConfig(patch);
    this.driftwoodsManager?.updateExperimentalWallConfig?.(patch);
  }

  updateSkyboxConfig(patch: Partial<SkyboxConfig>) {
    updateSkyboxConfig(patch);
    if (patch && typeof patch.enabled === 'boolean' && this.sky) {
      this.sky.visible = Boolean(patch.enabled);
    }
  }

  updateShadowConfig(patch: Partial<ShadowConfig>, renderer: THREE.WebGLRenderer | null = null) {
    updateShadowRuntimeConfig(patch);
    this.lighting?.updateShadowConfig?.(patch, renderer);
    if (patch && typeof patch.carsReceiveShadows === 'boolean' && Array.isArray(this.cars)) {
      const receive = Boolean(patch.carsReceiveShadows);
      for (const carRoot of this.cars) {
        if (!carRoot) continue;
        carRoot.traverse?.((node: TraversableMaterialNode) => {
          if (node.isMesh && node.castShadow) {
            node.receiveShadow = receive;
            if (node.material) {
              for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
                if (m) m.needsUpdate = true;
              }
            }
          }
        });
      }
    }
  }

  updateBallVisualConfig(patch: Partial<BallVisualConfig>) {
    updateBallVisualConfig(patch, this.ball, [this.indicatorRing, this.indicatorHeightRing]);
    this.markRenderTreeChanged();
  }

  updateBoostPadTuner(config: Partial<BoostPadTunerConfig> | null | undefined) { this.boostPadSystem?.updateVisualTuningParams?.(config); }

  updateGoalBarrier(decomposition: GoalBarrierDecomposition | null | undefined, targetGoal: GoalBarrierTargetGoal = 'both', enabled = false, opacity = 0.55) {
    this.goalBarrierVisual?.updateConfig(decomposition, targetGoal, enabled, opacity);
    this.markRenderTreeChanged();
  }

  triggerGoalBarrierImpact(xUu: number, yUu: number, zUu: number) {
    this.goalBarrierVisual?.triggerImpact(xUu, yUu, zUu);
  }

  update(
    prevState: NumericStateBuffer | null,
    currState: NumericStateBuffer | null,
    alpha: number,
    delta = 0,
    throttle = 0,
    controls?: CarControlInput | null,
    opponentControls?: CarControlInput | null,
    activeVisuals = true,
    carControlsResolver: CarControlsResolver | null = null
  ) {
    let actualDelta = delta;
    let actualThrottle = throttle;
    if (actualDelta > 0.1 && actualThrottle > 0 && actualThrottle < 0.05) {
      actualDelta = throttle;
      actualThrottle = delta;
    }

    const header = this._headerView.attach(currState);
    const currBall = this._currBallView.attach(currState);
    const prevBall = this._prevBallView.attach(prevState);
    interpolatePhysicsTransform(this.ball, prevBall, currBall, alpha, undefined, this.pA, this.pB, this.qA, this.qB);
    unrealToThreeCoords(this.ballVelocity, currBall.velX, currBall.velY, currBall.velZ);
    this.ballSpeedTrail?.update(this.ball.position, this.ballVelocity, actualDelta);

    const ballPos = this.ball.position;
    updateBallGoalEffect(this.ball, Boolean(this.isThrowbackStadiumActive), actualDelta);
    this.driftwoodsManager?.updateBallProximity?.(ballPos, this.ballVelocity, actualDelta);
    this.goalBarrierVisual?.update?.(actualDelta);
    this.indicatorRing.position.set(ballPos.x, 2, ballPos.z);
    this.indicatorHeightRing.position.set(ballPos.x, 2, ballPos.z);
    const height = Math.max(0, ballPos.y - this.ballRadius);
    const scale = 0.86 - 0.68 * Math.min(1, height / 1600);
    this.indicatorHeightRing.scale.set(scale, scale, 1);

    const nameTagConfig = getNameTagConfig();
    const vr = this.vehicleRegistry;
    const maxCars = Math.max(this.cars.length, Math.min(8, header.numCars || 0));
    vr.syncCarHitboxesVisibility(this.playerCarIndex ?? 0);
    for (let carIndex = 0; carIndex < maxCars; carIndex++) {
      if (carIndex >= header.numCars) {
        if (this.cars[carIndex]) {
          this.cars[carIndex]!.visible = false;
          this.carDemolitions[carIndex]?.update(actualDelta, false, this.cars[carIndex]!.position, false);
        }
        this.supersonicWheelTrailSystem?.updateCar(carIndex, null, null, null, null, null, actualDelta, false);
        continue;
      }

      const currCar = this._currCarView.attachCar(currState, carIndex);
      const prevCar = this._prevCarView.attachCar(prevState, carIndex);
      if (this.carBoostAmounts && carIndex < this.carBoostAmounts.length) {
        this.carBoostAmounts[carIndex] = currCar.boost;
      }
      if (this.carVerticalVelZUu && carIndex < this.carVerticalVelZUu.length) {
        this.carVerticalVelZUu[carIndex] = currCar.velZ;
      }
      if (this.carAirborneFlipExhausted && carIndex < this.carAirborneFlipExhausted.length) {
        this.carAirborneFlipExhausted[carIndex] =
          !currCar.isOnGround && !currCar.isDemoed && !currCar.hasFlipOrJump ? 1 : 0;
      }
      if (this.aerialClimbTracker && carIndex < this.carAerialClimbStatuses.length) {
        this.carAerialClimbStatuses[carIndex] = this.aerialClimbTracker.stepCar(
          carIndex,
          {
            isOnGround: Boolean(currCar.isOnGround),
            isDemoed: Boolean(currCar.isDemoed),
            isJumping: Boolean(currCar.isJumping),
            isFlipping: Boolean(currCar.isFlipping),
            hasFlipOrJump: Boolean(currCar.hasFlipOrJump),
            jumpTimeSec: Number(currCar.jumpTime) || 0,
            airTimeSinceJumpSec: Number(currCar.airTimeSinceJump) || 0,
            posZUu: Number(currCar.posZ) || 0,
            velZUu: Number(currCar.velZ) || 0,
            fwdZ: Number(currCar.fwdZ) || 0,
          },
          nameTagConfig
        );
      }

      const isZeroedSlot = (currCar.fwdX * currCar.fwdX + currCar.fwdY * currCar.fwdY + currCar.fwdZ * currCar.fwdZ) < 0.01;
      const isParkedInactive = isZeroedSlot || (currCar.posX < -5000 && currCar.posZ < -200);
      if (isParkedInactive) {
        if (this.cars[carIndex]) {
          this.cars[carIndex]!.visible = false;
          this.carDemolitions[carIndex]?.update(actualDelta, false, this.cars[carIndex]!.position, false);
        }
        this.supersonicWheelTrailSystem?.updateCar(carIndex, null, null, null, null, null, actualDelta, false);
        continue;
      }

      if (!this.cars[carIndex] && typeof this.ensureCar === 'function') {
        const defaultTeam = carIndex === 6 ? 0 : (carIndex === 7 ? 1 : (carIndex % 2));
        this.ensureCar(carIndex, defaultTeam, this.carVisual || "fennec");
      }
      if (!this.cars[carIndex]) continue;

      const isLocalCar = carIndex === (this.playerCarIndex ?? 0);
      if (this.isLobbyMode) {
        const isLobbyDiagCar = carIndex === 6 || carIndex === 7;
        if (!isLocalCar && !isLobbyDiagCar) {
          if (this.cars[carIndex]) this.cars[carIndex]!.visible = false;
          this.supersonicWheelTrailSystem?.updateCar(carIndex, null, null, null, null, null, actualDelta, false);
          continue;
        }
      }

      const carControls = typeof carControlsResolver === 'function'
        ? carControlsResolver(carIndex)
        : (carIndex === 0 ? controls : opponentControls);
      const carThrottle = isLocalCar ? actualThrottle : (carControls?.throttle ?? 0);

      const isRespawning = prevCar.isDemoed && !currCar.isDemoed;
      if (isRespawning) {
        this.supersonicWheelTrailSystem?.resetCar(carIndex);
      }
      interpolatePhysicsTransform(
        this.cars[carIndex]!, isRespawning ? currCar : prevCar, currCar, alpha, undefined, this.pA, this.pB, this.qA, this.qB
      );

      const isAlive = !currCar.isDemoed;
      this.carDemolitions[carIndex]?.update(actualDelta, !isAlive, this.cars[carIndex]!.position, activeVisuals);
      this.cars[carIndex]!.visible = isAlive;

      const forwardSpeed = currCar.forwardSpeed ?? 0;
      const isOnGround = Boolean(currCar.isOnGround);
      const isPowersliding = Boolean(carControls?.handbrake);
      updateVehicleBrakeLamps(
        this.cars[carIndex]!, this.vehiclePresets[carIndex]!, forwardSpeed, carThrottle, isOnGround, isPowersliding, actualDelta
      );

      updateCarSuspensionAndSteering(
        this.carWheels[carIndex], vr.carWheelSpecs[carIndex], vr.carSuspension[carIndex],
        vr.wheelSpin[carIndex], currCar, this.vehiclePresets[carIndex]!, actualDelta, carThrottle
      );

      this.supersonicWheelTrailSystem?.updateCar(
        carIndex,
        this.cars[carIndex],
        this.carWheels[carIndex],
        vr.carWheelSpecs[carIndex],
        currCar,
        this.vehiclePresets[carIndex],
        actualDelta,
        activeVisuals,
        isRespawning ? currCar : prevCar,
        alpha
      );
    }

    this.lighting.updateSunIntensities(header.numCars);
    updateSkyboxFrame(actualDelta, this.lighting?._shadowDir);
    this.boostPadSystem?.update(currState as Float32Array | null, undefined, actualDelta, this.camera);
    this.respawnGhostPreview?.update?.(currState, actualDelta);
    updateBoostVisuals(
      this.cars, this.carBoosts, currState, actualThrottle, actualDelta, opponentControls?.throttle ?? 0,
      activeVisuals, controls, opponentControls, this.playerCarIndex, this._headerView, this._currCarView, carControlsResolver
    );
  }

  updateSubjectShadows() {
    this.lighting.updateShadows(this.cars, this.ball, this.camera, {
      isPovCamera: this.isPovCamera,
      cameraMode: this.cameraMode,
      focusedCarIndex: this.focusedCarIndex ?? this.playerCarIndex ?? 0,
    });
  }

  resetBoostPads() {
    this.boostPadSystem?.resetPads?.();
  }

  dispose() {
    this.boostPadSystem?.dispose?.();
    this.ballSpeedTrail?.dispose?.();
    this.ballLocatorArrow?.dispose?.();
    this.goalBarrierVisual?.dispose?.();
    this.goalVolumeHitboxVisual?.dispose?.();
    this.nameTagSystem?.dispose?.();
    this.respawnGhostPreview?.dispose?.();
    this.spatialAudioVisualizer?.dispose?.();
    this.supersonicWheelTrailSystem?.dispose?.();
    this.lighting?.dispose?.();
    this.vehicleRegistry?.dispose?.();
    for (const item of [this.sky, this.indicatorRing, this.indicatorHeightRing]) {
      item?.geometry?.dispose?.();
      disposeMaterialSlot(item?.material);
    }
    for (const obj of [this.ball, this.driftwoodsStadium]) {
      obj?.traverse?.((node: TraversableMaterialNode) => {
        node.geometry?.dispose?.();
        disposeMaterialSlot(node.material);
      });
    }
    if (this.scene) while (this.scene.children?.length > 0) this.scene.remove(this.scene.children[0]);
  }
}
