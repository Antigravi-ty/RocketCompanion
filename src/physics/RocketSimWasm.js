/**
 * RocketSim WebAssembly Bridge Loader
 * Loads core physics WASM microkernel (core.wasm) located directly in physics module.
 * Provides complete backward compatibility and first-class secondary development support.
 */
import loadDirectRocketSimWasm from './core.js';

let cachedInstance = null;

export async function loadRocketSimWasmModule(moduleArg = {}) {
  const isIsolated = moduleArg.freshInstance || moduleArg.isolated;
  if (cachedInstance && !isIsolated) {
    return cachedInstance;
  }

  const options = { ...moduleArg };
  const userLocateFile = options.locateFile;
  options.locateFile = (path, scriptDirectory) => {
    // Direct physics simulation wasm binary strictly to core.wasm
    const target = 'core.wasm';
    if (userLocateFile) {
      return userLocateFile(target, scriptDirectory);
    }
    return new URL('./' + target, import.meta.url).href;
  };

  const Module = await loadDirectRocketSimWasm(options);

  // Expose semantic physics methods.
  // Note: POV Camera is strictly decoupled into exempt_pov_microkernel (camera.wasm).
  // Core.wasm is strictly dedicated to rigid-body collision and vehicular simulation.

  Module.physics_init = Module.physics_init || Module._physics_init;
  Module.physics_createArena = Module.physics_createArena || Module._physics_createArena;
  Module.physics_step = Module.physics_step || Module._physics_step;
  Module.physics_stepSilent = Module.physics_stepSilent || Module._physics_stepSilent;
  Module.physics_saveStateSlot = Module.physics_saveStateSlot || Module._physics_saveStateSlot;
  Module.physics_restoreStateSlot = Module.physics_restoreStateSlot || Module._physics_restoreStateSlot;
  Module.physics_saveState = Module.physics_saveState || Module._physics_saveState;
  Module.physics_restoreState = Module.physics_restoreState || Module._physics_restoreState;
  Module.physics_getStateSnapshotSize = Module.physics_getStateSnapshotSize || Module._physics_getStateSnapshotSize;
  Module.physics_resetKickoff = Module.physics_resetKickoff || Module._physics_resetKickoff;
  Module.physics_clearGoalFlag = Module.physics_clearGoalFlag || Module._physics_clearGoalFlag;
  Module.physics_controlBall = Module.physics_controlBall || Module._physics_controlBall;
  Module.physics_setUnlimitedBoost = Module.physics_setUnlimitedBoost || Module._physics_setUnlimitedBoost;
  Module.physics_getUnlimitedBoost = Module.physics_getUnlimitedBoost || Module._physics_getUnlimitedBoost;
  Module.physics_setCarUnlimitedBoost = Module.physics_setCarUnlimitedBoost || Module._physics_setCarUnlimitedBoost;
  Module.physics_getCarUnlimitedBoost = Module.physics_getCarUnlimitedBoost || Module._physics_getCarUnlimitedBoost;
  Module.physics_setCarBoostCollectable = Module.physics_setCarBoostCollectable || Module._physics_setCarBoostCollectable;
  Module.physics_getCarBoostCollectable = Module.physics_getCarBoostCollectable || Module._physics_getCarBoostCollectable;
  Module.physics_setCarBoostRecharge = Module.physics_setCarBoostRecharge || Module._physics_setCarBoostRecharge;
  Module.physics_getCarBoostRechargeEnabled = Module.physics_getCarBoostRechargeEnabled || Module._physics_getCarBoostRechargeEnabled;
  Module.physics_getCarBoostRechargePerSecond = Module.physics_getCarBoostRechargePerSecond || Module._physics_getCarBoostRechargePerSecond;
  Module.physics_getCarBoostRechargeDelay = Module.physics_getCarBoostRechargeDelay || Module._physics_getCarBoostRechargeDelay;
  Module.physics_getStatePtr = Module.physics_getStatePtr || Module._physics_getStatePtr;
  Module.physics_getStateSize = Module.physics_getStateSize || Module._physics_getStateSize;
  Module.physics_getControlsPtr = Module.physics_getControlsPtr || Module._physics_getControlsPtr;
  Module.physics_getPadInfoPtr = Module.physics_getPadInfoPtr || Module._physics_getPadInfoPtr;
  Module.physics_addCar = Module.physics_addCar || Module._physics_addCar;
  Module.physics_addCarAtSlot = Module.physics_addCarAtSlot || Module._physics_addCarAtSlot;
  Module.physics_removeCar = Module.physics_removeCar || Module._physics_removeCar;
  Module.physics_getActiveCarMask = Module.physics_getActiveCarMask || Module._physics_getActiveCarMask;
  Module.physics_isCarSlotActive = Module.physics_isCarSlotActive || Module._physics_isCarSlotActive;
  Module.physics_getActiveCarCount = Module.physics_getActiveCarCount || Module._physics_getActiveCarCount;
  Module.physics_getCarConfig = Module.physics_getCarConfig || Module._physics_getCarConfig;
  Module.physics_setCarState = Module.physics_setCarState || Module._physics_setCarState;
  Module.physics_setBallState = Module.physics_setBallState || Module._physics_setBallState;
  Module.physics_getBallOnGround = Module.physics_getBallOnGround || Module._physics_getBallOnGround;
  Module.physics_getBallRadius = Module.physics_getBallRadius || Module._physics_getBallRadius;
  Module.physics_initBallPrediction = Module.physics_initBallPrediction || Module._physics_initBallPrediction;
  Module.physics_updateBallPrediction = Module.physics_updateBallPrediction || Module._physics_updateBallPrediction;
  Module.physics_getBallPredictionPtr = Module.physics_getBallPredictionPtr || Module._physics_getBallPredictionPtr;
  Module.physics_getBallPredictionCount = Module.physics_getBallPredictionCount || Module._physics_getBallPredictionCount;
  Module.physics_setSimControlFlags = Module.physics_setSimControlFlags || Module._physics_setSimControlFlags;
  Module.physics_getSimControlFlags = Module.physics_getSimControlFlags || Module._physics_getSimControlFlags;
  Module.physics_setImpactThresholds = Module.physics_setImpactThresholds || Module._physics_setImpactThresholds;
  Module.physics_getBallMotionState = Module.physics_getBallMotionState || Module._physics_getBallMotionState;
  Module.physics_setPossessionEventEnabled = Module.physics_setPossessionEventEnabled || Module._physics_setPossessionEventEnabled;
  Module.physics_getPossessionEventEnabled = Module.physics_getPossessionEventEnabled || Module._physics_getPossessionEventEnabled;
  Module.physics_getCurrentPossessionCar = Module.physics_getCurrentPossessionCar || Module._physics_getCurrentPossessionCar;
  Module.physics_getCurrentPossessionTeam = Module.physics_getCurrentPossessionTeam || Module._physics_getCurrentPossessionTeam;
  Module.physics_pushSignalEvent = Module.physics_pushSignalEvent || Module._physics_pushSignalEvent;
  Module.physics_getEventBufferPtr = Module.physics_getEventBufferPtr || Module._physics_getEventBufferPtr;
  Module.physics_getEventBufferSize = Module.physics_getEventBufferSize || Module._physics_getEventBufferSize;
  Module.physics_clearEvents = Module.physics_clearEvents || Module._physics_clearEvents;
  Module.physics_setSurfaceTaxonomyThresholds = Module.physics_setSurfaceTaxonomyThresholds || Module._physics_setSurfaceTaxonomyThresholds;
  Module.physics_setDirectionDotThreshold = Module.physics_setDirectionDotThreshold || Module._physics_setDirectionDotThreshold;
  Module.physics_getDirectionDotThreshold = Module.physics_getDirectionDotThreshold || Module._physics_getDirectionDotThreshold;
  Module.physics_setCarTeam = Module.physics_setCarTeam || Module._physics_setCarTeam;
  Module.physics_restoreCompactState = Module.physics_restoreCompactState || Module._physics_restoreCompactState;
  Module.physics_setCarThreeWheels = Module.physics_setCarThreeWheels || Module._physics_setCarThreeWheels;
  Module.physics_getCarThreeWheels = Module.physics_getCarThreeWheels || Module._physics_getCarThreeWheels;
  Module.physics_setArenaPreset = Module.physics_setArenaPreset || Module._physics_setArenaPreset;
  Module.physics_getArenaPreset = Module.physics_getArenaPreset || Module._physics_getArenaPreset;
  Module.physics_setGoalVolumeBox = Module.physics_setGoalVolumeBox || Module._physics_setGoalVolumeBox;
  Module.physics_initReplayBuffer = Module.physics_initReplayBuffer || Module._physics_initReplayBuffer;
  Module.physics_clearReplayBuffer = Module.physics_clearReplayBuffer || Module._physics_clearReplayBuffer;
  Module.physics_getReplayBufferPtr = Module.physics_getReplayBufferPtr || Module._physics_getReplayBufferPtr;
  Module.physics_getReplayBufferSize = Module.physics_getReplayBufferSize || Module._physics_getReplayBufferSize;
  Module.physics_recordReplayFrame = Module.physics_recordReplayFrame || Module._physics_recordReplayFrame;
  Module.physics_getReplayFrameCount = Module.physics_getReplayFrameCount || Module._physics_getReplayFrameCount;
  Module.physics_getReplayFramePtrByOffset = Module.physics_getReplayFramePtrByOffset || Module._physics_getReplayFramePtrByOffset;
  Module.physics_getReplayFramePtrByIndex = Module.physics_getReplayFramePtrByIndex || Module._physics_getReplayFramePtrByIndex;
  Module.physics_getReplayControlsPtrByIndex = Module.physics_getReplayControlsPtrByIndex || Module._physics_getReplayControlsPtrByIndex;
  Module.physics_getReplayStateTrackPtr = Module.physics_getReplayStateTrackPtr || Module._physics_getReplayStateTrackPtr;
  Module.physics_getReplayStateStride = Module.physics_getReplayStateStride || Module._physics_getReplayStateStride;
  Module.physics_getReplayIncidentTrackPtr = Module.physics_getReplayIncidentTrackPtr || Module._physics_getReplayIncidentTrackPtr;
  Module.physics_getReplayIncidentCount = Module.physics_getReplayIncidentCount || Module._physics_getReplayIncidentCount;
  Module.physics_getReplaySignalTrackPtr = Module.physics_getReplaySignalTrackPtr || Module._physics_getReplaySignalTrackPtr;
  Module.physics_getReplaySignalCount = Module.physics_getReplaySignalCount || Module._physics_getReplaySignalCount;
  Module.physics_setReplayRecordingActive = Module.physics_setReplayRecordingActive || Module._physics_setReplayRecordingActive;
  Module.physics_getReplayRecordingActive = Module.physics_getReplayRecordingActive || Module._physics_getReplayRecordingActive;

  if (!isIsolated) {
    cachedInstance = Module;
  }
  return Module;
}

export default loadRocketSimWasmModule;
