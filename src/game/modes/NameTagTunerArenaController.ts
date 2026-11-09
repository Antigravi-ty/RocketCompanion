/**
 * NameTagTunerArenaController.ts
 * Self-contained domain controller managing the 6-car kickoff stadium evaluation
 * environment for the Name Tag Active Tuner.
 */

import type * as THREE from 'three';
import { type NameTagCameraMode } from '../../ui-core/config/nameTagConfig.ts';
import {
  getNameTagConfig,
  hudStore,
  setNameTagRuntimeState,
  subscribeNameTagConfig,
  useAppStore,
} from '../runtimeUiPort.ts';
import { isEditableEventTarget, subscribeGlobalKeyDown } from '../../input/hotkeyInputGuard.ts';
import {
  NEUTRAL_HOLD_CONTROLS,
  OVERVIEW_FREECAM_POSITION,
  OVERVIEW_FREECAM_TARGET,
  SIX_CAR_KICKOFF_PERMUTATIONS,
  buildNameTagCarEntriesFromConfig,
  buildSixCarKickoffSpawnSpecs,
  isEditableTunerDomTarget,
} from './freeplay/nameTagTunerPipeline.ts';

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
    setFreeCamPose?: (pos: [number, number, number], target: [number, number, number]) => void;
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
      update?: (arena: unknown, numCars?: number, camera?: THREE.PerspectiveCamera | null) => void;
    };
  };
}

export class NameTagTunerArenaController {
  private _sceneTarget: NameTagTunerRuntimeHost | null;
  public isActive = false;
  public permutationIndex = 0;
  public focusedCarIndex = 0;
  private _unsubConfig: (() => void) | null = null;
  private _unsubKeyDown: (() => void) | null = null;
  private _keyDownHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(sceneTarget: NameTagTunerRuntimeHost | null) {
    this._sceneTarget = sceneTarget;
  }

  public get runtime(): NameTagTunerRuntimeHost | null {
    return this._sceneTarget;
  }

  public set runtime(nextTarget: NameTagTunerRuntimeHost | null) {
    this._sceneTarget = nextTarget;
  }

