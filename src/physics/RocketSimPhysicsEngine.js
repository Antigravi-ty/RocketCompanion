/**
 * RocketSimPhysicsEngine.js
 * Clean, modern wrapper for RocketSim WebAssembly simulation core (core.wasm).
 */

import { loadRocketSimWasmModule } from './RocketSimWasm.js';
import {
  PLAYER_CAR_INDEX, BOT_CAR_INDEX, getTeamAssignment, getHitboxIndex,
  fetchArenaCollisionMeshes, initWasmCollisionMeshes
} from './RocketSimMeshLoader.js';
import {
  SIM_OFFSETS, EXTENDED_STATE_OFFSETS, BALL_CONTROL_MODES, BALL_STATE_STRIDE,
  CAR_STATE_STRIDE, BOOST_PAD_STATES_OFFSET, BOOST_PAD_STATE_STRIDE,
  NUM_BOOST_PADS, PHYSICS_EVENT_TYPES, PHYSICS_EVENT_FLAGS, EVENT_TOTAL_BUFFER_BYTES,
  BALL_COLLISION_RADIUS, STANDARD_GOAL_VOLUME_BOX, THROWBACK_GOAL_VOLUME_BOX
} from './RocketSimConstants.js';
import {
  CarStateView, BallStateView, ArenaHeaderView, BoostPadStateView, GameStateView
} from './RocketSimStateViews.js';
import { PhysicsEventReader } from './PhysicsEventReader.js';
import {
  writeCarControlsToEngine, readPhysicsEvents, applyBallStateToEngine, applyCarStateToEngine,
  ensureWasmSnapshotBuffer, saveWasmSnapshotState, saveCompactStateSnapshot, restoreWasmSnapshotState,
  setCarTeamInWasm, readArenaPads
} from './RocketSimSnapshotHelper.js';
import { isPointInGoalBarrier } from '../config/goalBarrierConfig.ts';
import {
  getGoalVolumeBoxForPreset,
  registerGoalVolumeTunerApplier
} from '../config/goalVolumeTunerConfig.js';

export {
  PLAYER_CAR_INDEX, BOT_CAR_INDEX, getTeamAssignment, getHitboxIndex,
  STANDARD_GOAL_VOLUME_BOX, THROWBACK_GOAL_VOLUME_BOX
};

export class RocketSimPhysicsEngine {
  static cachedCollisionData = null;

  constructor() {
    this.module = null;
    this.statePtr = 0;
    this.stateLen = 0;
    this.controlsPtr = 0;
    this.eventBufferPtr = 0;
    this.eventBufferSize = 0;
    this.eventReader = null;
    this.stateView = null;
    this.controlsView = null;
    this.headerViewInstance = null;
    this.gameStateViewInstance = null;
    this.ballStateViewInstance = null;
    this.carStateViewInstances = [];
    this.boostPadStateViewInstances = [];
    this.wasmStatePtr = 0;
    this.wasmStateSize = 0;
    this.cachedSnapshotBuffer = null;
    this.isUnlimitedBoost = false;
    this.baseCollisionData = null;
    this.goalBarrierChunks = [];
    this.goalBarrierMeta = null;
    this.arenaPreset = 0;
    this.goalVolumeBox = getGoalVolumeBoxForPreset(false);
    this._carSpecs = [];
    this._accumulatedBluePossessionPts = 0;
    this._accumulatedOrangePossessionPts = 0;
    this._lastRawBluePossessionPts = 0;
    this._lastRawOrangePossessionPts = 0;

    const weakThis = new WeakRef(this);
    registerGoalVolumeTunerApplier(() => {
      const self = weakThis.deref();
      if (!self) return;
      self.goalVolumeBox = getGoalVolumeBoxForPreset(self.arenaPreset === 1);
      self._syncGoalVolumeBoxToWasm();
    });
  }

  get state() {
    const buffer = this.module.HEAPF32.buffer;
    if (!this.stateView || this.stateView.buffer !== buffer) {
      this.stateView = new Float32Array(buffer, this.statePtr, this.stateLen);
    }
    return this.stateView;
  }

