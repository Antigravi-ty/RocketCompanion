/**
 * StaticTrainingEditorHelper.js
 * 3D Editor Sub-Mode Camera (with Yaw + Pitch aiming for Car Heading, Car Speed, and Ball Speed),
 * Continuous WASD/Mouse manipulation, Free-Cam [T] trajectory test & [G] single-shot test,
 * and Play/Edit hotkeys for StaticTrainingPackMode.
 */

import * as THREE from 'three';
import {
  useStaticTrainingPackStore,
  getActiveEditItemVariable,
  mutateActiveEditItemVariable,
} from '../../../stores/staticTrainingPackStore';
import { useStaticTrainingBallCamTunerStore } from '../../../stores/staticTrainingBallCamTunerStore';
import { useAppStore } from '../../../stores/appStore';
import { hudStore } from '../../../stores/hudStore';
import {
  CAR_GROUND_MIN_Z,
  BALL_GROUND_MIN_Z,
  ARENA_MAX_X,
  ARENA_MAX_Y,
  ARENA_MAX_Z,
} from './StaticTrainingArenaHelper.js';

export function applyEditSubModeCamera(mode, subMode) {
  const r = mode.runtime;
  if (!r?.camera) return;

  if (subMode !== 'free-cam' && mode.isFreeCamTrajectoryTesting) {
    mode.stopFreeCamTrajectoryTest?.();
  }

  if (mode.isTestingSingleShot) {
    r.goalReplayCameraOverrideActive = false;
    if (r.camera.isFreeCam) {
      r.camera.setFreeCam(false);
    }
    return;
  }

  if (subMode === 'free-cam') {
    r.goalReplayCameraOverrideActive = false;
    r.camera.setFreeCam(true);
  } else {
    if (r.camera.isFreeCam) {
      r.camera.setFreeCam(false);
    }
    r.camera.ballCam = false;
    r.goalReplayCameraOverrideActive = true;
  }
}

