import { useAppStore } from '../../ui-core/stores/appStore';
import { hudStore } from '../../ui-core/stores/hudStore';
import { determinismStore } from '../../ui-core/stores/determinismStore';
import { getMaterialsConfig } from '../../ui-core/config/materialsConfig.js';
import type { AppState } from '../../ui-core/stores/appStoreTypes';
import { syncRuntimeNetworkDiagnostics } from './runtimeNetworkDiagnosticsBridge';

export function syncMaterialsToGame(gameRuntime: any, materialsConfig?: any) {
  if (!gameRuntime) return;
  const config = materialsConfig || getMaterialsConfig();
  gameRuntime.applyVisualMaterialsConfig?.(config);
  gameRuntime.syncPlayerMaterialsLoadout?.(config);
  gameRuntime.arena?.refreshCustomVehicle?.();
  if (gameRuntime.arena?.markRenderTreeChanged) {
    gameRuntime.arena.markRenderTreeChanged();
  }
}

export function createTunerBridgeHandlers(gameRuntime: any): Partial<AppState['bridge']> {
  return {
    onVehicleChange: (carId: string) => {
      if (typeof gameRuntime.changePlayerVehicle === 'function') {
        gameRuntime.changePlayerVehicle(carId);
      }
    },
    onColorChange: (hex: string) => {
      if (typeof gameRuntime.setCarColor === 'function') {
        gameRuntime.setCarColor(gameRuntime.playerCarIndex ?? 0, hex);
      }
    },
    onCameraChange: (cameraConfig) => {
      if (gameRuntime.camera && gameRuntime.camera.settings) {
        Object.assign(gameRuntime.camera.settings, cameraConfig);
        if (gameRuntime.camera._sharedCamera) {
          gameRuntime.camera._sharedCamera.fov = cameraConfig.fov;
          if (typeof gameRuntime.camera._sharedCamera.updateProjectionMatrix === 'function') {
            gameRuntime.camera._sharedCamera.updateProjectionMatrix();
          }
        }
        if (typeof gameRuntime.camera.updateProjectionMatrix === 'function') {
          gameRuntime.camera.updateProjectionMatrix();
        }
      }
      if (gameRuntime.settingsSheet && gameRuntime.settingsSheet.target) {
        Object.assign(gameRuntime.settingsSheet.target, cameraConfig);
      }
    },
    onGraphicsChange: (graphicsConfig) => {
      gameRuntime.activeGraphicsSettings = graphicsConfig;
      if (typeof gameRuntime.updateViewport === 'function') {
        gameRuntime.updateViewport(graphicsConfig);
      }
      if (gameRuntime.arena) {
        gameRuntime.arena.setStadiumVisible?.(graphicsConfig.showStadium);
      }
      if (typeof gameRuntime.syncPausedAndInputState === 'function') {
        gameRuntime.syncPausedAndInputState(graphicsConfig);
      } else if (gameRuntime.clockScheduler) {
        gameRuntime.clockScheduler.setFpsLimit(graphicsConfig.limitFps ? graphicsConfig.maxFps : null);
      }
    },
    onGameplayChange: (gameplayConfig) => {
      if (gameRuntime.trainingOptions) {
        gameRuntime.trainingOptions.boostOption = gameplayConfig.unlimitedBoost
          ? 'unlimited'
          : 'standard';
        gameRuntime.trainingOptions.disableGoalReset = !gameplayConfig.goalRestart;
        gameRuntime.trainingOptions.showCarHitbox = gameplayConfig.showCarHitbox;
      }
      if (gameRuntime.physics) {
        gameRuntime.physics.setUnlimitedBoost?.(gameplayConfig.unlimitedBoost);
      }
      if (gameRuntime.arena) {
        gameRuntime.arena.setCarHitboxesVisible?.(gameplayConfig.showCarHitbox);
      }
    },
    onTrajectoryChange: (trajectoryConfig) => {
      if (gameRuntime.ballTrajectoryPredictor?.updateSettings) {
        gameRuntime.ballTrajectoryPredictor.updateSettings(trajectoryConfig);
      } else if (gameRuntime.ballTrajectoryPredictor?.settings) {
        Object.assign(gameRuntime.ballTrajectoryPredictor.settings, trajectoryConfig);
      }
    },
    onMaterialsChange: (materialsConfig) => {
      syncMaterialsToGame(gameRuntime, materialsConfig);
    },
    onBoostPadTunerChange: (boostPadConfig) => {
      if (gameRuntime.arena?.updateBoostPadTuner) {
        gameRuntime.arena.updateBoostPadTuner(boostPadConfig);
      } else if (gameRuntime.arena?.boostPadSystem?.updateVisualTuningParams) {
        gameRuntime.arena.boostPadSystem.updateVisualTuningParams(boostPadConfig);
      }
    },
    onDriftwoodsTunerChange: (driftwoodsConfig) => {
      if (gameRuntime.arena?.updateDriftwoodsTuner) {
        gameRuntime.arena.updateDriftwoodsTuner(driftwoodsConfig);
      }
    },
    onFreeCamToggle: (enabled) => {
      if (gameRuntime.camera && typeof gameRuntime.camera.setFreeCam === 'function') {
        gameRuntime.camera.setFreeCam(enabled);
      }
    },
    onFreeCamFovChange: (fov) => {
      if (gameRuntime.camera && typeof gameRuntime.camera.setFreeCamFov === 'function') {
        gameRuntime.camera.setFreeCamFov(fov);
      }
    },
    onResetFreeCam: () => {
      if (gameRuntime.camera && typeof gameRuntime.camera.resetFreeCamOverview === 'function') {
        gameRuntime.camera.resetFreeCamOverview();
      }
    },
    onBindingsChange: (bindings: any) => {
      if (gameRuntime.keyboard && typeof gameRuntime.keyboard.setBindings === 'function') {
        gameRuntime.keyboard.setBindings(bindings);
      }
      if (gameRuntime.gamepad && typeof gameRuntime.gamepad.setBindings === 'function') {
        gameRuntime.gamepad.setBindings(bindings);
      }
      if (typeof gameRuntime.updateCursorHint === 'function') {
        gameRuntime.updateCursorHint();
      }
      if (gameRuntime.settingsSheet) {
        gameRuntime.settingsSheet.bindings = bindings;
      }
      hudStore.getState().syncBindings(bindings);
    },
    onEnsureDeterminism: async () => {
      if (
        !gameRuntime.determinismHarness &&
        typeof gameRuntime.enableDeterminismHarness === 'function'
      ) {
        await gameRuntime.enableDeterminismHarness(false);
      }
      if (gameRuntime.determinismHarness) {
        determinismStore.setHarness(gameRuntime.determinismHarness);
      }
    },
    onEnsureNetworkDiagnostics: async () => {
      syncRuntimeNetworkDiagnostics(gameRuntime);
    },
    onSimulateBoostPadCollect: (padIndex) => {
      const sys = gameRuntime.arena?.boostPadSystem;
      if (!sys) return;
      if (padIndex === 'all') {
        sys.simulateCollectAll?.();
      } else if (typeof padIndex === 'number') {
        sys.simulateCollect?.(padIndex);
      }
    },
    onSimulateBoostPadRefill: (padIndex, duration) => {
      const sys = gameRuntime.arena?.boostPadSystem;
      if (!sys) return;
      if (padIndex === 'all') {
        sys.simulateRefillAll?.(duration);
      } else if (typeof padIndex === 'number') {
        sys.simulateRefill?.(padIndex, duration);
      }
    },
    onExperimentalWallConfigChange: (wallConfig) => {
      gameRuntime.arena?.updateExperimentalWallConfig?.(wallConfig);
    },
    onShadowConfigChange: (shadowConfig) => {
      gameRuntime.arena?.updateShadowConfig?.(shadowConfig, gameRuntime.renderer);
    },
    onAnodizedPaintChange: () => {
      if (gameRuntime.arena?.markRenderTreeChanged) {
        gameRuntime.arena.markRenderTreeChanged();
      }
    },
    onBoostParticleConfigChange: (particleConfig) => {
      if (particleConfig && typeof particleConfig.bloomEnabled === 'boolean') {
        gameRuntime.bloomEnabled = particleConfig.bloomEnabled;
      }
    },
    onSkyboxConfigChange: (skyboxConfig) => {
      gameRuntime.arena?.updateSkyboxConfig?.(skyboxConfig);
    },
    onBallVisualConfigChange: (ballConfig) => {
      gameRuntime.arena?.updateBallVisualConfig?.(ballConfig);
    },
    onCustomVehicleTunerChange: (vehicleId, hitboxPreset) => {
      gameRuntime.arena?.refreshCustomVehicle?.(vehicleId);
      if (hitboxPreset && gameRuntime.selectedPreset === vehicleId) {
        gameRuntime.selectedHitbox = hitboxPreset;
        gameRuntime.physics?.setCarHitbox?.(gameRuntime.playerCarIndex ?? 0, hitboxPreset);
      }
      if (gameRuntime.arena?.markRenderTreeChanged) {
        gameRuntime.arena.markRenderTreeChanged();
      }
    },
    onUnderDevelopmentChange: async (config, patch) => {
      const playerIdx = gameRuntime.playerCarIndex ?? 0;

      if (patch.stadiumPreset !== undefined) {
        const isThrowback = config.stadiumPreset === 'throwback';
        const manifestUrl = isThrowback
          ? '/arenamesh/throwback_stadium/manifest.json'
          : '/arenamesh/manifest.json';
        const presetId = isThrowback ? 1 : 0;

        if (gameRuntime.physics) {
          const prevCars = Math.max(1, gameRuntime.physics.numCars || 1);
          const hitbox = gameRuntime.selectedHitbox || 'octane';
          await gameRuntime.physics.reloadMeshes?.(manifestUrl);
          gameRuntime.physics.setArenaPreset?.(presetId);
          gameRuntime.physics.configureCars?.(hitbox, prevCars > 1, Math.max(0, prevCars - 2));
          gameRuntime.physics.setUnlimitedBoost?.(useAppStore.getState().gameplay.unlimitedBoost);
          if (config.threeWheelsEnabled) {
            gameRuntime.physics.setCarThreeWheels?.(playerIdx, true);
          }
          if (typeof gameRuntime.resetKickoff === 'function') {
            gameRuntime.resetKickoff();
          } else {
            gameRuntime.physics.resetKickoff?.();
          }
          if (gameRuntime.arena && typeof gameRuntime.physics.getPads === 'function') {
            gameRuntime.arena.addPads(gameRuntime.physics.getPads());
          }
        }

        if (gameRuntime.arena) {
          await gameRuntime.arena.setThrowbackStadiumActive?.(
            isThrowback,
            Boolean(config.showThrowbackCollisionOverlay)
          );
        }
      }

      if (patch.threeWheelsEnabled !== undefined) {
        const enabled = Boolean(config.threeWheelsEnabled);
        gameRuntime.physics?.setCarThreeWheels?.(playerIdx, enabled);
        if (gameRuntime.arena?.carWheels?.[playerIdx]) {
          gameRuntime.arena.carWheels[playerIdx].threeWheels = enabled;
        }
      }

      if (patch.showThrowbackCollisionOverlay !== undefined && patch.stadiumPreset === undefined) {
        await gameRuntime.arena?.setThrowbackCollisionVisible?.(
          Boolean(config.showThrowbackCollisionOverlay)
        );
      }

      if (patch.perCarBoostConfigs !== undefined || patch.stadiumPreset !== undefined) {
        const carConfigs = config.perCarBoostConfigs || {};
        for (let idx = 0; idx < 8; idx++) {
          const c = carConfigs[idx];
          if (!c) continue;
          gameRuntime.physics?.setCarUnlimitedBoost?.(idx, Boolean(c.unlimitedBoost));
          gameRuntime.physics?.setCarBoostCollectable?.(idx, Boolean(c.boostCollectable));
          gameRuntime.physics?.setCarBoostRecharge?.(
            idx,
            Boolean(c.rechargeBoostEnabled),
            Number(c.rechargeBoostPerSecond ?? 10.0),
            Number(c.rechargeBoostDelay ?? 0.25)
          );
          if (gameRuntime.authoritativeServer?.sim) {
            gameRuntime.authoritativeServer.sim.setCarUnlimitedBoost?.(
              idx,
              Boolean(c.unlimitedBoost)
            );
            gameRuntime.authoritativeServer.sim.setCarBoostCollectable?.(
              idx,
              Boolean(c.boostCollectable)
            );
            gameRuntime.authoritativeServer.sim.setCarBoostRecharge?.(
              idx,
              Boolean(c.rechargeBoostEnabled),
              Number(c.rechargeBoostPerSecond ?? 10.0),
              Number(c.rechargeBoostDelay ?? 0.25)
            );
          }
        }
      }
    },
  };
}