  async init(options = {}) {
    if (options.collisionData) {
      RocketSimPhysicsEngine.cachedCollisionData = options.collisionData;
    }
    this.module = await loadRocketSimWasmModule(options);
    this.isInitialized = true;

    const collisionData = await fetchArenaCollisionMeshes(RocketSimPhysicsEngine.cachedCollisionData);
    RocketSimPhysicsEngine.cachedCollisionData = collisionData;
    this.baseCollisionData = collisionData;
    const effectiveChunks = this.goalBarrierChunks.length > 0
      ? [...collisionData, ...this.goalBarrierChunks]
      : collisionData;
    initWasmCollisionMeshes(this.module, effectiveChunks);

    if (this.module._physics_createArena() !== 1) throw new Error('Arena creation failed');
    this._syncGoalVolumeBoxToWasm();
    this._carSpecs = [];

    this.statePtr = this.module._physics_getStatePtr();
    this.stateLen = this.module._physics_getStateSize();
    this.controlsPtr = this.module._physics_getControlsPtr();

    if (typeof this.module._physics_getEventBufferPtr === 'function') {
      this.eventBufferPtr = this.module._physics_getEventBufferPtr();
      this.eventBufferSize = this.module._physics_getEventBufferSize?.() ?? EVENT_TOTAL_BUFFER_BYTES;
      this.eventReader = new PhysicsEventReader(this.module, this.eventBufferPtr);
    } else {
      this.eventReader = null;
    }

    this.stateView = null;
    this.controlsView = null;
    this.initReplayBuffer();
    if (this.eventReader && this.module?.HEAPU8?.buffer) {
      this.eventReader.attach(this.module, this.eventBufferPtr);
    }
  }

  getEventBufferPtr() {
    return this.eventBufferPtr || (this.module?._physics_getEventBufferPtr?.() ?? 0);
  }

  getEventBufferSize() {
    return this.eventBufferSize || (this.module?._physics_getEventBufferSize?.() ?? EVENT_TOTAL_BUFFER_BYTES);
  }

  clearEvents() {
    this.module?._physics_clearEvents?.();
    if (this.eventReader && this.module?.HEAPU8?.buffer && this.eventReader.buffer !== this.module.HEAPU8.buffer) {
      this.eventReader.attach(this.module, this.eventBufferPtr);
    }
    this.eventReader?.reset();
    this.syntheticFallback?.reset();
  }

  setImpactThresholds(ballGround = 140.0, ballWall = 160.0, carBall = 50.0, cooldownTicks = 8) {
    this.module?._physics_setImpactThresholds?.(ballGround, ballWall, carBall, cooldownTicks);
  }

  setSurfaceTaxonomyThresholds(floorNz = 0.8, netNz = 0.05) {
    this.floorNz = floorNz;
    this.netNz = netNz;
    this.module?._physics_setSurfaceTaxonomyThresholds?.(floorNz, netNz);
  }

  setDirectionDotThreshold(minDirDot = 0.0) {
    this.minDirDot = minDirDot;
    this.module?._physics_setDirectionDotThreshold?.(minDirDot);
  }

  getSurfaceTaxonomyThresholds() {
    return { floorNz: this.floorNz ?? 0.8, netNz: this.netNz ?? 0.05 };
  }

  getDirectionDotThreshold() {
    return this.minDirDot ?? 0.0;
  }

  updateBallPrediction(maxSeconds = 5.0) {
    if (typeof this.module?._physics_updateBallPrediction === 'function') {
      this.module._physics_updateBallPrediction(maxSeconds);
      return this.module._physics_getBallPredictionCount?.() ?? 0;
    }
    return 0;
  }

  getBallPrediction() {
    const ptr = this.module?._physics_getBallPredictionPtr?.() || 0;
    const count = this.module?._physics_getBallPredictionCount?.() || 0;
    return (ptr && count > 0) ? new Float32Array(this.module.HEAPF32.buffer, ptr, count * 6) : null;
  }

  isBallSleeping() {
    if (typeof this.module?._physics_isBallSleeping === 'function') {
      return this.module._physics_isBallSleeping() !== 0;
    }
    const bv = this.getBallStateView();
    return (bv.velX === 0 && bv.velY === 0 && bv.velZ === 0);
  }

