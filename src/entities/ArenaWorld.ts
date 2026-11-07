import * as THREE from 'three';
import { BoostPadSystem } from './BoostPadSystem.ts';
import {
  type BoostPadDefinition,
  type BoostPadInstance,
  type BoostPadTemplates,
  type BoostPadTunerConfig,
} from './arena/BoostPadTemplateLoader.ts';
import { BallLocatorArrow } from './BallLocatorArrow.ts';
import { ArenaEnvironmentManager, createBallGroundIndicatorRings } from './arena/ArenaEnvironmentManager.ts';
import { SpeedTrail } from './SpeedTrail.ts';
import { onThemeChange } from '../ui-core/config/themeConfig';
import { ArenaHeaderView, CarStateView, BallStateView, type NumericStateBuffer } from '../physics/RocketSimStateViews.ts';
import { createStadiumDomeSky, updateSkyboxFrame } from './arena/ArenaSky.ts';
import { ArenaLightingManager } from './arena/ArenaLighting.ts';
import {
  ArenaVehicleRegistry,
  type CarLoadoutConfig,
  type VehicleVisualInput,
  type VehicleWheelSet,
} from './arena/ArenaVehicleRegistry.ts';
import {
  stepArenaVehiclesFrame,
  updateBoostVisuals,
  type CarControlInput,
  type CarControlsResolver,
} from './arena/ArenaVehicleFrameStepper.ts';
import {
  loadBallAssetInto,
  loadCarAndPadAssets,
  prepareAllArenaWarmupAssets,
  runParallelArenaAssetSteps,
} from './arena/ArenaAssetLoader.ts';
import { VehicleNameTagSystem } from './arena/VehicleNameTagSystem.ts';
import { VehicleAerialClimbTracker, type CarAerialClimbStatus } from './arena/VehicleAerialClimbTracker.ts';
import type { DriftwoodsMaterialManager } from './stadium/driftwoods/DriftwoodsMaterialManager.ts';
import { GoalBarrierVisual } from './arena/GoalBarrierVisual.ts';
import { GoalVolumeHitboxVisual } from './arena/GoalVolumeHitboxVisual.ts';
import { RespawnGhostPreview } from './arena/RespawnGhostPreview.ts';
import { SpatialAudioDebugVisualizer } from './arena/SpatialAudioDebugVisualizer.ts';
import { SupersonicWheelTrailSystem } from './vehicle/supersonic-trail/SupersonicWheelTrailSystem.ts';
import type { VehicleBoostEmitter } from './vehicle/boost/vehicleBoostEmitter.ts';
import type { DemolitionEffect } from './DemolitionEffect.ts';

