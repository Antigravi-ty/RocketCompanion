import {
  useAppStore,
  hudStore,
  getNameTagRuntimeState,
  setNameTagRuntimeState,
  type GoalBarrierDecompositionPort,
  type RuntimeTunerPort,
} from '../runtimeUiPort.ts';
import {
  isFreeplayConfigScopeActive,
  isTrainingGoalBarrierScopeActive,
} from '../../ui-core/config/trainingDefaults';
import {
  getPreferredColorHex,
  getPreferredFreeplayTeam,
  garageSettingsStore,
} from '../../ui-core/config/vehiclePresets';
import { getMaterialsConfig } from '../../ui-core/config/materialsConfig';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { MaterialsConfigLike } from './onlineLobbyTransitionPipeline.ts';
import {
  createRuntimePerfTelemetrySampler,
  type RuntimeDomainPortOwner,
} from './runtimeReplayAndDiagnosticsPort.ts';

export function createRuntimeTunerPort(owner: RuntimeDomainPortOwner): RuntimeTunerPort {
  let cachedGoalBarrier: {
    decomposition: GoalBarrierDecompositionPort;
    targetGoal: 'blue' | 'orange' | 'both';
    enabled: boolean;
    opacity: number;
    chunks: Uint8Array[];
  } | null = null;
  let appliedGoalBarrierEffectiveEnabled = false;

  const isOnlineSessionActive = () => {
    const onlineSession = useAppStore.getState().onlineSession;
    return Boolean(
      onlineSession?.isHosting ||
        onlineSession?.signalingConnected ||
        onlineSession?.roomId ||
        owner.botCoordinator.isBotMatch,
    );
  };

  const resolveActiveMode = (overrideMode?: string | null) =>
    overrideMode ||
    owner.modeManager?.activeMode?.id ||
    owner.match?.state?.mode ||
    useAppStore.getState().matchMode ||
    'freeplay';

  const applyEffectiveGoalBarrier = (modeOverride?: string | null, forcePhysicsUpdate = false) => {
    if (!cachedGoalBarrier) return;
    const { decomposition, targetGoal, enabled, opacity, chunks } = cachedGoalBarrier;
    const effectiveEnabled = Boolean(
      enabled && isTrainingGoalBarrierScopeActive(resolveActiveMode(modeOverride), isOnlineSessionActive()),
    );
    owner.arena?.environment.updateGoalBarrier(
      decomposition as unknown as Parameters<ArenaWorld['environment']['updateGoalBarrier']>[0],
      targetGoal,
      effectiveEnabled,
      opacity,
    );
    if ((forcePhysicsUpdate || effectiveEnabled !== appliedGoalBarrierEffectiveEnabled) && owner.physics?.setGoalBarrierChunks) {
      appliedGoalBarrierEffectiveEnabled = effectiveEnabled;
      const meta = effectiveEnabled
        ? { enabled: decomposition.mergedRects.length > 0, targetGoal, rects: decomposition.mergedRects }
        : null;
      const activeChunks = effectiveEnabled ? chunks : [];
      owner.physics.setGoalBarrierChunks(activeChunks, meta);
      owner.networkManager.sessionCoordinator.authoritativeServer?.fallbackSim?.setGoalBarrierChunks?.(activeChunks, meta);
      owner.interpolator?.sync?.();
    }
  };

  return {
    getInitialVehiclePreset: () => {
      const garagePrefs = garageSettingsStore?.get?.() as { vehiclePreset?: string } | null;
      return garagePrefs?.vehiclePreset || owner.selectedPreset || null;
    },
    changePlayerVehicle: (carId) => owner.changePlayerVehicle(carId),
    applyPlayerColorChoice: (hex) => {
      const playerIdx = owner.playerCarIndex ?? 0;
      const replayViewer = owner.modeManager?.activeMode?.standaloneReplayViewer;
      if (replayViewer?.hasLoadedReplay) {
        if (!replayViewer.isActive) replayViewer._applyUserLoadoutToTakenOverCar?.(playerIdx);
        return;
      }
      let effectiveHex = hex;
      const onlineSession = useAppStore.getState().onlineSession;
      const isActiveOnlineRoom = isOnlineSessionActive();
      const currentMode = owner.match?.state?.mode;
      if ((currentMode === 'freeplay' || currentMode === 'static-training-pack') && !isActiveOnlineRoom) {
        const freeplayTeam = getPreferredFreeplayTeam();
        const prevTeam = owner.teamAssignment?.playerTeam;
        if (owner.teamAssignment) owner.teamAssignment.playerTeam = freeplayTeam;
        owner.arena?.vehicleRegistry.setCarTeam(playerIdx, freeplayTeam);
        owner.physics?.setCarTeam?.(playerIdx, freeplayTeam);
        owner.networkManager.sessionCoordinator.authoritativeServer?.fallbackSim?.setCarTeam?.(playerIdx, freeplayTeam);
        hudStore.getState().setMatchState({ localTeam: freeplayTeam });
        const ntState = getNameTagRuntimeState();
        if (Array.isArray(ntState?.carEntries) && ntState.carEntries.length > 0) {
          setNameTagRuntimeState({
            carEntries: ntState.carEntries.map((c) => (c.carIndex === playerIdx ? { ...c, team: freeplayTeam } : c)),
          });
        }
        owner.setCarColor(playerIdx, effectiveHex);
        if (currentMode === 'static-training-pack' && prevTeam !== freeplayTeam) {
          (owner.modeManager?.activeMode as { reloadCurrentShot?: () => void } | null)?.reloadCurrentShot?.();
        }
        return;
      } else if (isActiveOnlineRoom) {
        const localTeamStr = onlineSession?.localTeam;
        const assignedTeam: 0 | 1 | null =
          localTeamStr === 'orange' ? 1 : localTeamStr === 'blue' ? 0 : owner.botCoordinator.isBotMatch ? 0 : null;
        if (assignedTeam === 0 || assignedTeam === 1) effectiveHex = getPreferredColorHex(null, assignedTeam);
      }
      owner.setCarColor(playerIdx, effectiveHex);
    },
    syncInitialFreeplayTeamAndColor: (targetHex, freeplayTeam) => {
      const playerIdx = owner.playerCarIndex ?? 0;
      if (targetHex) owner.setCarColor(playerIdx, targetHex);
      const currentMode = owner.match?.state?.mode || useAppStore.getState().matchMode;
      if (!currentMode || currentMode === 'freeplay') {
        if (owner.teamAssignment) {
          owner.teamAssignment.playerTeam = freeplayTeam;
          owner.teamAssignment.opponentTeam = freeplayTeam === 0 ? 1 : 0;
        }
        owner.physics?.setCarTeam?.(playerIdx, freeplayTeam);
        owner.networkManager.sessionCoordinator.authoritativeServer?.fallbackSim?.setCarTeam?.(playerIdx, freeplayTeam);
        owner.arena?.vehicleRegistry.setCarTeam(playerIdx, freeplayTeam);
        hudStore.getState().setMatchState({ localTeam: freeplayTeam });
      }
    },
    applyGraphicsSettings: (graphicsConfig) => {
      owner.domEventManager.updateViewport(graphicsConfig);
      owner.arena?.environment.setStadiumVisible(Boolean(graphicsConfig.showStadium));
      owner.domEventManager.syncPausedAndInputState(graphicsConfig);
    },
    applyGameplaySettings: (gameplayConfig) => {
      const showAll = Boolean(gameplayConfig.showAllCarHitboxes);
      if (owner.trainingOptions) {
        owner.trainingOptions = {
          ...owner.trainingOptions,
          boostOption: gameplayConfig.unlimitedBoost ? 'unlimited' : 'standard',
          disableGoalReset: !gameplayConfig.goalRestart,
          showCarHitbox: gameplayConfig.showCarHitbox,
          showAllCarHitboxes: showAll,
        };
      }
      if (isFreeplayConfigScopeActive(resolveActiveMode(), isOnlineSessionActive())) {
        owner.physics?.setUnlimitedBoost?.(gameplayConfig.unlimitedBoost);
        const server = owner.networkManager.sessionCoordinator.authoritativeServer;
        if (server) {
          server.sim?.setUnlimitedBoost?.(gameplayConfig.unlimitedBoost);
          server.configureTrainingRuleset?.({
            unlimitedBoost: gameplayConfig.unlimitedBoost,
            disableGoalReset: !gameplayConfig.goalRestart,
            goalReplayEnabled: Boolean(gameplayConfig.goalRestart),
            fifoDurationSeconds: 30,
          });
        }
      }
      owner.arena?.vehicleRegistry.setCarHitboxesVisible(gameplayConfig.showCarHitbox, showAll, owner.arena.playerCarIndex ?? 0);
    },
    applyTrajectorySettings: (trajectoryConfig) => {
      owner.ballTrajectoryPredictor?.updateSettings?.(trajectoryConfig);
    },
    syncMaterialsConfig: (materialsConfig = null) => {
      const config = (materialsConfig || getMaterialsConfig()) as MaterialsConfigLike;
      owner.syncPlayerMaterialsLoadout(config);
      owner.arena?.vehicleRegistry.refreshCustomVehicle();
      owner.arena?.markRenderTreeChanged?.();
    },
    applyBoostPadTuner: (boostPadConfig) => {
      if (owner.arena?.updateBoostPadTuner) {
        owner.arena.updateBoostPadTuner(boostPadConfig);
      } else if (owner.arena?.boostPadSystem?.updateVisualTuningParams) {
        owner.arena.boostPadSystem.updateVisualTuningParams(boostPadConfig);
      }
    },
    applyDriftwoodsTuner: (driftwoodsConfig) => {
      owner.arena?.environment.updateDriftwoodsTuner(driftwoodsConfig);
    },
    applyInputBindings: (bindings) => {
      owner.keyboard?.setBindings?.(bindings);
      owner.gamepad?.setBindings?.(bindings);
      owner.domEventManager.updateCursorHint();
    },
    ensureDeterminismHarness: async () => {
      if (!owner.networkManager.diagnosticsProbe.determinismHarness) {
        await owner.networkManager.diagnosticsProbe.enableDeterminismHarness(false);
      }
      return owner.networkManager.diagnosticsProbe.determinismHarness;
    },
    simulateBoostPadCollect: (padIndex) => {
      const sys = owner.arena?.boostPadSystem;
      if (!sys) return;
      if (padIndex === 'all') sys.simulateCollectAll?.();
      else if (typeof padIndex === 'number') sys.simulateCollect?.(padIndex);
    },
    simulateBoostPadRefill: (padIndex, duration) => {
      const sys = owner.arena?.boostPadSystem;
      if (!sys) return;
      if (padIndex === 'all') sys.simulateRefillAll?.(duration);
      else if (typeof padIndex === 'number') sys.simulateRefill?.(padIndex, duration);
    },
    applyExperimentalWallConfig: (wallConfig) => {
      owner.arena?.environment.updateExperimentalWallConfig(wallConfig);
    },
    applyShadowConfig: (shadowConfig) => {
      owner.arena?.environment.updateShadowConfig(shadowConfig, owner.renderer);
    },
    markArenaRenderTreeChanged: () => {
      owner.arena?.markRenderTreeChanged?.();
    },
    applyBoostParticleConfig: (particleConfig) => {
      if (particleConfig && typeof particleConfig.bloomEnabled === 'boolean') {
        owner.bloomEnabled = particleConfig.bloomEnabled;
      }
    },
    applySkyboxConfig: (skyboxConfig) => {
      owner.arena?.environment.updateSkyboxConfig(skyboxConfig);
    },
    applyBallVisualConfig: (ballConfig) => {
      owner.arena?.environment.updateBallVisualConfig(ballConfig);
    },
    applyCustomVehicleTuner: (vehicleId, hitboxPreset) => {
      owner.arena?.vehicleRegistry.refreshCustomVehicle(vehicleId);
      if (hitboxPreset && owner.selectedPreset === vehicleId) {
        owner.selectedHitbox = hitboxPreset;
        owner.physics?.setCarHitbox?.(owner.playerCarIndex ?? 0, vehicleId === 'trioctane-threewheel' ? 'hitbox-psyclops' : hitboxPreset);
      }
      owner.arena?.markRenderTreeChanged?.();
    },
    importCustomVehicleGlb: async (vehicleId, arrayBuffer, fileName, alignPreset) =>
      owner.arena?.vehicleRegistry.loadout.importCustomVehicleGlb(vehicleId, arrayBuffer, fileName, alignPreset),
    applyVehicleAlignPreset: (vehicleId, alignPreset) =>
      Boolean(owner.arena?.vehicleRegistry.loadout.applyVehicleAlignPreset(vehicleId, alignPreset)),
    applyUnderDevelopmentConfig: async (config, patch) => {
      const playerIdx = owner.playerCarIndex ?? 0;

      if (patch.stadiumPreset !== undefined) {
        const isThrowback = config.stadiumPreset === 'throwback';
        const manifestUrl = isThrowback
          ? '/arenamesh/throwback_stadium/manifest.json'
          : '/arenamesh/manifest.json';
        const presetId = isThrowback ? 1 : 0;

        if (owner.physics) {
          const prevCars = Math.max(1, owner.physics.numCars || 1);
          const hitbox = owner.selectedHitbox || 'octane';
          await owner.physics.reloadMeshes?.(manifestUrl);
          owner.physics.setArenaPreset?.(presetId);
          owner.physics.configureCars?.(hitbox, prevCars > 1, Math.max(0, prevCars - 2));
          const allowFreeplayBoost = isFreeplayConfigScopeActive(
            resolveActiveMode(),
            isOnlineSessionActive(),
          );
          owner.physics.setUnlimitedBoost?.(
            allowFreeplayBoost && Boolean(useAppStore.getState().gameplay?.unlimitedBoost),
          );
          if (config.threeWheelsEnabled) {
            owner.physics.setCarThreeWheels?.(playerIdx, true);
          }
          owner.resetKickoff();
          if (owner.arena && typeof owner.physics.getPads === 'function') {
            owner.arena.addPads(owner.physics.getPads());
          }
        }

        if (owner.arena) {
          await owner.arena.environment.setThrowbackStadiumActive(
            isThrowback,
            Boolean(config.showThrowbackCollisionOverlay),
          );
        }
      }

      if (patch.threeWheelsEnabled !== undefined) {
        const enabled = Boolean(config.threeWheelsEnabled);
        owner.physics?.setCarThreeWheels?.(playerIdx, enabled);
        if (owner.arena?.carWheels?.[playerIdx]) {
          owner.arena.carWheels[playerIdx].threeWheels = enabled;
        }
      }

      if (patch.showThrowbackCollisionOverlay !== undefined && patch.stadiumPreset === undefined) {
        await owner.arena?.environment.setThrowbackCollisionVisible(
          Boolean(config.showThrowbackCollisionOverlay),
        );
      }

      if (patch.perCarBoostConfigs !== undefined || patch.stadiumPreset !== undefined) {
        const carConfigs = config.perCarBoostConfigs || {};
        const serverSim = owner.networkManager.sessionCoordinator.authoritativeServer?.sim;
        for (let idx = 0; idx < 8; idx++) {
          const c = carConfigs[idx];
          if (!c) continue;
          owner.physics?.setCarUnlimitedBoost?.(idx, Boolean(c.unlimitedBoost));
          owner.physics?.setCarBoostCollectable?.(idx, Boolean(c.boostCollectable));
          owner.physics?.setCarBoostRecharge?.(
            idx,
            Boolean(c.rechargeBoostEnabled),
            Number(c.rechargeBoostPerSecond ?? 10.0),
            Number(c.rechargeBoostDelay ?? 0.25),
          );
          if (serverSim) {
            serverSim.setCarUnlimitedBoost?.(idx, Boolean(c.unlimitedBoost));
            serverSim.setCarBoostCollectable?.(idx, Boolean(c.boostCollectable));
            serverSim.setCarBoostRecharge?.(
              idx,
              Boolean(c.rechargeBoostEnabled),
              Number(c.rechargeBoostPerSecond ?? 10.0),
              Number(c.rechargeBoostDelay ?? 0.25),
            );
          }
        }
      }
    },
    syncGoalBarrier: (decomposition, targetGoal, enabled, opacity, chunks, updatePhysicsChunks) => {
      const nextChunks = updatePhysicsChunks
        ? Array.isArray(chunks)
          ? chunks
          : []
        : cachedGoalBarrier?.chunks ?? [];
      cachedGoalBarrier = {
        decomposition,
        targetGoal,
        enabled,
        opacity,
        chunks: nextChunks,
      };
      applyEffectiveGoalBarrier(null, updatePhysicsChunks);
    },
    reconcileTrainingScopeForMode: (modeId) => {
      applyEffectiveGoalBarrier(modeId, false);
      if (isFreeplayConfigScopeActive(resolveActiveMode(modeId), isOnlineSessionActive())) {
        const unlimited =
          owner.trainingOptions?.boostOption !== undefined
            ? owner.trainingOptions.boostOption === 'unlimited'
            : Boolean(useAppStore.getState().gameplay?.unlimitedBoost);
        const disableGoalReset =
          owner.trainingOptions?.disableGoalReset !== undefined
            ? Boolean(owner.trainingOptions.disableGoalReset)
            : !Boolean(useAppStore.getState().gameplay?.goalRestart ?? true);
        owner.physics?.setUnlimitedBoost?.(unlimited);
        const server = owner.networkManager.sessionCoordinator.authoritativeServer;
        if (server) {
          server.sim?.setUnlimitedBoost?.(unlimited);
          server.configureTrainingRuleset?.({
            unlimitedBoost: unlimited,
            disableGoalReset,
            goalReplayEnabled: !disableGoalReset,
            fifoDurationSeconds: 30,
          });
        }
      }
    },
    createPerfTelemetrySampler: () => createRuntimePerfTelemetrySampler(owner),
  };
}
