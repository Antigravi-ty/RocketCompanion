/**
 * GamepadController.js
 * Advanced Gamepad controller with deadzone shaping, analog triggers,
 * multi-device tracking, camera panning, and ball control shortcuts.
 */

import {
  INPUT_ACTIONS,
  TRIGGER_ANALOG_THRESHOLD,
  ACTIVITY_EPSILON,
  CAMERA_LOOK_DEADZONE
} from "../ui-core/config/InputConstants.js";
import { getEffectiveGamepad } from "../ui-core/config/InputBindings.js";
import { BALL_CONTROL_MODES } from "../physics/RocketSimConstants.js";

export const VEHICLE_ACTIONS = INPUT_ACTIONS.filter(
  i => i.group === "Driving" || i.group === "Aerial"
);

export class GamepadController {
  constructor(bindings) {
    this.bindings = bindings;
    this.enabled = true;
    this.captureActive = false;
    this.lastActive = false;
    this.deviceIdentity = undefined;
    this.activityValues = [];
    this.previousBallActions = new Set();
    this.prevBallCam = false;
    this.prevReset = false;
    this.prevSettings = false;

    this.look = { x: 0, y: 0 };
    this.cameraLook = this.look;
    this.controls = {
      throttle: 0,
      steer: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      jump: false,
      boost: false,
      handbrake: false
    };

    this.onBallCamToggle = null;
    this.onReset = null;
    this.onBallControl = null;
    this.onSettingsToggle = null;
    this.onActivity = null;
  }

  active() {
    return this.lastActive;
  }

  set capturing(val) {
    this.captureActive = val;
  }

  setBindings(bindings) {
    this.bindings = bindings;
  }

  /**
   * Apply radial deadzone filtering with linear ramp-up from threshold to 1.
   * @param {number} val
   * @param {number} [threshold=this.bindings.axes.deadzone]
   * @returns {number}
   */
  dz(val, threshold = this.bindings.axes.deadzone) {
    if (Math.abs(val) < threshold) return 0;
    return Math.sign(val) * ((Math.abs(val) - threshold) / (1 - threshold));
  }

  axisRole(role, pad) {
    const cfg = this.bindings.axes[role];
    const raw = this.dz(pad.axes[cfg.axis] ?? 0);
    return cfg.invert ? -raw : raw;
  }

  analogValue(action, pad, deadzone = this.bindings.axes.deadzone) {
    let maxVal = 0;
    const sources = this.bindings.pad[action] ?? [];
    for (const src of sources) {
      maxVal = Math.max(maxVal, this.sourceTravel(src, pad, deadzone));
    }
    return maxVal;
  }

  sourceTravel(src, pad, deadzone = this.bindings.axes.deadzone) {
    if (src.kind === "padButton") {
      const btn = pad.buttons[src.index];
      if (!btn) return 0;
      return btn.value > 0 ? btn.value : btn.pressed ? 1 : 0;
    }
    if (src.kind === "padAxis") {
      return Math.max(0, this.dz(pad.axes[src.axis] ?? 0, deadzone) * src.dir);
    }
    return 0;
  }

  pressed(action, pad = getEffectiveGamepad()) {
    if (!pad) return false;
    const sources = this.bindings.pad[action] ?? [];
    for (const src of sources) {
      if (src.kind === "padButton") {
        const btn = pad.buttons[src.index];
        if (btn?.pressed) return true;
      } else if (src.kind === "padAxis") {
        if (this.sourceTravel(src, pad) > TRIGGER_ANALOG_THRESHOLD) return true;
      }
    }
    return false;
  }