  setSimulationFrozen(frozen, targetResumeTick = 0, maskInputs = false) {
    this.module?._physics_setSimulationFrozen?.(frozen ? 1 : 0, targetResumeTick, maskInputs ? 1 : 0);
  }

  setPossessionReportingEnabled(enabled) {
    this.module?._physics_setPossessionReportingEnabled?.(enabled ? 1 : 0);
  }

  resetPossessionStats() {
    this._accumulatedBluePossessionPts = 0;
    this._accumulatedOrangePossessionPts = 0;
    this._lastRawBluePossessionPts = 0;
    this._lastRawOrangePossessionPts = 0;
    if (this.module && this.state && this.state.length >= 416) {
      this.state[EXTENDED_STATE_OFFSETS.POSSESSION_STATE] = 0;
      this.state[EXTENDED_STATE_OFFSETS.POSSESSION_BLUE_POINTS] = 0;
      this.state[EXTENDED_STATE_OFFSETS.POSSESSION_ORANGE_POINTS] = 0;
      this.state[EXTENDED_STATE_OFFSETS.POSSESSION_DURATION] = 0;
    }
  }

  _applyAccumulatedPossessionToState() {
    if (!this.module || !this.state || this.state.length < 416) return;
    const rawBlue = Math.max(0, Math.round(this.state[EXTENDED_STATE_OFFSETS.POSSESSION_BLUE_POINTS] || 0));
    const rawOrange = Math.max(0, Math.round(this.state[EXTENDED_STATE_OFFSETS.POSSESSION_ORANGE_POINTS] || 0));
    this._lastRawBluePossessionPts = rawBlue;
    this._lastRawOrangePossessionPts = rawOrange;
    if (this._accumulatedBluePossessionPts > 0) {
      this.state[EXTENDED_STATE_OFFSETS.POSSESSION_BLUE_POINTS] = rawBlue + this._accumulatedBluePossessionPts;
    }
    if (this._accumulatedOrangePossessionPts > 0) {
      this.state[EXTENDED_STATE_OFFSETS.POSSESSION_ORANGE_POINTS] = rawOrange + this._accumulatedOrangePossessionPts;
    }
  }

  getPossessionStats() {
    if (this.state && this.state.length >= 416) {
      return {
        team: Math.round(this.state[EXTENDED_STATE_OFFSETS.POSSESSION_STATE]),
        bluePoints: Math.round(this.state[EXTENDED_STATE_OFFSETS.POSSESSION_BLUE_POINTS]),
        orangePoints: Math.round(this.state[EXTENDED_STATE_OFFSETS.POSSESSION_ORANGE_POINTS]),
        time: this.state[EXTENDED_STATE_OFFSETS.POSSESSION_DURATION]
      };
    }
    return { team: 0, bluePoints: 0, orangePoints: 0, time: 0 };
  }

  pushSignalEvent(type, tick, x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, primaryId = 0, secondaryId = 0, subType = 0, flags = 0, customFloat = 0, customInt = 0) {
    this.module?._physics_pushSignalEvent?.(type, tick, x, y, z, nx, ny, nz, primaryId, secondaryId, subType, flags, customFloat, customInt);
  }

  resetGoalLatch() { this.module?._physics_resetGoalLatch?.(); }
  getPlayerInputBufferAmount(carIndex = 0) { return this.inputBufferCount?.[carIndex] || 0; }
  readEvents(callback) { return readPhysicsEvents(this, callback); }
  addCar(team, hitboxType = 'default') {
    const hitboxIdx = getHitboxIndex(hitboxType);
    const idx = this.module._physics_addCar(team, hitboxIdx);
    if (idx >= 0) {
      this._carSpecs[idx] = { team: team ? 1 : 0, hitboxIndex: hitboxIdx, threeWheels: false };
    }
    return idx;
  }

  removeCar(carIndex) {
    const ok = this.module?._physics_removeCar?.(carIndex) === 1;
    if (ok && carIndex >= 0 && carIndex < this._carSpecs.length) {
      this._carSpecs.splice(carIndex, 1);
    }
    return ok;
  }

