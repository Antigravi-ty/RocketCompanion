import {
  useAppStore,
  type PerfTelemetryLatencyBreakdownPort,
  type PerfTelemetrySamplerPort,
  type RuntimeTunerPort,
  type UnderDevelopmentConfigPort,
} from '../runtimeUiPort.ts';
import { isFreeplayConfigScopeActive } from '../../ui-core/config/trainingDefaults.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type { NetworkSessionChannelLike } from './onlineLobbyTransitionPipeline.ts';
import {
  GoalBarrierRuntimeBridge,
  isOnlineSessionOrBotMatchActive,
  resolveActiveGameplayModeId,
  type RuntimeDomainPortOwner,
} from './GoalBarrierRuntimeBridge.ts';
import { createPlayerLoadoutRuntimeBridge } from './PlayerLoadoutRuntimeBridge.ts';

/**
 * Pure pipeline calculating network latency breakdown from channel & reconciler state.
 */
export function computeNetworkLatencyBreakdown(
  channel: (NetworkSessionChannelLike & { isLoopback?: boolean; measuredRttMs?: number }) | null,
  reconciler: PredictionReconciler | null
): PerfTelemetryLatencyBreakdownPort {
  if (!channel && !reconciler) {
    return {
      rttMs: 0,
      extraRttMs: 0,
      uplinkMs: 0,
      downlinkMs: 0,
      extraUplinkMs: 0,
      extraDownlinkMs: 0,
      baseLatency: 0,
      extraLatency: 0,
    };
  }
  if (reconciler && typeof reconciler._resolveLatencyBreakdown === 'function') {
    const b = reconciler._resolveLatencyBreakdown();
    return {
      rttMs: b.rttMs,
      extraRttMs: b.extraRttMs,
      uplinkMs: b.uplinkMs,
      downlinkMs: b.downlinkMs,
      extraUplinkMs: b.extraUplinkMs,
      extraDownlinkMs: b.extraDownlinkMs,
      baseLatency: b.rttMs,
      extraLatency: b.extraRttMs,
    };
  }
  const extraUplinkMs = Math.max(
    0,
    Math.round(Number(channel?.extraUplinkMs ?? channel?.extraLatencyMs ?? 0) || 0)
  );
  const extraDownlinkMs = Math.max(
    0,
    Math.round(Number(channel?.extraDownlinkMs ?? channel?.extraLatencyMs ?? 0) || 0)
  );
  const extraRttMs = extraUplinkMs + extraDownlinkMs;

  let rttMs = extraRttMs;
  if (!channel?.isLoopback) {
    if (typeof channel?.rttMs === 'number' && Number.isFinite(channel.rttMs) && channel.rttMs > 0) {
      rttMs = Math.round(channel.rttMs);
    } else if (
      typeof channel?.measuredRttMs === 'number' &&
      Number.isFinite(channel.measuredRttMs) &&
      channel.measuredRttMs > 0
    ) {
      rttMs = Math.round(channel.measuredRttMs);
    }
  }
  const baseRtt = Math.max(0, rttMs - extraRttMs);
  const baseUplink = Math.round(baseRtt * 0.5);
  const baseDownlink = Math.max(0, baseRtt - baseUplink);
  const uplinkMs = baseUplink + extraUplinkMs;
  const downlinkMs = baseDownlink + extraDownlinkMs;

  return {
    rttMs: uplinkMs + downlinkMs,
    extraRttMs,
    uplinkMs,
    downlinkMs,
    extraUplinkMs,
    extraDownlinkMs,
    baseLatency: uplinkMs + downlinkMs,
    extraLatency: extraRttMs,
  };
}

export function createRuntimePerfTelemetrySampler(
  target: RuntimeDomainPortOwner
): PerfTelemetrySamplerPort {
  return {
    getProfiler: () => target.profiler,
    getRenderer: () => target.renderer,
    getInterpolator: () => target.interpolator,
    getPhysicsRate: () => target.networkManager.diagnosticsProbe.getPhysicsRate(),
    getNetworkLatencyInfo: () => {
      const ch = target.networkManager.sessionCoordinator.networkChannel as
        (NetworkSessionChannelLike & { isLoopback?: boolean; measuredRttMs?: number }) | null;
      const reconciler = target.networkManager.sessionCoordinator.networkReconciler;
      return computeNetworkLatencyBreakdown(ch, reconciler);
    },
  };
}

