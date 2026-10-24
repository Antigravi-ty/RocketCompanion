import * as THREE from 'three';
import { BoostPadSystem } from './BoostPadSystem.js';
import { BallLocatorArrow } from './BallLocatorArrow.js';
import { SpeedTrail } from './SpeedTrail.js';
import { registerThemeSubtree } from '../effects/ThemeMaterialPipeline.js';
import { onThemeChange } from '../config/themeConfig.js';
import { ArenaHeaderView, CarStateView, BallStateView } from '../physics/RocketSimStateViews.js';

import { BOT_CAR_INDEX } from './arena/ArenaConstants.js';
import { interpolatePhysicsTransform } from './arena/ArenaMath.js';
import { createStadiumDomeSky, updateSkyboxConfig } from './arena/ArenaSky.js';
import { ArenaLightingManager, updateShadowRuntimeConfig } from './arena/ArenaLighting.js';
import { updateBoostVisuals } from './arena/ArenaVehicleAnimator.js';
import { ArenaVehicleRegistry } from './arena/ArenaVehicleRegistry.js';
import { loadBallAssetInto, loadCarAndPadAssets, loadArenaStadiumMeshes } from './arena/ArenaAssetLoader.js';
import { updateBallVisualConfig } from './BallVisual.js';
import { updateArenaFrame } from './arena/ArenaWorldUpdater.js';
import { StadiumEnvironmentManager } from './stadium/StadiumEnvironmentManager.js';
import { createDriftwoodsManager, setExperimentalWallFxRuntimeConfig } from './stadium/driftwoods/DriftwoodsMaterialManager.js';
import { loadThrowbackStadiumField, loadThrowbackCollisionOverlay } from './stadium/ThrowbackStadiumLoader.js';
import { setVehicleReceiveShadows } from './vehicle/vehiclePaintMaterial.js';
import { GoalBarrierVisual } from './arena/GoalBarrierVisual.js';
import { GoalVolumeHitboxVisual } from './arena/GoalVolumeHitboxVisual.js';

export class ArenaWorld {
  constructor(ballRadius, defaultCarVisual = "fennec") {
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

    this.pA = new THREE.Vector3(); this.pB = new THREE.Vector3();
    this.qA = new THREE.Quaternion(); this.qB = new THREE.Quaternion();

    this.scene.background = new THREE.Color(4679561);
    this.scene.fog = new THREE.Fog(6586005, 15000, 34000);

    const lt = this.lighting = new ArenaLightingManager(this.scene);
    this.carSunTarget = lt.carSunTarget; this.ballSunTarget = lt.ballSunTarget; this.opponentSunTarget = lt.opponentSunTarget;
    this.carSun = lt.carSun; this.ballSun = lt.ballSun; this.shadowFocus = lt.shadowFocus;

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
      r.rotation.x = -Math.PI / 2; r.renderOrder = 2; this.scene.add(r);
    }

    const vr = this.vehicleRegistry = new ArenaVehicleRegistry(this.scene, () => this.markRenderTreeChanged());
    this.cars = vr.cars; this.vehiclePresets = vr.vehiclePresets; this.carVisuals = this.vehiclePresets;
    this.carHitboxes = vr.carHitboxes; this.carSuspension = vr.carSuspension;
    this.carWheels = vr.carWheels; this.carWheelSpecs = vr.carWheelSpecs; this.wheelSpin = vr.wheelSpin;
    this.carBoosts = vr.carBoosts; this.carDemolitions = vr.carDemolitions;

    this.envManager = new StadiumEnvironmentManager(this.scene, () => this.markRenderTreeChanged());
    this.driftwoodsStadium = null;
    this.driftwoodsManager = null;
    this.pendingDriftwoodsConfig = null;
    this.throwbackStadium = null;
    this.throwbackCollisionOverlay = null;
    this.isThrowbackStadiumActive = false;
    this.collisionOverlayRequested = false;

    this._headerView = new ArenaHeaderView();
    this._currCarView = new CarStateView(); this._prevCarView = new CarStateView();
    this._currBallView = new BallStateView(); this._prevBallView = new BallStateView();