  setCarHitbox(carIndex, hitboxType) {
    const hitboxIdx = getHitboxIndex(hitboxType);
    const ok = this.module?._physics_setCarHitbox?.(carIndex, hitboxIdx) === 1;
    if (ok && this._carSpecs[carIndex]) {
      this._carSpecs[carIndex].hitboxIndex = hitboxIdx;
    }
    return ok;
  }

  setCarTeam(carIndex, team) {
    const ok = setCarTeamInWasm(this, carIndex, team);
    if (ok && this._carSpecs[carIndex]) {
      this._carSpecs[carIndex].team = team ? 1 : 0;
    }
    return ok;
  }

  demolishCar(carIndex, respawnDelay = 3.0) { return this.module?._physics_demolishCar?.(carIndex, respawnDelay) === 1; }
  respawnCar(carIndex, seed = -1, boostAmount = 33.33) { return this.module?._physics_respawnCar?.(carIndex, seed, boostAmount) === 1; }

  getCarIsJumping(carIndex = 0) {
    return typeof this.module?._physics_getCarIsJumping === 'function'
      ? this.module._physics_getCarIsJumping(carIndex) === 1
      : this.getCarStateView(carIndex).isJumping;
  }

  getCarAirTime(carIndex = 0) {
    return typeof this.module?._physics_getCarAirTime === 'function'
      ? this.module._physics_getCarAirTime(carIndex)
      : this.getCarStateView(carIndex).airTime;
  }

  getCarJumpTime(carIndex = 0) {
    return typeof this.module?._physics_getCarJumpTime === 'function'
      ? this.module._physics_getCarJumpTime(carIndex)
      : this.getCarStateView(carIndex).jumpTime;
  }

  getCarAirTimeSinceJump(carIndex = 0) {
    return typeof this.module?._physics_getCarAirTimeSinceJump === 'function'
      ? this.module._physics_getCarAirTimeSinceJump(carIndex)
      : this.getCarStateView(carIndex).airTimeSinceJump;
  }

  resetKickoffAtSpawn(spawnIndex = 0, settleTicks = 30) {
    const ok = this.module?._physics_resetKickoffAtSpawn?.(spawnIndex, settleTicks) === 1;
    this.clearEvents();
    return ok;
  }

  setCarLinearFactorAndGravity(carIndex, fx = 1.0, fy = 1.0, fz = 1.0, gravityScale = 1.0) {
    return this.module?._physics_setCarLinearFactorAndGravity?.(carIndex, fx, fy, fz, gravityScale) === 1;
  }

  setCarCollisionMask(carIndex, interactWithBall = true, interactWithCars = true) {
    return this.module?._physics_setCarCollisionMask?.(carIndex, interactWithBall ? 1 : 0, interactWithCars ? 1 : 0) === 1;
  }

  setCarThreeWheels(carIndex = 0, enabled = true) {
    const ok = this.module?._physics_setCarThreeWheels?.(carIndex, enabled ? 1 : 0) === 1;
    if (ok && this._carSpecs[carIndex]) {
      this._carSpecs[carIndex].threeWheels = Boolean(enabled);
    }
    return ok;
  }

  getCarThreeWheels(carIndex = 0) {
    return this.module?._physics_getCarThreeWheels?.(carIndex) === 1;
  }

  setArenaPreset(presetIndex = 0) {
    this.arenaPreset = presetIndex === 1 ? 1 : 0;
    this.goalVolumeBox = getGoalVolumeBoxForPreset(this.arenaPreset === 1);
    this.module?._physics_setArenaPreset?.(this.arenaPreset);
    this._syncGoalVolumeBoxToWasm();
  }

  getArenaPreset() {
    return this.module?._physics_getArenaPreset?.() ?? this.arenaPreset ?? 0;
  }

  _syncGoalVolumeBoxToWasm() {
    if (!this.module?._physics_setGoalVolumeBox) return;
    const box = this.goalVolumeBox || getGoalVolumeBoxForPreset(this.arenaPreset === 1);
    const enabled = this.arenaPreset === 1 || Boolean(box.enabled);
    this.module._physics_setGoalVolumeBox(
      enabled ? 1 : 0,
      box.halfWidthX,
      box.minY,
      box.maxY,
      box.maxZ
    );
  }