export function updateEditorCameraAndContinuousInputs(mode, dt) {
  const r = mode.runtime;
  const store = useStaticTrainingPackStore.getState();
  if (store.sessionMode !== 'edit' || mode.isTestingSingleShot) return;

  const subMode = store.editSubMode;
  const shot = mode._getCurrentShotConfig();
  if (!shot) return;

  // 1. Update directional camera for 'car-heading', 'car-speed', and 'ball-speed' (both Yaw and Pitch)
  if (subMode !== 'free-cam' && r?.camera?.camera) {
    r.goalReplayCameraOverrideActive = true;
    const cam = r.camera.camera;

    if (subMode === 'car-heading') {
      const cLoc = shot.car.location || shot.car.pos || [0, -2400, CAR_GROUND_MIN_Z];
      const targetPos = new THREE.Vector3(cLoc[0], cLoc[2] + 35, cLoc[1]);
      const lookYaw = Number(shot.car.headingYaw) || 0;
      const lookPitch = shot.car.snapToGround ? 0 : Number(shot.car.headingPitch) || 0;
      const cp = Math.cos(lookPitch);
      const sp = Math.sin(lookPitch);
      const fwdX = Math.cos(lookYaw) * cp;
      const fwdY = sp;
      const fwdZ = Math.sin(lookYaw) * cp;
      const dist = 320;
      const heightOffset = 90;
      cam.position.set(
        targetPos.x - fwdX * dist,
        Math.max(24, targetPos.y - fwdY * dist + heightOffset),
        targetPos.z - fwdZ * dist
      );
      cam.lookAt(
        targetPos.x + fwdX * 420,
        targetPos.y + fwdY * 420,
        targetPos.z + fwdZ * 420
      );
    } else if (subMode === 'car-speed') {
      const cLoc = shot.car.location || shot.car.pos || [0, -2400, CAR_GROUND_MIN_Z];
      const targetPos = new THREE.Vector3(cLoc[0], cLoc[2] + 35, cLoc[1]);
      const lookYaw = Number(shot.car.speedYaw ?? shot.car.headingYaw) || 0;
      const lookPitch = Number(shot.car.speedPitch) || 0;
      const cp = Math.cos(lookPitch);
      const sp = Math.sin(lookPitch);
      const fwdX = Math.cos(lookYaw) * cp;
      const fwdY = sp;
      const fwdZ = Math.sin(lookYaw) * cp;
      const dist = 340;
      const heightOffset = 95;
      cam.position.set(
        targetPos.x - fwdX * dist,
        Math.max(24, targetPos.y - fwdY * dist + heightOffset),
        targetPos.z - fwdZ * dist
      );
      cam.lookAt(
        targetPos.x + fwdX * 450,
        targetPos.y + fwdY * 450,
        targetPos.z + fwdZ * 450
      );
    } else if (subMode === 'ball-speed') {
      const bLoc = shot.ball.location || shot.ball.pos || [0, 0, BALL_GROUND_MIN_Z];
      const ballCenter = new THREE.Vector3(bLoc[0], bLoc[2], bLoc[1]);
      const lookYaw = Number(shot.ball.speedYaw) || 0;
      const lookPitch = Number(shot.ball.speedPitch) || 0;
      const cp = Math.cos(lookPitch);
      const sp = Math.sin(lookPitch);

      const { distance, height, angle, lateralOffset } =
        useStaticTrainingBallCamTunerStore.getState();

      // Forward along ball velocity direction (Three.js X=RL_X, Y=RL_Z, Z=RL_Y)
      const fwdX = Math.cos(lookYaw) * cp;
      const fwdY = sp;
      const fwdZ = Math.sin(lookYaw) * cp;

      // Local right & local up relative to ball aim direction so camera stays above arrow & trajectory
      const rightX = -Math.sin(lookYaw);
      const rightY = 0;
      const rightZ = Math.cos(lookYaw);

      const upX = -Math.cos(lookYaw) * sp;
      const upY = cp;
      const upZ = -Math.sin(lookYaw) * sp;

      const camX = ballCenter.x - fwdX * distance + upX * height + rightX * lateralOffset;
      const camY = Math.max(
        20,
        ballCenter.y - fwdY * distance + upY * height + rightY * lateralOffset
      );
      const camZ = ballCenter.z - fwdZ * distance + upZ * height + rightZ * lateralOffset;

      const effectivePitch = Math.max(
        -Math.PI * 0.48,
        Math.min(Math.PI * 0.48, lookPitch + (angle * Math.PI) / 180)
      );
      const lookDirX = Math.cos(lookYaw) * Math.cos(effectivePitch);
      const lookDirY = Math.sin(effectivePitch);
      const lookDirZ = Math.sin(lookYaw) * Math.cos(effectivePitch);

      cam.position.set(camX, camY, camZ);
      cam.lookAt(
        camX + lookDirX * 800,
        camY + lookDirY * 800,
        camZ + lookDirZ * 800
      );
    }
  }

  // Do not process WASD object movement when modal panel is expanded, Free Cam is active, or no keys held
  const appState = useAppStore.getState();
  if (appState.isOpen && !appState.isLivePreviewCollapsed) {
    if (mode.heldKeys.size > 0) mode.heldKeys.clear();
    return;
  }
  if (subMode === 'free-cam' || mode.heldKeys.size === 0) return;

  const moveSpeed =
    mode.heldKeys.has('ShiftLeft') || mode.heldKeys.has('ShiftRight') ? 1350 : 680;
  const stepDist = moveSpeed * Math.min(0.05, dt || 0.016);

  // Compute camera-relative horizontal forward & right in RocketSim (X, Y) plane
  let camFwdX = 0;
  let camFwdY = 1;
  if (r?.camera?.camera) {
    const dir = new THREE.Vector3();
    r.camera.camera.getWorldDirection(dir);
    const len = Math.hypot(dir.x, dir.z);
    if (len > 1e-4) {
      camFwdX = dir.x / len;
      camFwdY = dir.z / len;
    }
  }
  const camRightX = -camFwdY;
  const camRightY = camFwdX;

  let moveX = 0;
  let moveY = 0;
  let moveZ = 0;

  if (mode.heldKeys.has('KeyW')) {
    moveX += camFwdX * stepDist;
    moveY += camFwdY * stepDist;
  }
  if (mode.heldKeys.has('KeyS')) {
    moveX -= camFwdX * stepDist;
    moveY -= camFwdY * stepDist;
  }
  if (mode.heldKeys.has('KeyD')) {
    moveX += camRightX * stepDist;
    moveY += camRightY * stepDist;
  }
  if (mode.heldKeys.has('KeyA')) {
    moveX -= camRightX * stepDist;
    moveY -= camRightY * stepDist;
  }
  if (mode.heldKeys.has('Space')) {
    moveZ += stepDist;
  }
  if (mode.heldKeys.has('KeyV')) {
    moveZ -= stepDist;
  }

  let rollDelta = 0;
  if (subMode === 'car-heading') {
    if (mode.heldKeys.has('KeyQ')) rollDelta -= 1.8 * (dt || 0.016);
    if (mode.heldKeys.has('KeyE')) rollDelta += 1.8 * (dt || 0.016);
  }

  let boostDelta = 0;
  if (subMode === 'car-heading' || subMode === 'car-speed') {
    if (mode.heldKeys.has('KeyO')) boostDelta -= 55 * (dt || 0.016);
    if (mode.heldKeys.has('KeyP')) boostDelta += 55 * (dt || 0.016);
  }

  let speedDelta = 0;
  if (subMode === 'car-heading' || subMode === 'car-speed' || subMode === 'ball-speed') {
    if (mode.heldKeys.has('BracketLeft')) speedDelta -= 950 * (dt || 0.016);
    if (mode.heldKeys.has('BracketRight')) speedDelta += 950 * (dt || 0.016);
  }

  if (
    Math.abs(moveX) < 1e-4 &&
    Math.abs(moveY) < 1e-4 &&
    Math.abs(moveZ) < 1e-4 &&
    Math.abs(rollDelta) < 1e-4 &&
    Math.abs(boostDelta) < 1e-4 &&
    Math.abs(speedDelta) < 1e-4
  ) {
    return;
  }

  mutateActiveEditItemVariable((draft) => {
    if (subMode === 'car-heading' || subMode === 'car-speed') {
      draft.car.location[0] = Math.max(
        -ARENA_MAX_X,
        Math.min(ARENA_MAX_X, draft.car.location[0] + moveX)
      );
      draft.car.location[1] = Math.max(
        -ARENA_MAX_Y,
        Math.min(ARENA_MAX_Y, draft.car.location[1] + moveY)
      );
      if (moveZ > 0) {
        draft.car.snapToGround = false;
        draft.car.location[2] = Math.min(ARENA_MAX_Z, draft.car.location[2] + moveZ);
      } else if (moveZ < 0) {
        draft.car.location[2] = Math.max(CAR_GROUND_MIN_Z, draft.car.location[2] + moveZ);
      }

      if (rollDelta !== 0) {
        draft.car.airRoll = Number((draft.car.airRoll + rollDelta).toFixed(4));
      }
      if (boostDelta !== 0) {
        if (boostDelta < 0 && draft.car.unlimitedBoost) {
          draft.car.unlimitedBoost = false;
          draft.car.initialBoost = 100;
        } else if (!draft.car.unlimitedBoost) {
          draft.car.initialBoost = Math.max(
            0,
            Math.min(100, Math.round(draft.car.initialBoost + boostDelta))
          );
        }
      }
      if (speedDelta !== 0) {
        draft.car.speed = Math.max(0, Math.min(2300, Math.round(draft.car.speed + speedDelta)));
        if (draft.car.speedFollowsHeading !== false) {
          draft.car.speedYaw = draft.car.headingYaw;
          draft.car.speedPitch = draft.car.snapToGround ? 0 : draft.car.headingPitch;
        }
      }
    } else if (subMode === 'ball-speed') {
      draft.ball.location[0] = Math.max(
        -ARENA_MAX_X,
        Math.min(ARENA_MAX_X, draft.ball.location[0] + moveX)
      );
      draft.ball.location[1] = Math.max(
        -ARENA_MAX_Y,
        Math.min(ARENA_MAX_Y, draft.ball.location[1] + moveY)
      );
      if (moveZ !== 0) {
        draft.ball.location[2] = Math.max(
          BALL_GROUND_MIN_Z,
          Math.min(ARENA_MAX_Z, draft.ball.location[2] + moveZ)
        );
      }

      if (speedDelta < 0) {
        if (draft.ball.speed > 0 && !mode.ballSpeedZeroLatch) {
          const nextSpd = Math.max(0, Math.round(draft.ball.speed + speedDelta));
          draft.ball.speed = nextSpd;
          if (nextSpd === 0) {
            mode.ballSpeedZeroLatch = true;
          }
        }
      } else if (speedDelta > 0) {
        if (draft.ball.kickoffState) {
          draft.ball.kickoffState = false;
          draft.ball.speed = 0;
        } else {
          draft.ball.speed = Math.min(4000, Math.round(draft.ball.speed + speedDelta));
        }
      }
    }
  });
}