    this.markRenderTreeChanged();
    if (typeof onThemeChange === 'function') {
      const weakThis = new WeakRef(this);
      onThemeChange(() => weakThis.deref()?.markRenderTreeChanged());
    }
  }

  get opponentSun() { return this.lighting.opponentSun; } set opponentSun(v) { this.lighting.opponentSun = v; }
  get carHitboxesVisible() { return this.vehicleRegistry.carHitboxesVisible; } set carHitboxesVisible(v) { this.vehicleRegistry.carHitboxesVisible = v; }
  get carColors() { return this.vehicleRegistry.carColors; } set carColors(v) { this.vehicleRegistry.carColors = v; }
  get flatCarAsset() { return this.vehicleRegistry.flatCarAsset; } set flatCarAsset(v) { this.vehicleRegistry.flatCarAsset = v; }
  get stadiumVisible() { return this.envManager.stadiumVisible; } set stadiumVisible(v) { this.envManager.stadiumVisible = v; }
  get driftwoodsStadiumVisible() { return this.envManager.driftwoodsStadiumVisible; } set driftwoodsStadiumVisible(v) { this.envManager.driftwoodsStadiumVisible = v; }

  resetBallTrail() { this.ballSpeedTrail?.reset(); }
  resetCarBoosts(carIndex = null) { this.vehicleRegistry?.resetCarBoosts?.(carIndex); }
  resetAllCarEffects() {
    this.vehicleRegistry?.resetAllCarEffects?.();
    this.ballSpeedTrail?.reset?.();
  }
  get renderTreeVersion() { return this._renderTreeVersion; }
  markRenderTreeChanged() { this._renderTreeVersion++; }

  get boostBloomActive() {
    if (!Array.isArray(this.carBoosts)) return false;
    for (const group of this.carBoosts) {
      if (Array.isArray(group) && group.some(e => e?.bloomActive)) return true;
    }
    return false;
  }

  async loadBall() {
    await loadBallAssetInto(this.ball);
    this.markRenderTreeChanged();
  }

  updateBallLocatorArrow(ballCamActive, carIndex = 0, targetBall = this.ball, targetCar = null) {
    this.ballLocatorArrow?.update(targetCar || this.cars[carIndex] || this.cars[0], targetBall || this.ball, ballCamActive);
  }

  async loadAllAssets(onProgress = null) {
    let completed = 0;
    const step = (name) => {
      completed++;
      if (typeof onProgress === "function") onProgress(completed / 3, name);
    };
    await Promise.all([
      this.loadArena().then(() => step("Stadium Architecture & Boundary")),
      this.loadBall().then(() => step("Ball Geometry")),
      this.loadCarAndPadAssets().then(() => step("Vehicle Models & Boost Pads"))
    ]);
    this.markRenderTreeChanged();
  }

  async loadCarAndPadAssets() {
    this.padTemplates = await loadCarAndPadAssets(this.vehicleRegistry, this.boostPadSystem);
    this.markRenderTreeChanged();
  }

  async loadArena() {
    const meshes = await loadArenaStadiumMeshes();
    if (meshes.driftwoodsStadium) {
      this.driftwoodsStadium = meshes.driftwoodsStadium;
      this.driftwoodsManager = createDriftwoodsManager(this.driftwoodsStadium);
      if (this.pendingDriftwoodsConfig) {
        this.driftwoodsManager.applyConfig(this.pendingDriftwoodsConfig);
      }
      this.envManager.attachDriftwoodsStadium(this.driftwoodsStadium);
    }
    this.markRenderTreeChanged();
  }

  async setThrowbackStadiumActive(enabled, showCollisionOverlay = false) {
    const next = Boolean(enabled);
    this.isThrowbackStadiumActive = next;
    this.goalVolumeHitboxVisual?.setArenaPreset(next);
    if (next) {
      if (!this.throwbackStadium) {
        this.throwbackStadium = await loadThrowbackStadiumField();
      }
      if (this.throwbackStadium && !this.throwbackStadium.parent) {
        this.scene.add(this.throwbackStadium);
      }
      if (this.throwbackStadium) {
        this.throwbackStadium.visible = Boolean(this.stadiumVisible);
      }
      if (this.driftwoodsStadium) {
        this.driftwoodsStadium.visible = false;
      }
      await this.setThrowbackCollisionVisible(showCollisionOverlay);
    } else {
      if (this.throwbackStadium) {
        this.throwbackStadium.visible = false;
      }
      if (this.throwbackCollisionOverlay) {
        this.throwbackCollisionOverlay.visible = false;
      }
      if (this.driftwoodsStadium) {
        this.driftwoodsStadium.visible = Boolean(this.stadiumVisible);
      }
      this.collisionOverlayRequested = Boolean(showCollisionOverlay);
    }
    this.markRenderTreeChanged();
  }

  async setThrowbackCollisionVisible(visible) {
    const next = Boolean(visible);
    this.collisionOverlayRequested = next;
    if (next && this.isThrowbackStadiumActive) {
      if (!this.throwbackCollisionOverlay) {
        this.throwbackCollisionOverlay = await loadThrowbackCollisionOverlay();
      }
      if (this.throwbackCollisionOverlay && !this.throwbackCollisionOverlay.parent) {
        this.scene.add(this.throwbackCollisionOverlay);
      }
    }
    if (this.throwbackCollisionOverlay) {
      this.throwbackCollisionOverlay.visible = Boolean(next && this.isThrowbackStadiumActive);
    }
    this.markRenderTreeChanged();
  }

  updateDriftwoodsTuner(config) {
    if (!config) return;
    this.pendingDriftwoodsConfig = config;
    this.driftwoodsManager?.applyConfig(config);
  }

  setStadiumVisible(visible) {
    this.envManager.setStadiumVisible(visible, this.sky, this.isThrowbackStadiumActive ? this.throwbackStadium : this.driftwoodsStadium);
    if (this.isThrowbackStadiumActive && this.driftwoodsStadium) {
      this.driftwoodsStadium.visible = false;
    }
  }
  setCarColor(carIndex, colorVal) { this.vehicleRegistry.setCarColor(carIndex, colorVal); }
  async ensureOpponent() { await this.vehicleRegistry.ensureOpponent(() => this.lighting.ensureOpponentSun()); }

  async prepareAssets() {
    await Promise.all([
      this.ensureOpponent().then(() => {
        if (this.cars[BOT_CAR_INDEX]) this.cars[BOT_CAR_INDEX].visible = false;
      }),
      preloadRemainingVehicleAssets(this.vehicleRegistry),
      ...this.carBoosts.flatMap(list => Array.isArray(list) ? list.map(e => e?.preload?.()) : [])
    ]);
  }

  addCar(teamIndex, visual = this.carVisual, targetIndex = null) { return this.vehicleRegistry.addCar(teamIndex, visual, targetIndex); }
  ensureCar(carIndex, teamIndex = null, visual = this.carVisual) { return this.vehicleRegistry.ensureCar(carIndex, teamIndex, visual); }
  setCarTeam(carIndex, teamIndex) { return this.vehicleRegistry.setCarTeam(carIndex, teamIndex); }
  get carTeams() { return this.vehicleRegistry.carTeams; }
  swapCarVisual(carIndex, newVisual) { return this.vehicleRegistry.swapCarVisual(carIndex, newVisual); }
  refreshCustomVehicle(vehicleId) { return this.vehicleRegistry.refreshCustomVehicle?.(vehicleId); }
  removeCar(carIndex) { return this.vehicleRegistry.removeCar(carIndex); }
  setCarHitboxesVisible(visible) { this.vehicleRegistry.setCarHitboxesVisible(visible); }
  prepareBallSpeedTrail(camera) { this.ballSpeedTrail?.prepare(camera); }

  addPads(padDefs) {
    this.boostPadSystem.addPads(padDefs, this.padTemplates, this.scene);
    this.pads = this.boostPadSystem.pads;
    this.markRenderTreeChanged();
  }

  updateExperimentalWallConfig(patch) {
    setExperimentalWallFxRuntimeConfig(patch);
    this.driftwoodsManager?.updateExperimentalWallConfig?.(patch);
  }

  updateSkyboxConfig(patch) {
    updateSkyboxConfig(patch);
    if (patch && typeof patch.enabled === 'boolean' && this.sky) {
      this.sky.visible = Boolean(patch.enabled);
    }
  }

  updateShadowConfig(patch, renderer = null) {
    updateShadowRuntimeConfig(patch);
    this.lighting?.updateShadowConfig?.(patch, renderer);
    if (patch && typeof patch.carsReceiveShadows === 'boolean' && Array.isArray(this.cars)) {
      const receive = Boolean(patch.carsReceiveShadows);
      for (const carRoot of this.cars) {
        if (!carRoot) continue;
        carRoot.traverse?.((node) => {
          if (node.isMesh && node.castShadow) {
            node.receiveShadow = receive;
            if (node.material) {
              const mats = Array.isArray(node.material) ? node.material : [node.material];
              for (const m of mats) {
                if (m) m.needsUpdate = true;
              }
            }
          }
        });
      }
    }
  }

  updateBallVisualConfig(patch) {
    updateBallVisualConfig(patch, this.ball, [this.indicatorRing, this.indicatorHeightRing]);
    this.markRenderTreeChanged();
  }

  updateBoostPadTuner(config) { this.boostPadSystem?.updateVisualTuningParams?.(config); }

  updateGoalBarrier(decomposition, targetGoal = 'both', enabled = false, opacity = 0.55) {
    this.goalBarrierVisual?.updateConfig(decomposition, targetGoal, enabled, opacity);
    this.markRenderTreeChanged();
  }

  triggerGoalBarrierImpact(xUu, yUu, zUu) {
    this.goalBarrierVisual?.triggerImpact(xUu, yUu, zUu);
  }

  update(prevState, currState, alpha, delta = 0, throttle = 0, controls, opponentControls, activeVisuals = true, carControlsResolver = null) {
    updateArenaFrame(this, prevState, currState, alpha, delta, throttle, controls, opponentControls, activeVisuals, carControlsResolver);
  }

  makeSubjectSun(targetGroup, frustumSize) { return this.lighting.makeSubjectSun(targetGroup, frustumSize); }
  updateSubjectShadows() { this.lighting.updateShadows(this.cars, this.ball, this.camera); }
  updateSubjectShadow(sun, targetGroup, worldPos, frustumSize = 260) { this.lighting.updateSubjectShadow(sun, targetGroup, worldPos, frustumSize); }
  updateBoostVisuals(currState, throttle, delta, oppThrottle = 0, active = true, ctrl = null, oppCtrl = null, carControlsResolver = null) {
    updateBoostVisuals(this.cars, this.carBoosts, currState, throttle, delta, oppThrottle, active, ctrl, oppCtrl, this.playerCarIndex, this._headerView, this._currCarView, carControlsResolver);
  }

  applyPhys(targetMesh, prevViewOrState, currViewOrState, offsetOrAlpha, alphaParam) {
    interpolatePhysicsTransform(targetMesh, prevViewOrState, currViewOrState, offsetOrAlpha, alphaParam, this.pA, this.pB, this.qA, this.qB);
  }

  dispose() {
    this.boostPadSystem?.dispose?.();
    this.ballSpeedTrail?.dispose?.();
    this.ballLocatorArrow?.dispose?.();
    this.goalBarrierVisual?.dispose?.();
    this.goalVolumeHitboxVisual?.dispose?.();
    this.nameTagSystem?.dispose?.();
    this.lighting?.dispose?.();
    this.vehicleRegistry?.dispose?.();
    for (const item of [this.sky, this.indicatorRing, this.indicatorHeightRing]) {
      item?.geometry?.dispose?.(); item?.material?.dispose?.();
    }
    for (const obj of [this.ball, this.driftwoodsStadium]) {
      obj?.traverse?.(n => {
        n.geometry?.dispose?.();
        if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => m?.dispose?.());
      });
    }
    if (this.scene) while (this.scene.children?.length > 0) this.scene.remove(this.scene.children[0]);
  }
}