  getGoalVolumeConfig() {
    const preset = this.getArenaPreset();
    const box = this.goalVolumeBox || getGoalVolumeBoxForPreset(preset === 1);
    return {
      isThrowback: preset === 1,
      enabled: preset === 1 || Boolean(box.enabled),
      halfWidthX: box.halfWidthX,
      minY: box.minY,
      maxY: box.maxY,
      minZ: box.minZ ?? 0.0,
      maxZ: box.maxZ,
      ballRadius: BALL_COLLISION_RADIUS
    };
  }

  isBallScored(ballView = this.getBallStateView()) {
    if (!ballView) return false;
    const x = ballView.posX;
    const y = ballView.posY;
    const z = ballView.posZ;
    if (this.hasActiveGoalBarrier(y)) return false;

    const absY = Math.abs(y);
    const r = BALL_COLLISION_RADIUS;
    const cfg = this.getGoalVolumeConfig();

    if (cfg.enabled) {
      const margin = 0.25 * r;
      if (Math.abs(x) >= cfg.halfWidthX - margin) return false;
      if (z <= cfg.minZ || z >= cfg.maxZ - margin) return false;
      return absY > cfg.minY + r && absY < cfg.maxY;
    }

    return absY > cfg.minY + r;
  }

  async reloadMeshes(manifestPath = '/arenamesh/manifest.json') {
    if (!this.module) return false;
    const baseDir = manifestPath.replace(/\/[^/]+$/, '') || '/arenamesh';
    const collisionData = await fetchArenaCollisionMeshes(null, { manifestPath, baseDir });
    this.baseCollisionData = collisionData;
    const effectiveChunks = this.goalBarrierChunks.length > 0
      ? [...collisionData, ...this.goalBarrierChunks]
      : collisionData;
    initWasmCollisionMeshes(this.module, effectiveChunks);
    return true;
  }

  setGoalBarrierChunks(barrierChunks = [], barrierMeta = null) {
    this.goalBarrierChunks = Array.isArray(barrierChunks) ? barrierChunks : [];
    this.goalBarrierMeta = barrierMeta;
    if (!this.module || !this.isInitialized) return false;
    const baseData = this.baseCollisionData || RocketSimPhysicsEngine.cachedCollisionData;
    if (!baseData || baseData.length === 0) return false;

    const currentTick = Math.floor(this.getHeaderView?.()?.tickCount ?? 0);
    const snap = this.saveState();
    const savedSpecs = this._carSpecs.map((spec) => ({ ...spec }));
    const savedNumCars = Math.max(savedSpecs.length, this.numCars || 0);
    const savedUnlimited = this.isUnlimitedBoost;
    const savedPreset = this.getArenaPreset();

    const effectiveChunks = this.goalBarrierChunks.length > 0
      ? [...baseData, ...this.goalBarrierChunks]
      : baseData;
    initWasmCollisionMeshes(this.module, effectiveChunks);
    this.setArenaPreset(savedPreset);
    if (this.module._physics_createArena() !== 1) return false;
    this._syncGoalVolumeBoxToWasm();

    this._carSpecs = [];
    for (let i = 0; i < savedNumCars; i++) {
      const spec = savedSpecs[i] || { team: i % 2, hitboxIndex: 0, threeWheels: false };
      this.addCar(spec.team, spec.hitboxIndex);
      if (spec.threeWheels) {
        this.setCarThreeWheels(i, true);
      }
    }
    this.setUnlimitedBoost(savedUnlimited);
    if (snap) {
      this.restoreState(snap);
    }
    if (this.state && currentTick > 0) {
      this.state[SIM_OFFSETS.TICK] = currentTick;
    }
    this.stateView = null;
    this.controlsView = null;
    return true;
  }

  isPointOnGoalBarrier(xUu, yUu, zUu) {
    if (!this.goalBarrierMeta || !this.goalBarrierMeta.enabled) return false;
    const rects = this.goalBarrierMeta.rects || this.goalBarrierMeta.decomposition?.mergedRects;
    return isPointInGoalBarrier(
      xUu,
      yUu,
      zUu,
      rects,
      this.goalBarrierMeta.targetGoal,
      this.goalBarrierMeta.enabled
    );
  }

