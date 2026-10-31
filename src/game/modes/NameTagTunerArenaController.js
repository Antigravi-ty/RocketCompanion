/**
 * NameTagTunerArenaController.js
 * Manages the 6-car kickoff stadium evaluation environment for the Name Tag Active Tuner.
 * Does NOT enter the arena until the user explicitly clicks "Enter Arena & Spawn 6 Kickoff Cars".
 */

import { KICKOFF_SPAWN_PRESETS } from '../../physics/RocketSimConstants.js';
import {
  getNameTagConfig,
  setNameTagRuntimeState,
  subscribeNameTagConfig,
} from '../../ui-core/config/nameTagConfig.ts';
import { useAppStore } from '../../ui-core/stores/appStore';
import { hudStore } from '../../ui-core/stores/hudStore';

const SIX_CAR_KICKOFF_PERMUTATIONS = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 1, 4],
  [0, 2, 3],
  [0, 2, 4],
  [0, 3, 4],
  [1, 2, 3],
  [1, 2, 4],
  [1, 3, 4],
  [2, 3, 4],
];

const TEAM_BLUE_COLORS = [0x0ea5e9, 0x38bdf8, 0x2563eb];
const TEAM_ORANGE_COLORS = [0xf97316, 0xfb923c, 0xea580c];
const OVERVIEW_FREECAM_POSITION = [-1950, 720, -2600];
const OVERVIEW_FREECAM_TARGET = [0, 80, 0];

function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tagName = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  if (tagName === 'INPUT') {
    const inputType = String(target.type || 'text').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color'].includes(
      inputType
    );
  }
  return false;
}

export class NameTagTunerArenaController {
  constructor(runtime) {
    this.runtime = runtime;
    this.isActive = false;
    this.permutationIndex = 0;
    this.focusedCarIndex = 0;
    this._unsubConfig = null;
    this._keyDownHandler = null;
  }

  attach() {
    setNameTagRuntimeState({
      onEnterTunerArena: () => this.enterTunerArena(),
      onExitTunerArena: () => this.exitTunerArena(),
      onReshuffleKickoffPositions: () => this.reshuffleKickoffPositions(),
      onSelectPovCar: (carIndex) => this.focusCarPov(carIndex),
      onFocusFreeCamOverview: () => this.focusFreeCamOverview(),
    });

    if (!this._unsubConfig) {
      this._unsubConfig = subscribeNameTagConfig(() => {
        if (this.isActive) {
          this._syncCarEntriesFromConfig();
        }
      });
    }
  }

  detach() {
    this._unbindPovHotkeys();
    if (this.isActive) {
      this.exitTunerArena();
    }
  }

  _bindPovHotkeys() {
    this._unbindPovHotkeys();
    if (typeof window === 'undefined') return;

    this._keyDownHandler = (event) => {
      if (!this.isActive) return;
      if (this.runtime?.match?.state?.mode !== 'freeplay') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
      if (isEditableTarget(event.target) || isEditableTarget(activeElement)) return;

      let keyNumber = -1;
      if (event.code >= 'Digit1' && event.code <= 'Digit6') {
        keyNumber = Number(event.code.replace('Digit', ''));
      } else if (event.code >= 'Numpad1' && event.code <= 'Numpad6') {
        keyNumber = Number(event.code.replace('Numpad', ''));
      }

      if (keyNumber >= 1 && keyNumber <= 6) {
        event.preventDefault();
        event.stopPropagation();
        this.focusCarPov(keyNumber - 1);
        return;
      }

      if (event.code === 'Digit0' || event.code === 'Numpad0' || event.code === 'Backquote') {
        event.preventDefault();
        event.stopPropagation();
        this.focusFreeCamOverview();
      }
    };

    window.addEventListener('keydown', this._keyDownHandler, true);
  }