export function bindStaticTrainingSessionEvents(mode) {
  if (typeof window === 'undefined') return;
  unbindStaticTrainingSessionEvents(mode);

  const isInputFocused = (evt) => {
    const tag = evt?.target?.tagName?.toUpperCase?.() || '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  mode._keyDownHandler = (evt) => {
    if (mode.runtime?.match?.state?.mode !== 'static-training-pack') return;
    if (isInputFocused(evt)) return;

    const store = useStaticTrainingPackStore.getState();
    const code = evt.code;

    // Replay [P] Pause & Scrubbing support
    if (mode.isReplayActive && (code === 'KeyP' || evt.key === 'p' || evt.key === 'P')) {
      if (!evt.repeat) {
        evt.preventDefault();
        const paused = mode.replayController.togglePause();
        hudStore.getState().setReplayState({
          replayPaused: paused,
          replayPersistent: mode.replayController.isPersistent,
        });
      }
      return;
    }

    // If currently in Single-Shot Test [G] inside Edit Mode
    if (store.sessionMode === 'edit' && mode.isTestingSingleShot) {
      if ((code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && !evt.repeat) {
        evt.preventDefault();
        mode.toggleSingleShotTest?.();
        return;
      }
      if ((code === 'KeyR' || evt.key === 'r' || evt.key === 'R') && !evt.repeat) {
        evt.preventDefault();
        mode.reloadCurrentShot();
        return;
      }
      return;
    }

    if (store.sessionMode === 'play') {
      if ((code === 'KeyR' || evt.key === 'r' || evt.key === 'R') && !evt.repeat) {
        evt.preventDefault();
        mode.reloadCurrentShot();
        return;
      }
      if ((code === 'BracketLeft' || evt.key === '[' || code === 'Digit9') && !evt.repeat) {
        evt.preventDefault();
        store.prevShot();
        return;
      }
      if ((code === 'BracketRight' || evt.key === ']' || code === 'Digit0') && !evt.repeat) {
        evt.preventDefault();
        store.nextShot();
        return;
      }
      return;
    }

    // Edit Mode hotkeys
    if (store.sessionMode === 'edit') {
      const appState = useAppStore.getState();
      if (appState.isOpen && !appState.isLivePreviewCollapsed) return;

      // Cycle edit sub-modes: Digit9 = Prev, Digit0 = Next
      if (code === 'Digit9' && !evt.repeat) {
        evt.preventDefault();
        store.cycleEditSubMode(-1);
        return;
      }
      if (code === 'Digit0' && !evt.repeat) {
        evt.preventDefault();
        store.cycleEditSubMode(1);
        return;
      }

      const subMode = store.editSubMode;

      // [T] Trajectory Simulation Test & [G] Single Shot Test available in ALL Edit sub-modes
      // Camera remains stationary at its unlaunched position during [T] simulation
      if ((code === 'KeyT' || evt.key === 't' || evt.key === 'T') && !evt.repeat) {
        evt.preventDefault();
        mode.toggleFreeCamTrajectoryTest?.();
        return;
      }
      if ((code === 'KeyG' || evt.key === 'g' || evt.key === 'G') && !evt.repeat) {
        evt.preventDefault();
        mode.toggleSingleShotTest?.();
        return;
      }

      if (subMode === 'free-cam') {
        return;
      }

      if (!store.isEditingItem) {
        store.enterItemEditMode(store.currentShotIndex);
      }

      // Track held keys for continuous movement/adjustments
      mode.heldKeys.add(code);

      // Discrete single-press transitions:
      // 0. Backslash (\) zeroes out speed in car-heading, car-speed, or ball-speed
      if (code === 'Backslash' && !evt.repeat) {
        mutateActiveEditItemVariable((draft) => {
          if (subMode === 'car-heading' || subMode === 'car-speed') {
            draft.car.speed = 0;
          } else if (subMode === 'ball-speed') {
            draft.ball.speed = 0;
            draft.ball.kickoffState = false;
          }
        });
      }

      // 1. V at ground -> snapToGround
      if (code === 'KeyV' && !evt.repeat && (subMode === 'car-heading' || subMode === 'car-speed')) {
        const item = getActiveEditItemVariable();
        if (item && item.car.location[2] <= CAR_GROUND_MIN_Z + 1.5 && !item.car.snapToGround) {
          mutateActiveEditItemVariable((draft) => {
            draft.car.location[2] = CAR_GROUND_MIN_Z;
            draft.car.snapToGround = true;
            draft.car.headingPitch = 0;
            draft.car.airRoll = 0;
            if (draft.car.speedFollowsHeading !== false) {
              draft.car.speedPitch = 0;
            }
          });
        }
      }

      // 2. P at 100 boost -> Unlimited Boost
      if (code === 'KeyP' && !evt.repeat && (subMode === 'car-heading' || subMode === 'car-speed')) {
        const item = getActiveEditItemVariable();
        if (item && item.car.initialBoost >= 100 && !item.car.unlimitedBoost) {
          mutateActiveEditItemVariable((draft) => {
            draft.car.initialBoost = 100;
            draft.car.unlimitedBoost = true;
          });
        }
      }

      // 3. '[' at 0 ball speed -> kickoffState
      if (code === 'BracketLeft' && !evt.repeat && subMode === 'ball-speed') {
        mode.ballSpeedZeroLatch = false;
        const item = getActiveEditItemVariable();
        if (item && item.ball.speed === 0 && !item.ball.kickoffState) {
          mutateActiveEditItemVariable((draft) => {
            draft.ball.kickoffState = true;
          });
          mode.ballSpeedZeroLatch = true;
        }
      }

      // 4. ']' when kickoffState is true -> exit kickoffState back to speed = 0
      if (code === 'BracketRight' && !evt.repeat && subMode === 'ball-speed') {
        const item = getActiveEditItemVariable();
        if (item && item.ball.kickoffState) {
          mutateActiveEditItemVariable((draft) => {
            draft.ball.kickoffState = false;
            draft.ball.speed = 0;
          });
          mode.heldKeys.delete('BracketRight');
        }
      }
    }
  };

  mode._keyUpHandler = (evt) => {
    mode.heldKeys.delete(evt.code);
    if (evt.code === 'BracketLeft') {
      mode.ballSpeedZeroLatch = false;
    }
  };

  mode._mouseDownHandler = (evt) => {
    if (mode.runtime?.match?.state?.mode !== 'static-training-pack') return;
    const store = useStaticTrainingPackStore.getState();
    if (store.sessionMode !== 'edit' || mode.isTestingSingleShot) return;

    const appState = useAppStore.getState();
    if (appState.isOpen && !appState.isLivePreviewCollapsed) return;

    // Ignore clicks inside UI panels
    const targetEl = evt.target;
    if (
      targetEl &&
      targetEl.closest &&
      targetEl.closest(
        '[data-panel="container"], [data-ui-element="floating-window"], [data-ui-interactive="true"], button, input, select, textarea, [style*="pointer-events: auto"]'
      )
    ) {
      return;
    }

    if (evt.button === 2) {
      // Right-click advances to next Edit Sub-Mode (same as Digit0)
      evt.preventDefault();
      store.cycleEditSubMode(1);
      return;
    }

    if (evt.button === 0 && store.editSubMode !== 'free-cam') {
      if (!store.isEditingItem) {
        store.enterItemEditMode(store.currentShotIndex);
      }
      mode.isLeftMouseDragging = true;
      mode.lastMouseX = evt.clientX;
      mode.lastMouseY = evt.clientY;
    }
  };

  mode._mouseMoveHandler = (evt) => {
    if (!mode.isLeftMouseDragging) return;
    const store = useStaticTrainingPackStore.getState();
    if (
      store.sessionMode !== 'edit' ||
      store.editSubMode === 'free-cam' ||
      mode.isTestingSingleShot
    ) {
      mode.isLeftMouseDragging = false;
      return;
    }

    const dx = evt.clientX - mode.lastMouseX;
    const dy = evt.clientY - mode.lastMouseY;
    mode.lastMouseX = evt.clientX;
    mode.lastMouseY = evt.clientY;

    if (dx === 0 && dy === 0) return;
    const sens = 0.0045;
    const subMode = store.editSubMode;

    mutateActiveEditItemVariable((draft) => {
      if (subMode === 'car-heading') {
        draft.car.headingYaw = Number((draft.car.headingYaw + dx * sens).toFixed(4));
        if (!draft.car.snapToGround) {
          draft.car.headingPitch = Number(
            Math.max(
              -Math.PI * 0.48,
              Math.min(Math.PI * 0.48, draft.car.headingPitch - dy * sens)
            ).toFixed(4)
          );
        }
        if (draft.car.speedFollowsHeading !== false) {
          draft.car.speedYaw = draft.car.headingYaw;
          draft.car.speedPitch = draft.car.snapToGround ? 0 : draft.car.headingPitch;
        }
      } else if (subMode === 'car-speed') {
        draft.car.speedYaw = Number((draft.car.speedYaw + dx * sens).toFixed(4));
        draft.car.speedPitch = Number(
          Math.max(
            -Math.PI * 0.48,
            Math.min(Math.PI * 0.48, draft.car.speedPitch - dy * sens)
          ).toFixed(4)
        );
      } else if (subMode === 'ball-speed') {
        draft.ball.speedYaw = Number((draft.ball.speedYaw + dx * sens).toFixed(4));
        draft.ball.speedPitch = Number(
          Math.max(
            -Math.PI * 0.48,
            Math.min(Math.PI * 0.48, draft.ball.speedPitch - dy * sens)
          ).toFixed(4)
        );
      }
    });
  };

  mode._mouseUpHandler = (evt) => {
    if (evt.button === 0) {
      mode.isLeftMouseDragging = false;
    }
  };

  mode._contextMenuHandler = (evt) => {
    if (mode.runtime?.match?.state?.mode === 'static-training-pack') {
      const store = useStaticTrainingPackStore.getState();
      if (store.sessionMode === 'edit' && !mode.isTestingSingleShot) {
        evt.preventDefault();
      }
    }
  };

  window.addEventListener('keydown', mode._keyDownHandler, true);
  window.addEventListener('keyup', mode._keyUpHandler, true);
  window.addEventListener('mousedown', mode._mouseDownHandler);
  window.addEventListener('mousemove', mode._mouseMoveHandler);
  window.addEventListener('mouseup', mode._mouseUpHandler);
  window.addEventListener('contextmenu', mode._contextMenuHandler);
}

export function unbindStaticTrainingSessionEvents(mode) {
  if (typeof window === 'undefined') return;
  if (mode._keyDownHandler) {
    window.removeEventListener('keydown', mode._keyDownHandler, true);
    mode._keyDownHandler = null;
  }
  if (mode._keyUpHandler) {
    window.removeEventListener('keyup', mode._keyUpHandler, true);
    mode._keyUpHandler = null;
  }
  if (mode._mouseDownHandler) {
    window.removeEventListener('mousedown', mode._mouseDownHandler);
    mode._mouseDownHandler = null;
  }
  if (mode._mouseMoveHandler) {
    window.removeEventListener('mousemove', mode._mouseMoveHandler);
    mode._mouseMoveHandler = null;
  }
  if (mode._mouseUpHandler) {
    window.removeEventListener('mouseup', mode._mouseUpHandler);
    mode._mouseUpHandler = null;
  }
  if (mode._contextMenuHandler) {
    window.removeEventListener('contextmenu', mode._contextMenuHandler);
    mode._contextMenuHandler = null;
  }
}