  public attach(): void {
    const handleEnterTunerArena = (): void => {
      void this.enterTunerArena();
    };
    const handleExitTunerArena = (): void => this.exitTunerArena();
    const handleReshuffleKickoff = (): void => this.reshuffleKickoffPositions();
    const handleSelectPovCar = (carIndex: number): void => {
      void this.focusCarPov(carIndex);
    };
    const handleFocusFreeCamOverview = (): void => this.focusFreeCamOverview();

    setNameTagRuntimeState({
      onEnterTunerArena: handleEnterTunerArena,
      onExitTunerArena: handleExitTunerArena,
      onReshuffleKickoffPositions: handleReshuffleKickoff,
      onSelectPovCar: handleSelectPovCar,
      onFocusFreeCamOverview: handleFocusFreeCamOverview,
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
      if (this._sceneTarget?.match?.state?.mode !== 'freeplay') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableEventTarget(event)) return;
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
      if (isEditableTunerDomTarget(event.target) || isEditableTunerDomTarget(activeElement)) return;

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

      if (event.code === 'Digit0' || event.code === 'Numpad0' || event.code === 'Backquote') {
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
    const entries = buildNameTagCarEntriesFromConfig(config);
    const boostAmounts = this._sceneTarget?.arena?.carBoostAmounts;
    if (boostAmounts) {
      for (let i = 0; i < entries.length; i++) {
        boostAmounts[i] = entries[i].boostAmount ?? 0;
      }
    }
    const cam = this._sceneTarget?.camera;
    const cameraMode: NameTagCameraMode = cam?.isFreeCam ? 'free' : cam?.currentMode || 'pov';
    setNameTagRuntimeState({
      isTunerArenaActive: this.isActive,
      kickoffPermutationIndex: this.permutationIndex,
      activeCameraMode: cameraMode,
      focusedCarIndex: this.focusedCarIndex,
      carEntries: entries,
    });
  }

  public async enterTunerArena(): Promise<void> {
    const scene = this._sceneTarget;
    if (!scene?.physics) return;

    const appState = useAppStore.getState();
    if (appState.isOpen) {
      appState.closeMenu();
    }

    const matchState = scene.match?.state;
    if (matchState && matchState.mode !== 'freeplay') {
      matchState.mode = 'freeplay';
      matchState.phase = 'playing';
      appState.setMatchMode('freeplay');
      scene.modeManager?.setMode?.('freeplay');
    }

    await scene.arena?.ensureOpponent?.();

    this.isActive = true;
    if (scene.keyboard) {
      scene.keyboard.ballControlEnabled = false;
    }
    this._bindPovHotkeys();
    this._spawnSixKickoffCars();
    this.focusFreeCamOverview();
  }

  public focusFreeCamOverview(): void {
    const scene = this._sceneTarget;
    if (!scene) return;

    const { camera, arena } = scene;
    const appState = useAppStore.getState();
    if (camera) {
      if (typeof camera.setFreeCamPose === 'function') {
        camera.setFreeCamPose(OVERVIEW_FREECAM_POSITION, OVERVIEW_FREECAM_TARGET);
      } else {
        camera.setFreeCam?.(true);
      }
      appState.setFreeCam(true);
    }

    if (arena) {
      arena.isFreeCam = true;
      arena.cameraMode = 'free';
      arena.isPovCamera = false;
      arena.focusedCarIndex = this.focusedCarIndex;
    }

    hudStore.getState().setCameraFocusState('free', this.focusedCarIndex);
    this._syncCarEntriesFromConfig();
    arena?.nameTagSystem?.update?.(arena, 6, camera?.camera);
  }

  public async focusCarPov(carIndex = 0): Promise<void> {
    if (!this.isActive) {
      await this.enterTunerArena();
    }
    const scene = this._sceneTarget;
    if (!scene) return;

    const targetIndex = Math.max(0, Math.min(5, Math.round(Number(carIndex) || 0)));
    this.focusedCarIndex = targetIndex;
    scene.playerCarIndex = targetIndex;

    const { arena, camera } = scene;
    if (arena) {
      arena.playerCarIndex = targetIndex;
      arena.focusedCarIndex = targetIndex;
      arena.isFreeCam = false;
      arena.cameraMode = 'pov';
      arena.isPovCamera = true;
    }

    if (camera) {
      camera.setFocusedCarIndex?.(targetIndex);
      camera.setFreeCam?.(false);
      camera.ballCam = true;
      camera.resetView?.();
    }

    useAppStore.getState().setFreeCam(false);
    const hud = hudStore.getState();
    hud.setBallCamActive(true);
    hud.setCameraFocusState(camera?.currentMode || 'pov', targetIndex);

    this._syncCarEntriesFromConfig();
    arena?.nameTagSystem?.update?.(arena, 6, camera?.camera);
  }

  public reshuffleKickoffPositions(): void {
    if (!this.isActive) {
      void this.enterTunerArena();
      return;
    }
    this.permutationIndex = (this.permutationIndex + 1) % SIX_CAR_KICKOFF_PERMUTATIONS.length;
    this._spawnSixKickoffCars();
    const scene = this._sceneTarget;
    if (!scene?.camera?.isFreeCam) {
      scene?.camera?.resetView?.();
    }
    this._syncCarEntriesFromConfig();
    scene?.arena?.nameTagSystem?.update?.(scene.arena, 6, scene.camera?.camera);
  }

  public _spawnSixKickoffCars(): void {
    const scene = this._sceneTarget;
    const sim = scene?.physics;
    if (!sim || !scene) return;

    while (sim.numCars > 6 && typeof sim.removeCar === 'function') {
      sim.removeCar(sim.numCars - 1);
    }
    while (sim.numCars < 6 && typeof sim.addCar === 'function') {
      const carIndex = sim.numCars;
      const team = carIndex < 3 ? 0 : 1;
      sim.addCar(team, scene.selectedPreset || 'octane');
    }

    const specs = buildSixCarKickoffSpawnSpecs(this.permutationIndex, getNameTagConfig());
    const arena = scene.arena;

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      sim.setCarTeam?.(spec.carIndex, spec.team);
      sim.setCarState(spec.carIndex, spec.carState);

      if (arena) {
        arena.ensureCar?.(spec.carIndex, spec.team, arena.carVisual || 'fennec');
        arena.setCarTeam?.(spec.carIndex, spec.team);
        arena.setCarColor?.(spec.carIndex, spec.colorHex);
        const carMesh = arena.cars?.[spec.carIndex];
        if (carMesh) {
          carMesh.visible = true;
        }
        if (arena.carBoostAmounts) {
          arena.carBoostAmounts[spec.carIndex] = spec.sampleBoost;
        }
      }
    }

    sim.setBallState({
      pos: [0, 0, 93.15],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
    });

    for (let stepIndex = 0; stepIndex < 30; stepIndex++) {
      for (let carIndex = 0; carIndex < 6; carIndex++) {
        sim.setControls?.(carIndex, NEUTRAL_HOLD_CONTROLS);
      }
      sim.step(1 / 120);
    }

    scene.interpolator?.sync?.();
  }

  public onBeforePhysicsTick(): void {
    if (!this.isActive) return;
    const scene = this._sceneTarget;
    const sim = scene?.physics;
    if (!sim) return;
    const activePlayerIndex = scene?.playerCarIndex ?? 0;
    for (let carIndex = 0; carIndex < Math.min(6, sim.numCars || 0); carIndex++) {
      if (carIndex !== activePlayerIndex) {
        sim.setControls?.(carIndex, NEUTRAL_HOLD_CONTROLS);
      }
    }
  }

  public exitTunerArena(): void {
    const scene = this._sceneTarget;
    const sim = scene?.physics;
    this.isActive = false;
    this.focusedCarIndex = 0;
    this._unbindPovHotkeys();

    if (scene) {
      scene.playerCarIndex = 0;
      if (scene.keyboard && scene.match?.state?.mode === 'freeplay') {
        scene.keyboard.ballControlEnabled = true;
      }
    }

    if (sim) {
      while (sim.numCars > 1 && typeof sim.removeCar === 'function') {
        sim.removeCar(sim.numCars - 1);
      }
    }
    const arena = scene?.arena;
    if (arena) {
      arena.playerCarIndex = 0;
      arena.focusedCarIndex = 0;
      arena.isFreeCam = false;
      arena.cameraMode = 'pov';
      arena.isPovCamera = true;
      if (arena.cars) {
        for (let carIndex = 1; carIndex < arena.cars.length; carIndex++) {
          const carMesh = arena.cars[carIndex];
          if (carMesh) {
            carMesh.visible = false;
          }
        }
      }
    }

    const camera = scene?.camera;
    if (camera) {
      camera.setFocusedCarIndex?.(0);
      camera.setFreeCam?.(false);
      camera.resetView?.();
    }
    useAppStore.getState().setFreeCam(false);
    hudStore.getState().setCameraFocusState('pov', 0);

    setNameTagRuntimeState({
      isTunerArenaActive: false,
      activeCameraMode: 'pov',
      focusedCarIndex: 0,
      carEntries: [],
    });

    scene?.interpolator?.sync?.();
  }
}