async function applyUnderDevelopmentRuntimeConfig(
  target: RuntimeDomainPortOwner,
  config: UnderDevelopmentConfigPort,
  patch: Partial<UnderDevelopmentConfigPort>
): Promise<void> {
  const playerIdx = target.playerCarIndex ?? 0;
  if (patch.stadiumPreset !== undefined) {
    const isThrowback = config.stadiumPreset === 'throwback';
    const manifestUrl = isThrowback
      ? '/arenamesh/throwback_stadium/manifest.json'
      : '/arenamesh/manifest.json';
    if (target.physics) {
      const prevCars = Math.max(1, target.physics.numCars || 1);
      await target.physics.reloadMeshes?.(manifestUrl);
      target.physics.setArenaPreset?.(isThrowback ? 1 : 0);
      target.physics.configureCars?.(
        target.selectedHitbox || 'octane',
        prevCars > 1,
        Math.max(0, prevCars - 2)
      );
      target.physics.setUnlimitedBoost?.(
        isFreeplayConfigScopeActive(
          resolveActiveGameplayModeId(target),
          isOnlineSessionOrBotMatchActive(target)
        ) && Boolean(useAppStore.getState().gameplay?.unlimitedBoost)
      );
      if (config.threeWheelsEnabled) target.physics.setCarThreeWheels?.(playerIdx, true);
      target.resetKickoff();
      if (target.arena && typeof target.physics.getPads === 'function') {
        target.arena.addPads(target.physics.getPads());
      }
    }
    if (target.arena) {
      await target.arena.environment.setThrowbackStadiumActive(
        isThrowback,
        Boolean(config.showThrowbackCollisionOverlay)
      );
    }
  }

  if (patch.threeWheelsEnabled !== undefined) {
    const enabled = Boolean(config.threeWheelsEnabled);
    target.physics?.setCarThreeWheels?.(playerIdx, enabled);
    if (target.arena?.carWheels?.[playerIdx]) {
      target.arena.carWheels[playerIdx].threeWheels = enabled;
    }
  }

  if (patch.showThrowbackCollisionOverlay !== undefined && patch.stadiumPreset === undefined) {
    await target.arena?.environment.setThrowbackCollisionVisible(
      Boolean(config.showThrowbackCollisionOverlay)
    );
  }

  if (patch.perCarBoostConfigs !== undefined || patch.stadiumPreset !== undefined) {
    const carConfigs = config.perCarBoostConfigs || {};
    const serverSim = target.networkManager.sessionCoordinator.authoritativeServer?.sim;
    for (let idx = 0; idx < 8; idx++) {
      const c = carConfigs[idx];
      if (!c) continue;
      target.physics?.setCarUnlimitedBoost?.(idx, Boolean(c.unlimitedBoost));
      target.physics?.setCarBoostCollectable?.(idx, Boolean(c.boostCollectable));
      target.physics?.setCarBoostRecharge?.(
        idx,
        Boolean(c.rechargeBoostEnabled),
        Number(c.rechargeBoostPerSecond ?? 10.0),
        Number(c.rechargeBoostDelay ?? 0.25)
      );
      if (serverSim) {
        serverSim.setCarUnlimitedBoost?.(idx, Boolean(c.unlimitedBoost));
        serverSim.setCarBoostCollectable?.(idx, Boolean(c.boostCollectable));
        serverSim.setCarBoostRecharge?.(
          idx,
          Boolean(c.rechargeBoostEnabled),
          Number(c.rechargeBoostPerSecond ?? 10.0),
          Number(c.rechargeBoostDelay ?? 0.25)
        );
      }
    }
  }
}

