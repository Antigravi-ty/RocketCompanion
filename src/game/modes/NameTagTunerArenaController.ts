/**
 * NameTagTunerArenaController.ts
 * Manages the 6-car kickoff stadium evaluation environment for the Name Tag Active Tuner.
 * Does NOT enter the arena until the user explicitly clicks "Enter Arena & Spawn 6 Kickoff Cars".
 */

import type * as THREE from 'three';
import { KICKOFF_SPAWN_PRESETS } from '../../physics/RocketSimConstants.ts';
import {
  type NameTagCameraMode,
  type NameTagCarEntry,
} from '../../ui-core/config/nameTagConfig';
import {
  getNameTagConfig,
  hudStore,
  setNameTagRuntimeState,
  subscribeNameTagConfig,
  useAppStore,
} from '../runtimeUiPort.ts';
import {
  isEditableEventTarget,
  subscribeGlobalKeyDown,
} from '../../input/hotkeyInputGuard.ts';

const SIX_CAR_KICKOFF_PERMUTATIONS: readonly (readonly [number, number, number])[] = [
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
const OVERVIEW_FREECAM_POSITION: [number, number, number] = [-1950, 720, -2600];
const OVERVIEW_FREECAM_TARGET: [number, number, number] = [0, 80, 0];

interface EditableDomTarget {
  isContentEditable?: boolean;
  tagName?: string;
  type?: string;
}

function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as EditableDomTarget;
  if (el.isContentEditable) return true;
  const tagName = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  if (tagName === 'INPUT') {
    const inputType = String(el.type || 'text').toLowerCase();
    return ![
      'range',
      'checkbox',
      'radio',
      'button',
      'submit',
      'reset',
      'color',
    ].includes(inputType);
  }
  return false;
}

export interface NameTagTunerRuntimeHost {
  playerCarIndex?: number;
  selectedPreset?: string;
  physics?: {
    numCars: number;
    removeCar?: (carIndex: number) => void;
    addCar?: (team: number, preset: string) => void;
    setCarTeam?: (carIndex: number, team: number) => void;
    setCarState: (carIndex: number, state: Record<string, unknown>) => void;
    setBallState: (state: Record<string, unknown>) => void;
    setControls?: (carIndex: number, controls: Record<string, unknown>) => void;
    step: (dt: number) => void;
  };
  match?: {
    state?: {
      mode?: string;
      phase?: string;
    };
  };
  modeManager?: {
    setMode?: (mode: string) => void;
  };
  keyboard?: {
    ballControlEnabled?: boolean;
  };
  interpolator?: {
    sync?: () => void;
  };
  camera?: {
    camera?: THREE.PerspectiveCamera | null;
    isFreeCam?: boolean;
    currentMode?: NameTagCameraMode;
    ballCam?: boolean;
    setFreeCamPose?: (
      pos: [number, number, number],
      target: [number, number, number]
    ) => void;
    setFreeCam?: (enabled: boolean) => void;
    setFocusedCarIndex?: (carIndex: number) => void;
    resetView?: () => void;
  };
  arena?: {
    cars?: Array<THREE.Object3D | null | undefined>;
    carBoostAmounts?: Float32Array | number[];
    carVisual?: string;
    playerCarIndex?: number;
    focusedCarIndex?: number;
    isFreeCam?: boolean;
    cameraMode?: string;
    isPovCamera?: boolean;
    ensureOpponent?: () => Promise<void>;
    ensureCar?: (carIndex: number, team: number, visual: string) => void;
    setCarTeam?: (carIndex: number, team: number) => void;
    setCarColor?: (carIndex: number, colorHex: number) => void;
    nameTagSystem?: {
      update?: (
        arena: unknown,
        numCars?: number,
        camera?: THREE.PerspectiveCamera | null
      ) => void;
    };
  };
}

export class NameTagTunerArenaController {
  public runtime: NameTagTunerRuntimeHost;
  public isActive = false;
  public permutationIndex = 0;
  public focusedCarIndex = 0;
  private _unsubConfig: (() => void) | null = null;
  private _unsubKeyDown: (() => void) | null = null;
  private _keyDownHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(runtime: NameTagTunerRuntimeHost) {
    this.runtime = runtime;
  }