export type { BoostPadDefinition, BoostPadInstance, BoostPadTemplates, BoostPadTunerConfig };

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
  public environment: ArenaEnvironmentManager;
  public cars: Array<THREE.Group | null>;
  public vehiclePresets: Array<string | null>;
  public carWheels: Array<VehicleWheelSet | null>;
  public carBoosts: Array<VehicleBoostEmitter[] | null>;
  public carDemolitions: Array<DemolitionEffect | null>;
  public carColors: Array<number | null | undefined>;
  public carTeams: number[];
  public carBoostAmounts: Float32Array;
  public carVerticalVelZUu: Float32Array;
  public carAirborneFlipExhausted: Uint8Array;
  public aerialClimbTracker: VehicleAerialClimbTracker;
  public carAerialClimbStatuses: CarAerialClimbStatus[];
  public nameTagSystem: VehicleNameTagSystem;
  public respawnGhostPreview: RespawnGhostPreview;
  public spatialAudioVisualizer: SpatialAudioDebugVisualizer;
  public supersonicWheelTrailSystem: SupersonicWheelTrailSystem;
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

  constructor(ballRadius: number, defaultCarVisual = 'fennec') {
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

    const rings = createBallGroundIndicatorRings(this.scene, ballRadius);
    this.indicatorRing = rings.indicatorRing;
    this.indicatorHeightRing = rings.indicatorHeightRing;

    const vr = (this.vehicleRegistry = new ArenaVehicleRegistry(
      this.scene,
      () => this.markRenderTreeChanged(),
      () => this.lighting.ensureOpponentSun()
    ));
    this.cars = vr.cars;
    this.vehiclePresets = vr.vehiclePresets;
    this.carWheels = vr.carWheels;
    this.carBoosts = vr.carBoosts;
    this.carDemolitions = vr.carDemolitions;
    this.carColors = vr.carColors;
    this.aerialClimbTracker = new VehicleAerialClimbTracker(8);
    this.carBoostAmounts = this.aerialClimbTracker.carBoostAmounts;
    this.carVerticalVelZUu = this.aerialClimbTracker.carVerticalVelZUu;
    this.carAirborneFlipExhausted = this.aerialClimbTracker.carAirborneFlipExhausted;
    this.carAerialClimbStatuses = this.aerialClimbTracker.carAerialClimbStatuses;
    this.nameTagSystem = new VehicleNameTagSystem(this.scene);
    this.respawnGhostPreview = new RespawnGhostPreview(this);
    this.spatialAudioVisualizer = new SpatialAudioDebugVisualizer(this.scene, () => this.markRenderTreeChanged());
    this.supersonicWheelTrailSystem = new SupersonicWheelTrailSystem(this.scene);
    this.environment = new ArenaEnvironmentManager(this);

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

  get driftwoodsStadium(): THREE.Group | null { return this.environment.driftwoodsStadium; }
  get driftwoodsManager(): DriftwoodsMaterialManager | null { return this.environment.driftwoodsManager; }
  get isThrowbackStadiumActive(): boolean { return this.environment.isThrowbackStadiumActive; }

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
  get boostBloomActive() { return this.vehicleRegistry.hasActiveBoostBloom(); }

  async loadBall() {
    await loadBallAssetInto(this.ball);
    this.markRenderTreeChanged();
  }

  updateBallLocatorArrow(
    ballCamActive: boolean,
    carIndex = 0,
    targetBall: THREE.Object3D | null = this.ball,
    targetCar: THREE.Object3D | null = null
  ) {
    this.ballLocatorArrow?.update(
      targetCar || this.cars[carIndex] || this.cars[0],
      targetBall || this.ball,
      ballCamActive
    );
  }

  async loadAllAssets(onProgress: ((progress: number, name: string) => void) | null = null) {
    await runParallelArenaAssetSteps(
      [
        { label: 'Stadium Architecture & Boundary', run: () => this.environment.loadArena() },
        { label: 'Ball Geometry', run: () => this.loadBall() },
        { label: 'Vehicle Models & Boost Pads', run: () => this.loadCarAndPadAssets() },
      ],
      onProgress
    );
    this.markRenderTreeChanged();
  }

  async loadCarAndPadAssets() {
    this.padTemplates = await loadCarAndPadAssets(
      this.vehicleRegistry,
      this.boostPadSystem,
      this.vehiclePreset
    );
    this.markRenderTreeChanged();
  }

  async prepareAssets(onProgress: ((loaded: number, total: number, label: string) => void) | null = null) {
    await prepareAllArenaWarmupAssets(
      () => this.vehicleRegistry.ensureOpponent(),
      this.vehicleRegistry,
      onProgress
    );
  }

  // Legacy vehicle delegates retained strictly for parallel branch callers outside src/game/runtime/
  setCarColor(carIndex: number, colorVal: string | number | null | undefined) {
    this.vehicleRegistry.setCarColor(carIndex, colorVal);
  }
  setCarLoadout(carIndex: number, loadout: CarLoadoutConfig | null | undefined) {
    this.vehicleRegistry.setCarLoadout?.(carIndex, loadout);
  }
  addCar(teamIndex = 0, visualOrOptions: VehicleVisualInput = this.carVisual, targetIndex: number | null = null) {
    return this.vehicleRegistry.addCar(teamIndex, visualOrOptions, targetIndex);
  }
  removeCar(carIndex: number) {
    return this.vehicleRegistry.removeCar(carIndex);
  }
  async ensureOpponent() {
    await this.vehicleRegistry.ensureOpponent();
  }
  ensureCar(carIndex: number, teamIndex: number | null = null, visual: VehicleVisualInput = this.carVisual) {
    return this.vehicleRegistry.ensureCar(carIndex, teamIndex, visual);
  }
  setCarTeam(carIndex: number, teamIndex: number) {
    return this.vehicleRegistry.setCarTeam(carIndex, teamIndex);
  }
  swapCarVisual(carIndex: number, newVisual: VehicleVisualInput) {
    return this.vehicleRegistry.swapCarVisual(carIndex, newVisual);
  }
  refreshCustomVehicle(vehicleId?: string) {
    return this.vehicleRegistry.refreshCustomVehicle?.(vehicleId);
  }
  clearAllGhostOpacities() {
    this.vehicleRegistry.clearAllGhostOpacities();
  }

  prepareBallSpeedTrail(camera: THREE.Camera | null | undefined) {
    this.ballSpeedTrail?.prepare(camera);
    this.supersonicWheelTrailSystem?.prepare(camera, this);
  }

  addPads(padDefs: BoostPadDefinition[]) {
    this.boostPadSystem.addPads(padDefs, this.padTemplates, this.scene);
    this.pads = this.boostPadSystem.pads;
    this.markRenderTreeChanged();
  }

  updateBoostPadTuner(config: Partial<BoostPadTunerConfig> | null | undefined) {
    this.boostPadSystem?.updateVisualTuningParams?.(config);
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
    this.environment.stepBallAndEnvironmentVisuals(prevState, currState, alpha, actualDelta);

    stepArenaVehiclesFrame(
      this, prevState, currState, header.numCars, alpha, actualDelta, actualThrottle,
      controls, opponentControls, activeVisuals, carControlsResolver
    );

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
    this.environment?.disposeEnvironmentMeshes?.();
  }
}