  _unbindPovHotkeys() {
    if (this._keyDownHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._keyDownHandler, true);
      this._keyDownHandler = null;
    }
  }

  _syncCarEntriesFromConfig() {
    const config = getNameTagConfig();
    const entries = [];
    for (let carIndex = 0; carIndex < 6; carIndex++) {
      entries.push({
        carIndex,
        name: config.previewNames?.[carIndex] || `Player ${carIndex + 1}`,
        team: carIndex < 3 ? 0 : 1,
      });
    }
    const cameraMode = this.runtime?.camera?.isFreeCam
      ? 'free'
      : (this.runtime?.camera?.currentMode || 'pov');
    setNameTagRuntimeState({
      isTunerArenaActive: this.isActive,
      kickoffPermutationIndex: this.permutationIndex,
      activeCameraMode: cameraMode,
      focusedCarIndex: this.focusedCarIndex,
      carEntries: entries,
    });
  }

  async enterTunerArena() {
    const runtime = this.runtime;
    if (!runtime?.physics) return;

    const appState = useAppStore.getState();
    if (appState.isOpen) {
      appState.closeMenu();
    }

    if (runtime.match?.state && runtime.match.state.mode !== 'freeplay') {
      runtime.match.state.mode = 'freeplay';
      runtime.match.state.phase = 'playing';
      appState.setMatchMode('freeplay');
      runtime.modeManager?.setMode?.('freeplay');
    }

    await runtime.arena?.ensureOpponent?.();

    this.isActive = true;
    if (runtime.keyboard) {
      runtime.keyboard.ballControlEnabled = false;
    }
    this._bindPovHotkeys();
    this._spawnSixKickoffCars();
    this.focusFreeCamOverview();
  }

  focusFreeCamOverview() {
    const runtime = this.runtime;
    if (!runtime) return;

    const appState = useAppStore.getState();
    if (runtime.camera) {
      if (typeof runtime.camera.setFreeCamPose === 'function') {
        runtime.camera.setFreeCamPose(OVERVIEW_FREECAM_POSITION, OVERVIEW_FREECAM_TARGET);
      } else {
        runtime.camera.setFreeCam?.(true);
      }
      appState.setFreeCam(true);
    }

    if (runtime.arena) {
      runtime.arena.isFreeCam = true;
      runtime.arena.cameraMode = 'free';
      runtime.arena.isPovCamera = false;
      runtime.arena.focusedCarIndex = this.focusedCarIndex;
    }

    hudStore.getState().setCameraFocusState('free', this.focusedCarIndex);
    this._syncCarEntriesFromConfig();
    runtime.arena?.nameTagSystem?.update?.(runtime.arena, 6, runtime.camera?.camera);
  }

  async focusCarPov(carIndex = 0) {
    if (!this.isActive) {
      await this.enterTunerArena();
    }
    const runtime = this.runtime;
    if (!runtime) return;

    const targetIndex = Math.max(0, Math.min(5, Math.round(Number(carIndex) || 0)));
    this.focusedCarIndex = targetIndex;
    runtime.playerCarIndex = targetIndex;

    if (runtime.arena) {
      runtime.arena.playerCarIndex = targetIndex;
      runtime.arena.focusedCarIndex = targetIndex;
      runtime.arena.isFreeCam = false;
      runtime.arena.cameraMode = 'pov';
      runtime.arena.isPovCamera = true;
    }

    if (runtime.camera) {
      runtime.camera.setFocusedCarIndex?.(targetIndex);
      runtime.camera.setFreeCam?.(false);
      runtime.camera.ballCam = true;
      runtime.camera.resetView?.();
    }

    useAppStore.getState().setFreeCam(false);
    const hud = hudStore.getState();
    hud.setBallCamActive(true);
    hud.setCameraFocusState(runtime.camera?.currentMode || 'pov', targetIndex);

    this._syncCarEntriesFromConfig();
    runtime.arena?.nameTagSystem?.update?.(runtime.arena, 6, runtime.camera?.camera);
  }

  reshuffleKickoffPositions() {
    if (!this.isActive) {
      this.enterTunerArena();
      return;
    }
    this.permutationIndex =
      (this.permutationIndex + 1) % SIX_CAR_KICKOFF_PERMUTATIONS.length;
    this._spawnSixKickoffCars();
    if (!this.runtime?.camera?.isFreeCam) {
      this.runtime?.camera?.resetView?.();
    }
    this._syncCarEntriesFromConfig();
    this.runtime?.arena?.nameTagSystem?.update?.(
      this.runtime.arena,
      6,
      this.runtime.camera?.camera
    );
  }

  _spawnSixKickoffCars() {
    const runtime = this.runtime;
    const physicsEngine = runtime?.physics;
    if (!physicsEngine) return;

    while (physicsEngine.numCars > 6 && typeof physicsEngine.removeCar === 'function') {
      physicsEngine.removeCar(physicsEngine.numCars - 1);
    }
    while (physicsEngine.numCars < 6 && typeof physicsEngine.addCar === 'function') {
      const carIndex = physicsEngine.numCars;
      const team = carIndex < 3 ? 0 : 1;
      physicsEngine.addCar(team, runtime.selectedPreset || 'octane');
    }

    const slotTriple =
      SIX_CAR_KICKOFF_PERMUTATIONS[
        this.permutationIndex % SIX_CAR_KICKOFF_PERMUTATIONS.length
      ];

    for (let carIndex = 0; carIndex < 6; carIndex++) {
      const team = carIndex < 3 ? 0 : 1;
      const teamSlotIndex = carIndex % 3;
      const presetIndex = slotTriple[teamSlotIndex] ?? teamSlotIndex;
      const preset = KICKOFF_SPAWN_PRESETS[presetIndex] || KICKOFF_SPAWN_PRESETS[0];
      const spawnCoord = team === 0 ? preset.team0 : preset.team1;
      const cosYaw = Math.cos(spawnCoord.yaw);
      const sinYaw = Math.sin(spawnCoord.yaw);

      physicsEngine.setCarTeam?.(carIndex, team);
      physicsEngine.setCarState(carIndex, {
        pos: [spawnCoord.x, spawnCoord.y, spawnCoord.z],
        vel: [0, 0, 0],
        angVel: [0, 0, 0],
        rot: [0, spawnCoord.yaw, 0],
        fwd: [cosYaw, sinYaw, 0],
        right: [-sinYaw, cosYaw, 0],
        up: [0, 0, 1],
        isOnGround: true,
        isSupersonic: false,
        isDemoed: false,
        hasFlipOrJump: true,
        isBoosting: false,
        isFlipping: false,
        boost: 100,
      });

      if (runtime.arena) {
        runtime.arena.ensureCar?.(carIndex, team, runtime.arena.carVisual || 'fennec');
        runtime.arena.setCarTeam?.(carIndex, team);
        const colorHex =
          team === 0
            ? TEAM_BLUE_COLORS[teamSlotIndex % TEAM_BLUE_COLORS.length]
            : TEAM_ORANGE_COLORS[teamSlotIndex % TEAM_ORANGE_COLORS.length];
        runtime.arena.setCarColor?.(carIndex, colorHex);
        if (runtime.arena.cars?.[carIndex]) {
          runtime.arena.cars[carIndex].visible = true;
        }
      }
    }

    physicsEngine.setBallState({
      pos: [0, 0, 93.15],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
    });

    const neutralControls = {
      throttle: 0,
      steer: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      jump: false,
      boost: false,
      handbrake: true,
    };
    for (let stepIndex = 0; stepIndex < 30; stepIndex++) {
      for (let carIndex = 0; carIndex < 6; carIndex++) {
        physicsEngine.setControls?.(carIndex, neutralControls);
      }
      physicsEngine.step(1 / 120);
    }

    runtime.interpolator?.sync?.();
  }

  onBeforePhysicsTick() {
    if (!this.isActive) return;
    const physicsEngine = this.runtime?.physics;
    if (!physicsEngine) return;
    const neutralHold = {
      throttle: 0,
      steer: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      jump: false,
      boost: false,
      handbrake: true,
    };
    const activePlayerIndex = this.runtime?.playerCarIndex ?? 0;
    for (
      let carIndex = 0;
      carIndex < Math.min(6, physicsEngine.numCars || 0);
      carIndex++
    ) {
      if (carIndex !== activePlayerIndex) {
        physicsEngine.setControls?.(carIndex, neutralHold);
      }
    }
  }

  exitTunerArena() {
    const runtime = this.runtime;
    const physicsEngine = runtime?.physics;
    this.isActive = false;
    this.focusedCarIndex = 0;
    this._unbindPovHotkeys();

    if (runtime) {
      runtime.playerCarIndex = 0;
      if (runtime.keyboard && runtime.match?.state?.mode === 'freeplay') {
        runtime.keyboard.ballControlEnabled = true;
      }
    }

    if (physicsEngine) {
      while (physicsEngine.numCars > 1 && typeof physicsEngine.removeCar === 'function') {
        physicsEngine.removeCar(physicsEngine.numCars - 1);
      }
    }
    if (runtime?.arena) {
      runtime.arena.playerCarIndex = 0;
      runtime.arena.focusedCarIndex = 0;
      runtime.arena.isFreeCam = false;
      runtime.arena.cameraMode = 'pov';
      runtime.arena.isPovCamera = true;
      if (runtime.arena.cars) {
        for (let carIndex = 1; carIndex < runtime.arena.cars.length; carIndex++) {
          if (runtime.arena.cars[carIndex]) {
            runtime.arena.cars[carIndex].visible = false;
          }
        }
      }
    }

    if (runtime?.camera) {
      runtime.camera.setFocusedCarIndex?.(0);
      runtime.camera.setFreeCam?.(false);
      runtime.camera.resetView?.();
    }
    useAppStore.getState().setFreeCam(false);
    hudStore.getState().setCameraFocusState('pov', 0);

    setNameTagRuntimeState({
      isTunerArenaActive: false,
      activeCameraMode: 'pov',
      focusedCarIndex: 0,
      carEntries: [],
    });

    runtime?.interpolator?.sync?.();
  }
}