  hasActiveGoalBarrier(yUu = 0) {
    if (!this.goalBarrierMeta || !this.goalBarrierMeta.enabled) return false;
    const rects = this.goalBarrierMeta.rects || this.goalBarrierMeta.decomposition?.mergedRects;
    if (!Array.isArray(rects) || rects.length === 0) return false;
    const tg = this.goalBarrierMeta.targetGoal || 'both';
    if (tg === 'orange' && yUu < 0) return false;
    if (tg === 'blue' && yUu > 0) return false;
    return true;
  }

  setGoalVolumeBox(
    enabled = true,
    halfWidthX = THROWBACK_GOAL_VOLUME_BOX.halfWidthX,
    minY = THROWBACK_GOAL_VOLUME_BOX.minY,
    maxY = THROWBACK_GOAL_VOLUME_BOX.maxY,
    maxZ = THROWBACK_GOAL_VOLUME_BOX.maxZ
  ) {
    this.goalVolumeBox = {
      enabled: Boolean(enabled),
      halfWidthX,
      minY,
      maxY,
      minZ: 0.0,
      maxZ
    };
    this.module?._physics_setGoalVolumeBox?.(enabled ? 1 : 0, halfWidthX, minY, maxY, maxZ);
  }

  setArenaMutators({ gravityZ = -650.0, boostAccelGround = -1.0, boostAccelAir = -1.0, ballMaxSpeed = -1.0, ballBounciness = -1.0 } = {}) {
    return this.module?._physics_setArenaMutators?.(gravityZ, boostAccelGround, boostAccelAir, ballMaxSpeed, ballBounciness) === 1;
  }

  initReplayBuffer() { this.module?._physics_initReplayBuffer?.(); }
  clearReplayBuffer() { this.module?._physics_clearReplayBuffer?.(); }
  recordReplayFrame() { this.module?._physics_recordReplayFrame?.(); }
  getReplayFrameCount() { return this.module?._physics_getReplayFrameCount?.() ?? 0; }
  setReplayRecordingActive(active = true) { this.module?._physics_setReplayRecordingActive?.(active ? 1 : 0); }
  getReplayRecordingActive() { return (this.module?._physics_getReplayRecordingActive?.() ?? 1) === 1; }
  getReplayStateStride() { return this.module?._physics_getReplayStateStride?.() ?? 1856; }
  getReplayIncidentCount() { return this.module?._physics_getReplayIncidentCount?.() ?? 0; }
  getReplaySignalCount() { return this.module?._physics_getReplaySignalCount?.() ?? 0; }

  getReplayFrameByOffset(ticksAgo = 0) {
    const ptr = this.module?._physics_getReplayFramePtrByOffset?.(ticksAgo) || 0;
    return ptr ? new Float32Array(this.module.HEAPF32.buffer, ptr, this.stateLen) : null;
  }

  getReplayFrameByIndex(frameIndex = 0) {
    const ptr = this.module?._physics_getReplayFramePtrByIndex?.(frameIndex) || 0;
    return ptr ? new Float32Array(this.module.HEAPF32.buffer, ptr, this.stateLen) : null;
  }

  getReplayControlsByIndex(frameIndex = 0) {
    const ptr = this.module?._physics_getReplayControlsPtrByIndex?.(frameIndex) || 0;
    return ptr ? new Uint8Array(this.module.HEAPU8.buffer, ptr, 64) : null;
  }

  getReplayStateTrackBytes() {
    const ptr = this.module?._physics_getReplayStateTrackPtr?.() || 0;
    const count = this.getReplayFrameCount();
    const stride = this.getReplayStateStride();
    if (!ptr || count <= 0) return new Uint8Array(0);
    return new Uint8Array(this.module.HEAPU8.buffer, ptr, count * stride);
  }

  getReplayIncidentTrackBytes() {
    const ptr = this.module?._physics_getReplayIncidentTrackPtr?.() || 0;
    const count = this.getReplayIncidentCount();
    if (!ptr || count <= 0) return new Uint8Array(0);
    return new Uint8Array(this.module.HEAPU8.buffer, ptr, count * 64);
  }

