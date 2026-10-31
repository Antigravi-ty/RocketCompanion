/**
 * SubsystemIsolationLabDemolishRespawnHelper.js
 * Isolated Bench 7 ('demolish-respawn') for the Developer Subsystem Isolation Lab.
 * Allows developers to directly test and inspect:
 * - Demolition explosion & RespawnGhostPreview rendering (chassis + wheel suspension height/placement)
 * - Left-handed RocketSim coordinate handedness for Left / Right spawn selection (A / D or UI buttons)
 * - Blue (Team 0, Y = -4608, facing +Y) vs Orange (Team 1, Y = +4608, facing -Y) spawn slots 0..3
 * - Timer freeze / hold mode for inspecting ghost wheel placement and camera framing without needing a second device
 * - Obstacle car conflict fallback testing on the selected respawn slot
 */

import {
  RESPAWN_SPAWN_PRESETS,
  CAR_STATE_STRIDE,
  SIM_OFFSETS,
} from '../../../physics/RocketSimConstants.js';
import { DEFAULT_CAR_CONTROLS } from '../../../ai/experimental/ExperimentalBotAgent.js';
import { useSubsystemIsolationLabStore } from '../../../ui-core/stores/subsystemIsolationLabStore';
import { hudStore } from '../../../ui-core/stores/hudStore';

function getSlotPresetCoords(team, slotIndex) {
  const safeSlot = slotIndex >= 0 && slotIndex < RESPAWN_SPAWN_PRESETS.length ? slotIndex : 0;
  const preset = RESPAWN_SPAWN_PRESETS[safeSlot] || RESPAWN_SPAWN_PRESETS[0];
  const coords = team === 1 ? preset.team1 : preset.team0;
  return {
    slotIndex: safeSlot,
    label: preset.label,
    x: coords.x,
    y: coords.y,
    z: coords.z,
    yaw: coords.yaw,
  };
}

export function setupDemolishRespawnBench(lab) {
  const r = lab.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();

  const team = store.demolishRespawnTeam ?? 0;
  const visualId = store.demolishRespawnVisualId || 'octane';

  // Ensure car 0 (test subject) and car 1 (optional obstacle dummy) exist
  while (r.physics.numCars > 2 && typeof r.physics.removeCar === 'function') {
    r.physics.removeCar(r.physics.numCars - 1);
  }
  if (r.physics.numCars < 1 && typeof r.physics.addCar === 'function') {
    r.physics.addCar(team, visualId);
  }
  if (r.physics.numCars < 2 && typeof r.physics.addCar === 'function') {
    r.physics.addCar(team === 0 ? 1 : 0, 'octane');
  }

  r.playerCarIndex = 0;
  if (r.arena) {
    r.arena.playerCarIndex = 0;
    r.arena.setCarTeam?.(0, team);
    r.arena.setCarVisual?.(0, visualId);
    if (r.arena.cars?.[0]) r.arena.cars[0].visible = true;
    if (r.arena.cars?.[1]) {
      r.arena.setCarTeam?.(1, team === 0 ? 1 : 0);
      r.arena.cars[1].visible = Boolean(store.demolishRespawnObstacleEnabled);
    }
  }

  // Park ball out of the way in midfield
  r.physics.setBallState?.(0, 0, 93.15, 0, 0, 0, 0, 0, 0);

  // Place Car 0 in front of its team's goal area
  const startCoords = getSlotPresetCoords(team, 1);
  r.physics.respawnCarAtPreset?.(0, team, 1);
  syncDummyObstacleCar(lab, store);

  lab.demolishRespawnRuntime = {
    prevSteerSign: 0,
    syntheticSteerPulseTicks: 0,
    syntheticSteerValue: 0,
    lastKnownDemoState: false,
  };

  if (store.demolishRespawnAutoHoldDemo) {
    triggerDemolishInBench(lab);
  } else {
    syncDemolishRespawnTelemetry(lab);
  }

  r.interpolator?.sync?.();
  r.camera?.resetView?.();
}