export function createRuntimeTunerPort(target: RuntimeDomainPortOwner): RuntimeTunerPort {
  const goalBarrierBridge = new GoalBarrierRuntimeBridge(target);
  const loadoutSlice = createPlayerLoadoutRuntimeBridge(target);

  return {
    ...loadoutSlice,
    applyGraphicsSettings: (graphicsConfig) => {
      target.domEventManager.updateViewport(graphicsConfig);
      target.arena?.environment.setStadiumVisible(Boolean(graphicsConfig.showStadium));
      target.domEventManager.syncPausedAndInputState(graphicsConfig);
    },
    applyGameplaySettings: (gameplayConfig) => {
      goalBarrierBridge.applyGameplaySettings(gameplayConfig);
    },
    applyTrajectorySettings: (trajectoryConfig) => {
      target.ballTrajectoryPredictor?.updateSettings?.(trajectoryConfig);
    },
    applyBoostPadTuner: (boostPadConfig) => {
      if (target.arena?.updateBoostPadTuner) {
        target.arena.updateBoostPadTuner(boostPadConfig);
      } else if (target.arena?.boostPadSystem?.updateVisualTuningParams) {
        target.arena.boostPadSystem.updateVisualTuningParams(boostPadConfig);
      }
    },
    applyDriftwoodsTuner: (driftwoodsConfig) => {
      target.arena?.environment.updateDriftwoodsTuner(driftwoodsConfig);
    },
    applyInputBindings: (bindings) => {
      target.keyboard?.setBindings?.(bindings);
      target.gamepad?.setBindings?.(bindings);
      target.domEventManager.updateCursorHint();
    },
    ensureDeterminismHarness: async () => {
      const probe = target.networkManager.diagnosticsProbe;
      if (!probe.determinismHarness) {
        await probe.enableDeterminismHarness(false);
      }
      return probe.determinismHarness;
    },
    simulateBoostPadCollect: (padIndex) => {
      const sys = target.arena?.boostPadSystem;
      if (!sys) return;
      if (padIndex === 'all') sys.simulateCollectAll?.();
      else if (typeof padIndex === 'number') sys.simulateCollect?.(padIndex);
    },
    simulateBoostPadRefill: (padIndex, duration) => {
      const sys = target.arena?.boostPadSystem;
      if (!sys) return;
      if (padIndex === 'all') sys.simulateRefillAll?.(duration);
      else if (typeof padIndex === 'number') sys.simulateRefill?.(padIndex, duration);
    },
    applyExperimentalWallConfig: (wallConfig) => {
      target.arena?.environment.updateExperimentalWallConfig(wallConfig);
    },
    applyShadowConfig: (shadowConfig) => {
      target.arena?.environment.updateShadowConfig(shadowConfig, target.renderer);
    },
    markArenaRenderTreeChanged: () => {
      target.arena?.markRenderTreeChanged?.();
    },
    applyBoostParticleConfig: (particleConfig) => {
      if (particleConfig && typeof particleConfig.bloomEnabled === 'boolean') {
        target.bloomEnabled = particleConfig.bloomEnabled;
      }
    },
    applySkyboxConfig: (skyboxConfig) => {
      target.arena?.environment.updateSkyboxConfig(skyboxConfig);
    },
    applyBallVisualConfig: (ballConfig) => {
      target.arena?.environment.updateBallVisualConfig(ballConfig);
    },
    applyUnderDevelopmentConfig: async (config, patch) => {
      await applyUnderDevelopmentRuntimeConfig(target, config, patch);
    },
    syncGoalBarrier: (decomposition, targetGoal, enabled, opacity, chunks, updatePhysicsChunks) => {
      goalBarrierBridge.syncGoalBarrier(
        decomposition,
        targetGoal,
        enabled,
        opacity,
        chunks,
        updatePhysicsChunks
      );
    },
    reconcileTrainingScopeForMode: (modeId) => {
      goalBarrierBridge.reconcileTrainingScopeForMode(modeId);
    },
    createPerfTelemetrySampler: () => createRuntimePerfTelemetrySampler(target),
  };
}