export {
  ARENA_WIDTH, ARENA_LENGTH, ARENA_GOAL_DEPTH,
  TEAM_BLUE_HEX, TEAM_ORANGE_HEX, DEFAULT_TEAM_COLORS,
  OCTANE_BOOST_OUTLETS, OCTANE_HITBOX_PRESET,
  BUFFER_OFFSETS, CAR_STATE_OFFSETS, CAR_STATE_STRIDE,
  BOOST_PAD_OFFSET, WHEEL_STATE_STRIDE, BOT_CAR_INDEX, resolveAssetPath
} from './arena/ArenaConstants.js';

export {
  unrealToThreeCoords, viewBasisToQuaternion, bufferBasisToQuaternion,
  unpackBufferQuaternion, createCarHitboxWireframe
} from './arena/ArenaMath.js';

export { createStadiumDomeSky, updateSkyboxConfig, getSkyboxConfig, DEFAULT_SKYBOX_CONFIG } from './arena/ArenaSky.js';

export {
  loadDriftwoodsStadium,
  alignWoodsFieldGroundTexture
} from './stadium/driftwoods/DriftwoodsStadiumLoader.js';

export {
  DEFAULT_WHEEL_SPECS, updateSuspensionArm, updateSuspensionUnitSpring,
  updateCarSuspensionAndSteering
} from './VehicleSuspensionSystem.js';
