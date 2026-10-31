/**
 * SubsystemIsolationLabDualWorldHelper.js
 * Bench 2 ('dual-world'): Multi-World Same-Map Ghost Sandbox helper functions.
 */

import { RocketSimPhysicsEngine } from '../../../physics/RocketSimPhysicsEngine.js';
import { MultiWorldGhostRenderer } from '../MultiWorldGhostRenderer.js';
import { parkDevTestLabProbes } from './SubsystemIsolationLabProbesHelper.js';
import { useSubsystemIsolationLabStore } from '../../../ui-core/stores/subsystemIsolationLabStore';

export const MULTI_WORLD_SPAWN_PRESETS = Object.freeze([
  { pos: [0, -2560, 17.05], rot: [0, Math.PI / 2, 0] },
  { pos: [0, 2560, 17.05], rot: [0, -Math.PI / 2, 0] },
  { pos: [-1952, -2464, 17.05], rot: [0, Math.PI / 4, 0] },
  { pos: [1952, 2464, 17.05], rot: [0, -3 * Math.PI / 4, 0] },
  { pos: [1952, -2464, 17.05], rot: [0, 3 * Math.PI / 4, 0] },
  { pos: [-1952, 2464, 17.05], rot: [0, -Math.PI / 4, 0] },
  { pos: [-256, -3840, 17.05], rot: [0, Math.PI / 2, 0] },
  { pos: [256, 3840, 17.05], rot: [0, -Math.PI / 2, 0] },
]);

export function configureWorldCarsCount(
  mode,
  sim,
  carsPerWorld = 1,
  worldIndex = 0,
  syncArenaVisuals = false,
  forceReset = false
) {
  if (!sim) return;
  const targetCount = Math.max(1, Math.min(8, Math.round(carsPerWorld || 1)));
  if (forceReset && worldIndex === 0) {
    sim.resetGoalLatch?.();
    sim.resetKickoff?.(0, false);
  }
  while (sim.numCars > targetCount && typeof sim.removeCar === 'function') {
    sim.removeCar(sim.numCars - 1);
  }
  const existingCars = sim.numCars;
  while (sim.numCars < targetCount) {
    const slotIdx = sim.numCars;
    const team = slotIdx % 2;
    sim.addCar(team, 'octane');
  }
  sim.setUnlimitedBoost(true);

  const startCarIdx = forceReset ? (worldIndex === 0 ? 1 : 0) : existingCars;
  for (let c = startCarIdx; c < targetCount; c++) {
    sim.setCarLinearFactorAndGravity?.(c, 1, 1, 1, 1);
    sim.setCarCollisionMask?.(c, true, true);
    const preset = MULTI_WORLD_SPAWN_PRESETS[(c + worldIndex) % MULTI_WORLD_SPAWN_PRESETS.length];
    sim.setCarState(c, {
      pos: [
        preset.pos[0] + (worldIndex * 160 * (c % 2 === 0 ? 1 : -1)),
        preset.pos[1],
        preset.pos[2],
      ],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      rot: preset.rot,
      boost: 100,
    });
  }

  if (syncArenaVisuals && mode.runtime?.arena) {
    const arena = mode.runtime.arena;
    for (let i = 0; i < targetCount; i++) {
      arena.ensureCar?.(i, i % 2, 'fennec');
      if (arena.cars[i]) arena.cars[i].visible = true;
      if (forceReset || i >= existingCars) {
        arena.resetCarBoosts?.(i);
      }
    }
    for (let i = targetCount; i < arena.cars.length; i++) {
      if (arena.cars[i]) arena.cars[i].visible = false;
      arena.resetCarBoosts?.(i);
      arena.carDemolitions?.[i]?.stop?.();
    }
  }
}