  getReplaySignalTrackBytes() {
    const ptr = this.module?._physics_getReplaySignalTrackPtr?.() || 0;
    const count = this.getReplaySignalCount();
    if (!ptr || count <= 0) return new Uint8Array(0);
    return new Uint8Array(this.module.HEAPU8.buffer, ptr, count * 64);
  }

  extractWasmReplayTracks() {
    const frameCount = this.getReplayFrameCount();
    const incidentCount = this.getReplayIncidentCount();
    const signalCount = this.getReplaySignalCount();
    const stateStride = this.getReplayStateStride();
    const stateView = this.getReplayStateTrackBytes();
    const incidentView = this.getReplayIncidentTrackBytes();
    const signalView = this.getReplaySignalTrackBytes();

    const stateInputBytes = new Uint8Array(stateView.byteLength);
    if (stateView.byteLength > 0) stateInputBytes.set(stateView);

    const incidentBytes = new Uint8Array(incidentView.byteLength);
    if (incidentView.byteLength > 0) incidentBytes.set(incidentView);

    const signalBytes = new Uint8Array(signalView.byteLength);
    if (signalView.byteLength > 0) signalBytes.set(signalView);

    return {
      frameCount,
      stateStride,
      incidentCount,
      signalCount,
      stateInputBytes,
      incidentBytes,
      signalBytes
    };
  }

  configureCars(hitboxType, isMatch, defaultPlayerTeam = 0) {
    const { playerTeam, botTeam } = getTeamAssignment(hitboxType === 'flat');
    if (this.module._physics_createArena() !== 1) throw new Error('Arena creation failed');
    this._syncGoalVolumeBoxToWasm();
    this._carSpecs = [];
    this.clearEvents();
    if (this.addCar(isMatch ? playerTeam : defaultPlayerTeam, hitboxType) !== PLAYER_CAR_INDEX) {
      throw new Error('Player creation failed');
    }
    if (isMatch && this.addCar(botTeam, 'default') !== BOT_CAR_INDEX) {
      throw new Error('Opponent creation failed');
    }
    this.resetKickoff();
  }

  setControls(carIndex, controls) { writeCarControlsToEngine(this, carIndex, controls); }
  setCarControls(carIndex, controls) { writeCarControlsToEngine(this, carIndex, controls); }

  getHeaderView() {
    if (!this.headerViewInstance) this.headerViewInstance = new ArenaHeaderView();
    return this.headerViewInstance.attach(this.state);
  }

  get numCars() { return this.state ? this.getHeaderView().numCars : 0; }
  get ballState() { return this.getBallStateView(); }

  getBallStateView() {
    if (!this.ballStateViewInstance) this.ballStateViewInstance = new BallStateView();
    return this.ballStateViewInstance.attach(this.state);
  }

  getBallState() { return this.state.subarray(SIM_OFFSETS.BALL, SIM_OFFSETS.BALL + BALL_STATE_STRIDE); }
  setBallState(ballState) { return applyBallStateToEngine(this, ballState); }

  getCarStateView(carIndex = 0) {
    if (!this.carStateViewInstances[carIndex]) this.carStateViewInstances[carIndex] = new CarStateView();
    return this.carStateViewInstances[carIndex].attachCar(this.state, carIndex);
  }

  getBoostPadStateView(padIndex = 0) {
    if (!this.boostPadStateViewInstances[padIndex]) this.boostPadStateViewInstances[padIndex] = new BoostPadStateView();
    return this.boostPadStateViewInstances[padIndex].attach(this.state, padIndex);
  }

  getPadStateView(padIndex = 0) { return this.getBoostPadStateView(padIndex); }

  getGameStateView() {
    if (!this.gameStateViewInstance) this.gameStateViewInstance = new GameStateView();
    return this.gameStateViewInstance.attach(this.state);
  }

  getCarState(carIndex) {
    const offset = SIM_OFFSETS.CARS + carIndex * CAR_STATE_STRIDE;
    return this.state.subarray(offset, offset + CAR_STATE_STRIDE);
  }

  setCarState(carIndex, carState) { return applyCarStateToEngine(this, carIndex, carState); }