  read() {
    const pad = getEffectiveGamepad();
    const currentId = pad ? `${pad.id}\0${pad.index}` : null;

    if (currentId !== this.deviceIdentity) {
      const hadPrevious = this.deviceIdentity !== undefined;
      this.deviceIdentity = currentId;
      this.activityValues.length = 0;
      this.previousBallActions.clear();
      this.prevBallCam = false;
      this.prevReset = false;
      this.prevSettings = false;

      if (pad && hadPrevious) {
        this.prevBallCam = this.pressed("ballCam", pad);
        this.prevReset = this.pressed("resetShot", pad);
        this.prevSettings = this.pressed("toggleSettings", pad);
        for (const mode of BALL_CONTROL_MODES) {
          if (this.pressed(mode, pad)) this.previousBallActions.add(mode);
        }
        this.trackActivity(pad, false);
      }
    }

    if (!pad) {
      this.activityValues.length = 0;
      this.previousBallActions.clear();
      this.lastActive = false;
      this.resetControls();
      return this.controls;
    }

    this.trackActivity(pad);

    const steerAxis = this.bindings.axes.steer;
    const pitchAxis = this.bindings.axes.pitch;
    this.lastActive =
      this.enabled &&
      (Math.abs(pad.axes[steerAxis.axis] ?? 0) > this.bindings.axes.deadzone ||
        Math.abs(pad.axes[pitchAxis.axis] ?? 0) > this.bindings.axes.deadzone ||
        this.hasActiveVehicleBinding(pad));

    // Settings Toggle
    const settingsPressed = this.pressed("toggleSettings", pad);
    if (!this.captureActive && settingsPressed && !this.prevSettings) {
      this.onSettingsToggle?.();
    }
    this.prevSettings = settingsPressed;

    // Ball Cam Toggle
    const ballCamPressed = this.pressed("ballCam", pad);
    if (this.enabled && !this.captureActive && ballCamPressed && !this.prevBallCam) {
      this.onBallCamToggle?.();
    }
    this.prevBallCam = ballCamPressed;

    // Reset Shot
    const resetPressed = this.pressed("resetShot", pad);
    if (this.enabled && !this.captureActive && resetPressed && !this.prevReset) {
      this.onReset?.();
    }
    this.prevReset = resetPressed;

    // Ball Control Toggles
    for (const mode of BALL_CONTROL_MODES) {
      const isDown = this.pressed(mode, pad);
      if (isDown && !this.previousBallActions.has(mode) && this.enabled && !this.captureActive) {
        this.onBallControl?.(mode);
      }
      if (isDown) {
        this.previousBallActions.add(mode);
      } else {
        this.previousBallActions.delete(mode);
      }
    }

    if (!this.enabled || this.captureActive) {
      this.lastActive = false;
      this.resetControls();
      return this.controls;
    }

    // Steering and Aerials
    const analogSteer = this.axisRole("steer", pad);
    const digitalSteer =
      (this.pressed("steerRight", pad) ? 1 : 0) - (this.pressed("steerLeft", pad) ? 1 : 0);
    const totalSteer = Math.max(-1, Math.min(1, analogSteer + digitalSteer));

    const powerslideActive =
      this.analogValue("powerslide", pad) > this.bindings.axes.triggerThreshold;
    const airRollActive =
      this.analogValue("airRoll", pad) > this.bindings.axes.triggerThreshold;
    const airRollLeft = this.pressed("airRollLeft", pad);
    const airRollRight = this.pressed("airRollRight", pad);

    let yaw = totalSteer;
    let roll = 0;

    if (airRollLeft || airRollRight) {
      roll = Number(airRollRight) - Number(airRollLeft);
    } else if (airRollActive) {
      roll = totalSteer;
      yaw = 0;
    }

    this.controls.throttle =
      this.analogValue("throttleForward", pad) - this.analogValue("throttleReverse", pad);
    this.controls.steer = totalSteer;
    this.controls.pitch = this.axisRole("pitch", pad);
    this.controls.yaw = yaw;
    this.controls.roll = roll;
    this.controls.jump = this.pressed("jump", pad);
    this.controls.boost = this.pressed("boost", pad);
    this.controls.handbrake = powerslideActive;

    this.look.x =
      this.analogValue("cameraRight", pad, CAMERA_LOOK_DEADZONE) -
      this.analogValue("cameraLeft", pad, CAMERA_LOOK_DEADZONE);
    this.look.y =
      this.analogValue("cameraDown", pad, CAMERA_LOOK_DEADZONE) -
      this.analogValue("cameraUp", pad, CAMERA_LOOK_DEADZONE);

    return this.controls;
  }

  resetControls() {
    this.look.x = 0;
    this.look.y = 0;
    this.controls.throttle = 0;
    this.controls.steer = 0;
    this.controls.pitch = 0;
    this.controls.yaw = 0;
    this.controls.roll = 0;
    this.controls.jump = false;
    this.controls.boost = false;
    this.controls.handbrake = false;
  }

  trackActivity(pad, notify = true) {
    let hasChanged = false;
    const totalInputs = pad.axes.length + pad.buttons.length;

    for (let s = 0; s < totalInputs; s++) {
      let currentVal = 0;
      if (s < pad.axes.length) {
        const ax = pad.axes[s];
        if (Math.abs(ax) > this.bindings.axes.deadzone) currentVal = ax;
      } else {
        const btn = pad.buttons[s - pad.axes.length];
        if (btn && (btn.pressed || btn.value > this.bindings.axes.triggerThreshold)) {
          currentVal = btn.value || 1;
        }
      }

      const prev = this.activityValues[s] ?? 0;
      const changed =
        currentVal !== 0 &&
        (prev === 0 || Math.sign(currentVal) !== Math.sign(prev) || Math.abs(currentVal - prev) >= ACTIVITY_EPSILON);

      if (currentVal === 0 || changed) {
        this.activityValues[s] = currentVal;
      }
      if (changed) hasChanged = true;
    }

    if (hasChanged && notify) {
      this.onActivity?.();
    }
  }

  hasActiveVehicleBinding(pad) {
    for (const action of VEHICLE_ACTIONS) {
      if (action.analog) {
        const threshold =
          action.id === "powerslide" || action.id === "airRoll"
            ? this.bindings.axes.triggerThreshold
            : 0;
        if (this.analogValue(action.id, pad) > threshold) return true;
      } else if (this.pressed(action.id, pad)) {
        return true;
      }
    }
    return false;
  }

  dispose() {
    this.destroy();
  }

  destroy() {
    this.enabled = false;
    this.resetControls();
    this.activityValues.length = 0;
    this.previousBallActions.clear();
    this.onBallCamToggle = null;
    this.onReset = null;
    this.onBallControl = null;
    this.onSettingsToggle = null;
    this.onActivity = null;
  }
}