export function resetSecondaryWorldSpawn(mode, sim, worldIndex = 1, carsPerWorld = 1) {
  if (!sim) return;
  sim.resetGoalLatch?.();
  sim.resetKickoff(0, false);
  configureWorldCarsCount(mode, sim, carsPerWorld, worldIndex, false, false);
  for (let c = 0; c < Math.min(8, carsPerWorld); c++) {
    const preset = MULTI_WORLD_SPAWN_PRESETS[(c + worldIndex) % MULTI_WORLD_SPAWN_PRESETS.length];
    sim.setCarState(c, {
      pos: [
        preset.pos[0] + (worldIndex * 180 * (c % 2 === 0 ? 1 : -1)),
        preset.pos[1],
        preset.pos[2],
      ],
      vel: [0, 0, 0],
      angVel: [0, 0, 0],
      rot: preset.rot,
      boost: 100,
    });
  }
  sim.setBallState({
    pos: [worldIndex * 220 * (worldIndex % 2 === 1 ? 1 : -1), 0, 93.15],
    vel: [0, 0, 0],
    angVel: [0, 0, 0],
  });
  sim.step(1);
}

export async function ensureGhostWorldEngines(
  mode,
  ghostEngineCount = 1,
  carsPerWorld = 1,
  forceReset = false
) {
  const needed = Math.max(1, Math.min(7, ghostEngineCount));
  if (mode.ghostWorldsInitPromise) {
    await mode.ghostWorldsInitPromise;
  }

  mode.ghostWorldsInitPromise = (async () => {
    const preCount = mode.ghostWorlds.length;
    while (mode.ghostWorlds.length < needed) {
      const wIdx = mode.ghostWorlds.length + 1;
      const sim = new RocketSimPhysicsEngine();
      await sim.init({
        collisionData: RocketSimPhysicsEngine.cachedCollisionData,
        freshInstance: true,
        isolated: true,
      });
      sim.configureCars('default', false, 0);
      resetSecondaryWorldSpawn(mode, sim, wIdx, carsPerWorld);
      mode.ghostWorlds.push({
        worldId: `world-${wIdx}`,
        worldIndex: wIdx,
        sim,
        prevState: sim.state.slice(),
        currState: sim.state.slice(),
      });
    }
    for (let i = 0; i < needed; i++) {
      const gw = mode.ghostWorlds[i];
      if (forceReset && i < preCount) {
        resetSecondaryWorldSpawn(mode, gw.sim, i + 1, carsPerWorld);
      } else {
        configureWorldCarsCount(mode, gw.sim, carsPerWorld, i + 1, false, false);
      }
      gw.prevState.set(gw.sim.state);
      gw.currState.set(gw.sim.state);
    }
    return mode.ghostWorlds.slice(0, needed);
  })();

  return mode.ghostWorldsInitPromise;
}

export function syncDualWorldConfiguration(mode, forceRestart = false) {
  const r = mode.runtime;
  const store = useSubsystemIsolationLabStore.getState();
  const epoch = mode._tabSwitchEpoch;
  if (!mode.ghostVisuals && r.arena) mode.ghostVisuals = new MultiWorldGhostRenderer(r.arena);
  if (store.activeTab === 'dual-world' && store.dualWorldEnabled) {
    const totalWorlds = Math.max(2, Math.min(4, store.ghostWorldCount || 2));
    const ghostCount = totalWorlds - 1;
    const carsPerWorld = Math.max(1, Math.min(8, store.ghostCarsPerWorld || 1));

    if (forceRestart) {
      mode._currentActiveWorldIdx = 0;
      store.updateLiveTelemetry({ activeWorldIndex: 0 });
    }

    if (r.physics) {
      parkDevTestLabProbes(r.physics, r.arena);
      mode.probeState = null;
      configureWorldCarsCount(mode, r.physics, carsPerWorld, 0, true, forceRestart);
      r.interpolator?.sync?.();
    }

    ensureGhostWorldEngines(mode, ghostCount, carsPerWorld, forceRestart).then((ghostList) => {
      const latestStore = useSubsystemIsolationLabStore.getState();
      if (
        mode._tabSwitchEpoch !== epoch ||
        latestStore.activeTab !== 'dual-world' ||
        !latestStore.dualWorldEnabled ||
        !mode.ghostVisuals
      ) {
        return;
      }
      const opacity = latestStore.ghostOpacity;

      for (let i = 0; i < mode.ghostWorlds.length; i++) {
        const gw = mode.ghostWorlds[i];
        const isActiveGhost = i < ghostList.length;
        mode.ghostVisuals.ensureWorld(gw.worldId, {
          paletteIndex: i + 1,
          opacity,
          showCar: true,
          showBall: true,
        });
        mode.ghostVisuals.setVisible(isActiveGhost, gw.worldId);
      }
      mode.ghostVisuals.setVisible(true);
      mode.ghostVisuals.setOpacity(opacity);
    });
  } else if (mode.ghostVisuals) {
    mode.ghostVisuals.setVisible(false);
  }
}