  getCarConfig(hitboxTypeOrIndex = 'default') {
    const idx = getHitboxIndex(hitboxTypeOrIndex);
    return this.module?._physics_getCarConfig?.(idx) ?? null;
  }

  getPadStates() {
    return this.state.subarray(
      BOOST_PAD_STATES_OFFSET,
      BOOST_PAD_STATES_OFFSET + NUM_BOOST_PADS * BOOST_PAD_STATE_STRIDE
    );
  }

  step(ticks = 1) {
    this.module._physics_step(ticks);
    this._applyAccumulatedPossessionToState();
  }
  stepSilent(ticks = 1) { this.module._physics_stepSilent(ticks); }
  saveStateSlot(slot) { return this.module._physics_saveStateSlot(slot) === 1; }
  restoreStateSlot(slot) { return this.module._physics_restoreStateSlot(slot) === 1; }
  getStateSnapshotSize() { return this.module._physics_getStateSnapshotSize(); }
  _ensureStateBuffer(size) { ensureWasmSnapshotBuffer(this, size); }
  saveState(targetBuffer = null) { return saveWasmSnapshotState(this, targetBuffer); }
  saveCompactState(targetBuffer = null) { return saveCompactStateSnapshot(this, targetBuffer); }
  restoreState(buffer) { return restoreWasmSnapshotState(this, buffer); }

  resetKickoff(seed = -1, preservePossessionScore = true) {
    if (preservePossessionScore && this.state && this.state.length >= 416) {
      this._accumulatedBluePossessionPts = Math.max(
        this._accumulatedBluePossessionPts,
        Math.round(this.state[EXTENDED_STATE_OFFSETS.POSSESSION_BLUE_POINTS] || 0)
      );
      this._accumulatedOrangePossessionPts = Math.max(
        this._accumulatedOrangePossessionPts,
        Math.round(this.state[EXTENDED_STATE_OFFSETS.POSSESSION_ORANGE_POINTS] || 0)
      );
    } else if (!preservePossessionScore) {
      this._accumulatedBluePossessionPts = 0;
      this._accumulatedOrangePossessionPts = 0;
    }
    this.module._physics_resetKickoff(seed);
    this._applyAccumulatedPossessionToState();
    this.clearEvents();
  }

  controlBall(carIndex, mode) {
    if (!this.module || typeof this.module._physics_controlBall !== 'function') return false;
    const modeIndex = typeof mode === 'number' ? mode : BALL_CONTROL_MODES.indexOf(mode);
    if (modeIndex < 0 || modeIndex >= BALL_CONTROL_MODES.length) return false;
    return this.module._physics_controlBall(carIndex, modeIndex) === 1;
  }

  setUnlimitedBoost(unlimited) {
    this.isUnlimitedBoost = !!unlimited;
    this.module._physics_setUnlimitedBoost(unlimited ? 1 : 0);
  }

  pollGoal() {
    const goalFlag = this.getHeaderView().goalScoredFlag;
    if (goalFlag !== 0) this.module._physics_clearGoalFlag();
    return goalFlag;
  }

  get ballRadius() { return this.module._physics_getBallRadius(); }
  get ballOnGround() { return this.module._physics_getBallOnGround() === 1; }
  getPads() { return readArenaPads(this); }

  destroy() {
    if (this.wasmStatePtr && this.module && typeof this.module._free === 'function') {
      this.module._free(this.wasmStatePtr);
      this.wasmStatePtr = 0;
      this.wasmStateSize = 0;
      this.cachedSnapshotBuffer = null;
    }
    this.module = null;
    this.stateView = null;
    this.controlsView = null;
    this.eventReader = null;
    this.headerViewInstance = null;
    this.gameStateViewInstance = null;
    this.ballStateViewInstance = null;
    this.carStateViewInstances = [];
    this.boostPadStateViewInstances = [];
  }
}

export {
  ArenaHeaderView, CarStateView, BallStateView, BoostPadStateView, GameStateView,
  PhysicsEventReader, PHYSICS_EVENT_TYPES, PHYSICS_EVENT_FLAGS, EXTENDED_STATE_OFFSETS,
  loadRocketSimWasmModule
};

export default RocketSimPhysicsEngine;
