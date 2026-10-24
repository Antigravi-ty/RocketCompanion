/**
 * NameTagTunerArenaController.js
 * Manages the 6-car kickoff stadium evaluation environment for the Name Tag Active Tuner.
 * Does NOT enter the arena until the user explicitly clicks "Enter Arena & Spawn 6 Kickoff Cars".
 */

import { KICKOFF_SPAWN_PRESETS } from '../../network/MatchRosterCoordinator.js';
import {
  getNameTagConfig,
  setNameTagRuntimeState,
  subscribeNameTagConfig,
} from '../../config/nameTagConfig.ts';
import { useAppStore } from '../../stores/appStore';

// 10 distinct 3-of-5 kickoff slot combinations for 3v3 kickoff evaluation
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

export class NameTagTunerArenaController {
  constructor(runtime) {
    this.runtime = runtime;
    this.isActive = false;
    this.permutationIndex = 0;
    this._unsubConfig = null;
  }

  attach() {
    setNameTagRuntimeState({
      onEnterTunerArena: () => this.enterTunerArena(),
      onExitTunerArena: () => this.exitTunerArena(),
      onReshuffleKickoffPositions: () => this.reshuffleKickoffPositions(),
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
    if (this.isActive) {
      this.exitTunerArena();
    }
  }

  _syncCarEntriesFromConfig() {
    const cfg = getNameTagConfig();
    const entries = [];
    for (let i = 0; i < 6; i++) {
      entries.push({
        carIndex: i,
        name: cfg.previewNames?.[i] || `Player ${i + 1}`,
        team: i < 3 ? 0 : 1,
      });
    }
    setNameTagRuntimeState({
      isTunerArenaActive: this.isActive,
      kickoffPermutationIndex: this.permutationIndex,
      carEntries: entries,
    });
  }

  async enterTunerArena() {
    const r = this.runtime;
    if (!r?.physics) return;

    // Close menu overlay if open so the 3D stadium is visible behind the floating window
    const appState = useAppStore.getState();
    if (appState.isOpen) {
      appState.closeMenu();
    }

    // Ensure we are in freeplay mode
    if (r.match?.state && r.match.state.mode !== 'freeplay') {
      r.match.state.mode = 'freeplay';
      r.match.state.phase = 'playing';
      appState.setMatchMode('freeplay');
      r.modeManager?.setMode?.('freeplay');
    }

    await r.arena?.ensureOpponent?.();

    this.isActive = true;
    this._spawnSixKickoffCars();
    this._syncCarEntriesFromConfig();

    // Position Free Camera overlooking midfield so all 6 kickoff cars & name tags are visible
    if (r.camera) {
      if (typeof r.camera.setFreeCamPose === 'function') {
        r.camera.setFreeCamPose([-1950, 720, -2600], [0, 80, 0]);
      } else {
        r.camera.setFreeCam?.(true);
      }
      appState.setFreeCam(true);
    }

    r.arena?.nameTagSystem?.update?.(r.arena, 6, r.camera?.camera);
  }

  reshuffleKickoffPositions() {
    if (!this.isActive) {
      this.enterTunerArena();
      return;
    }
    this.permutationIndex =
      (this.permutationIndex + 1) % SIX_CAR_KICKOFF_PERMUTATIONS.length;
    this._spawnSixKickoffCars();
    this._syncCarEntriesFromConfig();
  }

  _spawnSixKickoffCars() {
    const r = this.runtime;
    const sim = r?.physics;
    if (!sim) return;

    while (sim.numCars > 6 && typeof sim.removeCar === 'function') {
      sim.removeCar(sim.numCars - 1);
    }
    while (sim.numCars < 6 && typeof sim.addCar === 'function') {
      const idx = sim.numCars;
      const team = idx < 3 ? 0 : 1;
      sim.addCar(team, r.selectedPreset || 'octane');
    }

    const slotTriple =
      SIX_CAR_KICKOFF_PERMUTATIONS[
        this.permutationIndex % SIX_CAR_KICKOFF_PERMUTATIONS.length
      ];

    for (let i = 0; i < 6; i++) {
      const team = i < 3 ? 0 : 1;
      const teamSlotIdx = i % 3;
      const presetIdx = slotTriple[teamSlotIdx] ?? teamSlotIdx;
      const preset = KICKOFF_SPAWN_PRESETS[presetIdx] || KICKOFF_SPAWN_PRESETS[0];
      const coord = team === 0 ? preset.team0 : preset.team1;
      const cy = Math.cos(coord.yaw);
      const sy = Math.sin(coord.yaw);

      sim.setCarTeam?.(i, team);
      sim.setCarState(i, {
        pos: [coord.x, coord.y, coord.z],
        vel: [0, 0, 0],
        angVel: [0, 0, 0],
        rot: [0, coord.yaw, 0],
        fwd: [cy, sy, 0],
        right: [-sy, cy, 0],
        up: [0, 0, 1],
        isOnGround: true,
        isSupersonic: false,
        isDemoed: false,
        hasFlipOrJump: true,
        isBoosting: false,
        isFlipping: false,
        boost: 100,
      });

      if (r.arena) {
        r.arena.ensureCar?.(i, team, r.arena.carVisual || 'fennec');
        r.arena.setCarTeam?.(i, team);
        const colorHex =
          team === 0
            ? TEAM_BLUE_COLORS[teamSlotIdx % TEAM_BLUE_COLORS.length]
            : TEAM_ORANGE_COLORS[teamSlotIdx % TEAM_ORANGE_COLORS.length];
        r.arena.setCarColor?.(i, colorHex);
        if (r.arena.cars?.[i]) {
          r.arena.cars[i].visible = true;
        }
      }
    }

    sim.setBallState({
      pos: [0, 0, 93.15],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
    });

    // Settle suspension on ground
    const neutral = {
      throttle: 0,
      steer: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      jump: false,
      boost: false,
      handbrake: true,
    };
    for (let step = 0; step < 30; step++) {
      for (let i = 0; i < 6; i++) {
        sim.setControls?.(i, neutral);
      }
      sim.step(1 / 120);
    }

    r.interpolator?.sync?.();
  }

  onBeforePhysicsTick() {
    if (!this.isActive) return;
    const sim = this.runtime?.physics;
    if (!sim) return;
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
    // Keep cars 1..5 stationary on their kickoff spots
    for (let i = 1; i < Math.min(6, sim.numCars || 0); i++) {
      sim.setControls?.(i, neutralHold);
    }
  }

  exitTunerArena() {
    const r = this.runtime;
    const sim = r?.physics;
    this.isActive = false;

    if (sim) {
      while (sim.numCars > 1 && typeof sim.removeCar === 'function') {
        sim.removeCar(sim.numCars - 1);
      }
    }
    if (r?.arena?.cars) {
      for (let i = 1; i < r.arena.cars.length; i++) {
        if (r.arena.cars[i]) {
          r.arena.cars[i].visible = false;
        }
      }
    }

    setNameTagRuntimeState({
      isTunerArenaActive: false,
      carEntries: [],
    });

    r?.interpolator?.sync?.();
  }
}