export function handleSwitchWorld(mode) {
  const r = mode.runtime;
  const store = useSubsystemIsolationLabStore.getState();
  if (store.activeTab !== 'dual-world' || !store.dualWorldEnabled) return;
  const totalWorlds = Math.max(2, Math.min(4, store.ghostWorldCount || 2));
  const ghostCount = totalWorlds - 1;
  const carsPerWorld = Math.max(1, Math.min(8, store.ghostCarsPerWorld || 1));
  if (!r.physics || mode.ghostWorlds.length < ghostCount) return;

  const primarySnap = r.physics.saveCompactState();
  const ghostSnaps = [];
  for (let i = 0; i < ghostCount; i++) {
    ghostSnaps.push(mode.ghostWorlds[i].sim.saveCompactState());
  }

  r.physics.restoreState(ghostSnaps[0]);
  configureWorldCarsCount(mode, r.physics, carsPerWorld, 0, true, false);
  r.arena?.resetAllCarEffects?.();

  for (let i = 0; i < ghostCount - 1; i++) {
    mode.ghostWorlds[i].sim.restoreState(ghostSnaps[i + 1]);
  }
  mode.ghostWorlds[ghostCount - 1].sim.restoreState(primarySnap);

  r.interpolator?.sync?.();
  for (let i = 0; i < ghostCount; i++) {
    const gw = mode.ghostWorlds[i];
    gw.prevState.set(gw.sim.state);
    gw.currState.set(gw.sim.state);
  }
  if (mode.ghostVisuals) {
    mode.ghostVisuals.setOpacity(store.ghostOpacity);
  }
}

export function stepDualWorldGhostEngines(mode, store) {
  const r = mode.runtime;
  const ghostCount = Math.max(1, Math.min(3, (store.ghostWorldCount || 2) - 1));
  const carsPerWorld = Math.max(1, Math.min(8, store.ghostCarsPerWorld || 1));
  for (let i = 0; i < Math.min(ghostCount, mode.ghostWorlds.length); i++) {
    const gw = mode.ghostWorlds[i];
    if (!gw?.sim?.isInitialized) continue;
    gw.prevState.set(gw.currState);
    for (let c = 0; c < Math.min(carsPerWorld, gw.sim.numCars); c++) {
      gw.sim.setControls(c, r.neutralControls);
    }
    gw.sim.step(1);
    gw.currState.set(gw.sim.state);
  }
}

export function renderDualWorldGhostEngines(mode, dt, store) {
  const r = mode.runtime;
  if (!mode.ghostVisuals) return;
  const alpha = r.interpolator?.alpha ?? 1.0;
  const frameDt = dt ?? 0.016;
  const ghostCount = Math.max(1, Math.min(3, (store.ghostWorldCount || 2) - 1));

  for (let i = 0; i < Math.min(ghostCount, mode.ghostWorlds.length); i++) {
    const gw = mode.ghostWorlds[i];
    if (!gw?.sim?.isInitialized) continue;
    mode.ghostVisuals.updateWorld(
      gw.worldId,
      gw.prevState,
      gw.currState,
      alpha,
      frameDt,
      {
        paletteIndex: i + 1,
        controls: r.neutralControls,
        showBall: true,
      }
    );
  }

  for (const ext of mode.externalGhostWorlds.values()) {
    mode.ghostVisuals.updateWorld(
      ext.worldId,
      ext.prevState,
      ext.currState,
      alpha,
      frameDt,
      ext.options || { showBall: true }
    );
  }
}