export function syncDummyObstacleCar(lab, store = useSubsystemIsolationLabStore.getState()) {
  const r = lab.runtime;
  if (!r?.physics || r.physics.numCars < 2) return;

  const enabled = Boolean(store.demolishRespawnObstacleEnabled);
  const team = store.demolishRespawnTeam ?? 0;
  const obstacleSlot = Math.max(0, Math.min(3, store.demolishRespawnObstacleSlot ?? 0));

  if (r.arena?.cars?.[1]) {
    r.arena.cars[1].visible = enabled;
    r.arena.setCarTeam?.(1, team === 0 ? 1 : 0);
  }

  if (enabled) {
    const coords = getSlotPresetCoords(team, obstacleSlot);
    r.physics.setCarState?.(
      1,
      coords.x,
      coords.y,
      coords.z,
      0,
      0,
      0,
      0,
      coords.yaw,
      0,
      0,
      0,
      0
    );
    r.physics.setControls?.(1, { ...DEFAULT_CAR_CONTROLS, handbrake: true });
  } else {
    // Park car 1 far away on the opposite side of the field
    const oppY = team === 0 ? 3800 : -3800;
    r.physics.setCarState?.(1, 3200, oppY, 17.01, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    r.physics.setControls?.(1, DEFAULT_CAR_CONTROLS);
  }
}

export function triggerDemolishInBench(lab) {
  const r = lab.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();
  const team = store.demolishRespawnTeam ?? 0;

  if (r.arena) {
    r.arena.setCarTeam?.(0, team);
    if (store.demolishRespawnVisualId) {
      r.arena.setCarVisual?.(0, store.demolishRespawnVisualId);
    }
  }

  const timerSec = Math.max(0.5, Math.min(10.0, store.demolishRespawnTimerDurationSec ?? 3.0));
  r.physics.demolishCar?.(0, timerSec);

  if (store.demolishRespawnSelectedSlot >= 0 && store.demolishRespawnSelectedSlot <= 3) {
    r.physics.setCarRespawnSelection?.(0, store.demolishRespawnSelectedSlot);
  } else {
    r.physics.setCarRespawnSelection?.(0, -1);
  }

  syncDummyObstacleCar(lab, store);
  r.interpolator?.sync?.();
  syncDemolishRespawnTelemetry(lab);
}

export function forceRespawnNowInBench(lab) {
  const r = lab.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();
  const team = store.demolishRespawnTeam ?? 0;
  const selectedSlot = r.physics.getCarRespawnSelection?.(0) ?? store.demolishRespawnSelectedSlot ?? -1;

  if (r.physics.isCarDemolished?.(0)) {
    // Setting timer to a tiny value lets RocketSim's native DemoTimer reach 0 on the next tick,
    // exercising the exact C++/WASM conflict check and respawn slot logic.
    r.physics.demolishCar?.(0, 1 / 120);
    r.physics.setCarRespawnSelection?.(0, selectedSlot);
  } else {
    const slotToUse = selectedSlot >= 0 ? selectedSlot : 0;
    r.physics.respawnCarAtPreset?.(0, team, slotToUse);
  }

  r.interpolator?.sync?.();
  syncDemolishRespawnTelemetry(lab);
}

export function simulateDemolishSteerEdgeInBench(lab, direction) {
  const r = lab.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();

  // Ensure the car is demolished so the ghost & selection state machine can be observed immediately
  if (!r.physics.isCarDemolished?.(0)) {
    triggerDemolishInBench(lab);
  }

  // Replicate exact rising-edge selection state machine:
  // First Left (-1) -> Inner Left (1), Second Left (-1) -> Far Left (0)
  // First Right (+1) -> Inner Right (2), Second Right (+1) -> Far Right (3)
  const currentSel = r.physics.getCarRespawnSelection?.(0) ?? -1;
  let nextSlot = currentSel;
  if (direction === 'left') {
    nextSlot = currentSel === 1 ? 0 : 1;
  } else if (direction === 'right') {
    nextSlot = currentSel === 2 ? 3 : 2;
  } else if (direction === 'random') {
    nextSlot = -1;
  }

  r.physics.setCarRespawnSelection?.(0, nextSlot);
  store.updateLiveTelemetry({
    demolishRespawnSelectedSlot: nextSlot,
    demolishRespawnLastInputEdge:
      direction === 'left'
        ? `LEFT (A / Steer < -0.5) → Slot ${nextSlot}`
        : direction === 'right'
          ? `RIGHT (D / Steer > +0.5) → Slot ${nextSlot}`
          : 'RESET → Random (-1)',
  });

  syncDemolishRespawnTelemetry(lab);
}

export function selectDemolishRespawnSlotDirect(lab, slotIndex) {
  const r = lab.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();
  const clamped = slotIndex < 0 ? -1 : Math.max(0, Math.min(3, Math.round(slotIndex)));

  if (!r.physics.isCarDemolished?.(0)) {
    triggerDemolishInBench(lab);
  }

  r.physics.setCarRespawnSelection?.(0, clamped);
  store.updateLiveTelemetry({
    demolishRespawnSelectedSlot: clamped,
    demolishRespawnLastInputEdge: clamped < 0 ? 'Direct: Random (-1)' : `Direct: Slot ${clamped}`,
  });

  syncDemolishRespawnTelemetry(lab);
}

export function applyDemolishRespawnConfigChange(lab) {
  const r = lab.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();
  const team = store.demolishRespawnTeam ?? 0;
  const visualId = store.demolishRespawnVisualId || 'octane';

  // Update car 0 team in state buffer + arena
  if (r.physics.state) {
    const car0Base = SIM_OFFSETS.CARS;
    r.physics.state[car0Base + 25] = team;
  }
  if (r.arena) {
    r.arena.setCarTeam?.(0, team);
    r.arena.setCarVisual?.(0, visualId);
  }

  syncDummyObstacleCar(lab, store);

  if (!r.physics.isCarDemolished?.(0)) {
    if (store.demolishRespawnAutoHoldDemo) {
      triggerDemolishInBench(lab);
    } else {
      const slot = store.demolishRespawnSelectedSlot >= 0 ? store.demolishRespawnSelectedSlot : 1;
      r.physics.respawnCarAtPreset?.(0, team, slot);
      r.interpolator?.sync?.();
    }
  }
  syncDemolishRespawnTelemetry(lab);
}

export function stepDemolishRespawnBeforeTick(lab, store) {
  const r = lab.runtime;
  if (!r?.physics) return true;

  if (!lab.demolishRespawnRuntime) {
    lab.demolishRespawnRuntime = {
      prevSteerSign: 0,
      syntheticSteerPulseTicks: 0,
      syntheticSteerValue: 0,
      lastKnownDemoState: false,
    };
  }

  const isDemo = Boolean(r.physics.isCarDemolished?.(0));
  let demoTimer = Number(r.physics.getCarDemolishTimer?.(0) || 0);

  // If timer freeze is enabled while demolished, keep refreshing the timer so the developer
  // can freely inspect the RespawnGhostPreview, wheel placement, and Left/Right slot switching.
  if (isDemo && store.demolishRespawnFreezeTimer && demoTimer > 0.05) {
    const holdSec = Math.max(0.5, store.demolishRespawnTimerDurationSec ?? 2.5);
    const currentSel = r.physics.getCarRespawnSelection?.(0) ?? -1;
    if (Math.abs(demoTimer - holdSec) > 0.15) {
      r.physics.demolishCar?.(0, holdSec);
      r.physics.setCarRespawnSelection?.(0, currentSel);
      demoTimer = holdSec;
    } else {
      // Top up by 1 tick so it stays frozen
      r.physics.demolishCar?.(0, holdSec);
      r.physics.setCarRespawnSelection?.(0, currentSel);
      demoTimer = holdSec;
    }
  } else if (!isDemo && store.demolishRespawnAutoHoldDemo && !lab.demolishRespawnRuntime.lastKnownDemoState) {
    // Re-enter demo if Auto-Hold Demo is toggled on
  }

  // Detect keyboard A/D rising-edge changes for live telemetry
  const currentSel = r.physics.getCarRespawnSelection?.(0) ?? -1;
  if (isDemo && currentSel !== store.demolishRespawnSelectedSlot) {
    store.updateLiveTelemetry({
      demolishRespawnSelectedSlot: currentSel,
      demolishRespawnLastInputEdge: `Keyboard Steer → Slot ${currentSel}`,
    });
  }

  lab.demolishRespawnRuntime.lastKnownDemoState = isDemo;
  syncDemolishRespawnTelemetry(lab);
  return true;
}

export function syncDemolishRespawnTelemetry(lab) {
  const r = lab.runtime;
  if (!r?.physics) return;
  const store = useSubsystemIsolationLabStore.getState();

  const isDemo = Boolean(r.physics.isCarDemolished?.(0));
  const demoTimer = Number(r.physics.getCarDemolishTimer?.(0) || 0);
  const selectedSlot = r.physics.getCarRespawnSelection?.(0) ?? -1;
  const team = store.demolishRespawnTeam ?? 0;
  const effectiveSlot = selectedSlot >= 0 && selectedSlot <= 3 ? selectedSlot : 0;
  const coords = getSlotPresetCoords(team, effectiveSlot);

  const carView = r.interpolator?.getCarView?.(0, r.arena);
  const carPos = carView
    ? [
        Number(carView.pos?.[0]?.toFixed?.(1) ?? 0),
        Number(carView.pos?.[1]?.toFixed?.(1) ?? 0),
        Number(carView.pos?.[2]?.toFixed?.(1) ?? 0),
      ]
    : [coords.x, coords.y, coords.z];

  // Inspect ghost preview wheel local Y positions to verify wheels sit on the ground (not on roof)
  let wheelLocalYs = [];
  const ghost = r.arena?.respawnGhostPreview;
  if (ghost?.wheels?.threeWheels && ghost.wheels.threeWheels.length > 0) {
    wheelLocalYs = ghost.wheels.threeWheels.map((w) => Number((w?.position?.y ?? 0).toFixed(2)));
  }

  // Update HUD store so the Demolish Timer HUD badge is also visible during the test
  hudStore.getState().setDemoRespawnState?.(
    isDemo,
    isDemo ? Math.max(0.1, demoTimer) : 0,
    selectedSlot
  );

  store.updateLiveTelemetry({
    demolishRespawnIsDemolished: isDemo,
    demolishRespawnRemainingSec: Number(demoTimer.toFixed(2)),
    demolishRespawnSelectedSlot: selectedSlot,
    demolishRespawnPreviewSlotLabel:
      selectedSlot < 0 ? `Random (Preview: ${coords.label})` : `${coords.label} (Slot ${selectedSlot})`,
    demolishRespawnPreviewCoords: [coords.x, coords.y, coords.z],
    demolishRespawnPreviewYawDeg: Number(((coords.yaw * 180) / Math.PI).toFixed(1)),
    demolishRespawnCarActualPos: carPos,
    demolishRespawnWheelLocalY: wheelLocalYs,
  });
}