  public attach(): void {
    setNameTagRuntimeState({
      onEnterTunerArena: () => {
        void this.enterTunerArena();
      },
      onExitTunerArena: () => this.exitTunerArena(),
      onReshuffleKickoffPositions: () => this.reshuffleKickoffPositions(),
      onSelectPovCar: (carIndex: number) => {
        void this.focusCarPov(carIndex);
      },
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

  public detach(): void {
    this._unbindPovHotkeys();
    if (this.isActive) {
      this.exitTunerArena();
    }
  }

  private _bindPovHotkeys(): void {
    this._unbindPovHotkeys();
    if (typeof window === 'undefined') return;

    this._keyDownHandler = (event: KeyboardEvent) => {
      if (!this.isActive) return;
      if (this.runtime?.match?.state?.mode !== 'freeplay') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableEventTarget(event)) return;
      const activeElement =
        typeof document !== 'undefined' ? document.activeElement : null;
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
        void this.focusCarPov(keyNumber - 1);
        return;
      }

      if (
        event.code === 'Digit0' ||
        event.code === 'Numpad0' ||
        event.code === 'Backquote'
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.focusFreeCamOverview();
      }
    };

    this._unsubKeyDown = subscribeGlobalKeyDown(this._keyDownHandler, true);
  }

  private _unbindPovHotkeys(): void {
    this._unsubKeyDown?.();
    this._unsubKeyDown = null;
    this._keyDownHandler = null;
  }

  public _syncCarEntriesFromConfig(): void {
    const config = getNameTagConfig();
    const entries: NameTagCarEntry[] = [];
    for (let carIndex = 0; carIndex < 6; carIndex++) {
      const sampleBoost = config.previewBoostAmounts?.[carIndex] ?? 100;
      entries.push({
        carIndex,
        name: config.previewNames?.[carIndex] || `Player ${carIndex + 1}`,
        team: carIndex < 3 ? 0 : 1,
        boostAmount: sampleBoost,
      });
      if (this.runtime?.arena?.carBoostAmounts) {
        this.runtime.arena.carBoostAmounts[carIndex] = sampleBoost;
      }
    }
    const cameraMode: NameTagCameraMode = this.runtime?.camera?.isFreeCam
      ? 'free'
      : this.runtime?.camera?.currentMode || 'pov';
    setNameTagRuntimeState({
      isTunerArenaActive: this.isActive,
      kickoffPermutationIndex: this.permutationIndex,
      activeCameraMode: cameraMode,
      focusedCarIndex: this.focusedCarIndex,
      carEntries: entries,
    });
  }

  public async enterTunerArena(): Promise<void> {
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

  public focusFreeCamOverview(): void {
    const runtime = this.runtime;
    if (!runtime) return;

    const appState = useAppStore.getState();
    if (runtime.camera) {
      if (typeof runtime.camera.setFreeCamPose === 'function') {
        runtime.camera.setFreeCamPose(
          OVERVIEW_FREECAM_POSITION,
          OVERVIEW_FREECAM_TARGET
        );
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

  public async focusCarPov(carIndex = 0): Promise<void> {
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

  public reshuffleKickoffPositions(): void {
    if (!this.isActive) {
      void this.enterTunerArena();
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

  public _spawnSixKickoffCars(): void {
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

    const config = getNameTagConfig();
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
      const sampleBoost = config.previewBoostAmounts?.[carIndex] ?? 100;

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
        boost: sampleBoost,
      });

      if (runtime.arena) {
        runtime.arena.ensureCar?.(
          carIndex,
          team,
          runtime.arena.carVisual || 'fennec'
        );
        runtime.arena.setCarTeam?.(carIndex, team);
        const colorHex =
          team === 0
            ? TEAM_BLUE_COLORS[teamSlotIndex % TEAM_BLUE_COLORS.length]
            : TEAM_ORANGE_COLORS[teamSlotIndex % TEAM_ORANGE_COLORS.length];
        runtime.arena.setCarColor?.(carIndex, colorHex);
        const carMesh = runtime.arena.cars?.[carIndex];
        if (carMesh) {
          carMesh.visible = true;
        }
        if (runtime.arena.carBoostAmounts) {
          runtime.arena.carBoostAmounts[carIndex] = sampleBoost;
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

  public onBeforePhysicsTick(): void {
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

  public exitTunerArena(): void {
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
          const carMesh = runtime.arena.cars[carIndex];
          if (carMesh) {
            carMesh.visible = false;
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
