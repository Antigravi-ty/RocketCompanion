import { hudStore } from '../../ui-core/stores/hudStore.ts';
import { determinismStore } from '../../ui-core/stores/determinismStore.ts';
import type { AppState } from '../../ui-core/stores/appStoreTypes.ts';
import type { VisualMaterialsConfig } from '../../ui-core/config/uiConfig.ts';
import type { GameRuntimeUiBridgePort } from '../../game/runtimeUiPort.ts';
import { syncRuntimeNetworkDiagnostics } from './runtimeNetworkDiagnosticsBridge.ts';

export function syncMaterialsToGame(
  runtimePort: GameRuntimeUiBridgePort | null | undefined,
  materialsConfig?: Partial<VisualMaterialsConfig> | null
): void {
  if (!runtimePort) return;
  runtimePort.tunerPort.syncMaterialsConfig(materialsConfig);
}

export function createTunerBridgeHandlers(
  runtimePort: GameRuntimeUiBridgePort
): Partial<AppState['bridge']> {
  const { cameraPort, tunerPort } = runtimePort;
  return {
    onVehicleChange(carId: string) {
      tunerPort.changePlayerVehicle(carId);
    },
    onColorChange(hex: string) {
      tunerPort.applyPlayerColorChoice(hex);
    },
    onCameraChange(cameraConfig) {
      cameraPort.applyPovSettings(cameraConfig as unknown as Record<string, unknown>);
    },
    onGraphicsChange(graphicsConfig) {
      tunerPort.applyGraphicsSettings(graphicsConfig);
    },
    onGameplayChange(gameplayConfig) {
      tunerPort.applyGameplaySettings(gameplayConfig);
    },
    onTrajectoryChange(trajectoryConfig) {
      tunerPort.applyTrajectorySettings(trajectoryConfig as unknown as Record<string, unknown>);
    },
    onMaterialsChange(materialsConfig) {
      syncMaterialsToGame(runtimePort, materialsConfig);
    },
    onBoostPadTunerChange(boostPadConfig) {
      tunerPort.applyBoostPadTuner(boostPadConfig as unknown as Record<string, unknown>);
    },
    onDriftwoodsTunerChange(driftwoodsConfig) {
      tunerPort.applyDriftwoodsTuner(driftwoodsConfig as unknown as Record<string, unknown>);
    },
    onFreeCamToggle(enabled) {
      cameraPort.setFreeCam(enabled);
    },
    onFreeCamFovChange(fov) {
      cameraPort.setFreeCamFov(fov);
    },
    onResetFreeCam() {
      cameraPort.resetFreeCamOverview();
    },
    onBindingsChange(bindings) {
      tunerPort.applyInputBindings(bindings as unknown as Record<string, unknown>);
      hudStore.getState().syncBindings(bindings);
    },
    async onEnsureDeterminism() {
      const harness = await tunerPort.ensureDeterminismHarness();
      if (harness) {
        determinismStore.setHarness(harness);
      }
    },
    async onEnsureNetworkDiagnostics() {
      syncRuntimeNetworkDiagnostics(runtimePort);
    },
    onSimulateBoostPadCollect(padIndex) {
      tunerPort.simulateBoostPadCollect(padIndex);
    },
    onSimulateBoostPadRefill(padIndex, duration) {
      tunerPort.simulateBoostPadRefill(padIndex, duration);
    },
    onExperimentalWallConfigChange(wallConfig) {
      tunerPort.applyExperimentalWallConfig(wallConfig as unknown as Record<string, unknown>);
    },
    onShadowConfigChange(shadowConfig) {
      tunerPort.applyShadowConfig(shadowConfig as unknown as Record<string, unknown>);
    },
    onAnodizedPaintChange() {
      tunerPort.markArenaRenderTreeChanged();
    },
    onBoostParticleConfigChange(particleConfig) {
      tunerPort.applyBoostParticleConfig(particleConfig as unknown as Record<string, unknown>);
    },
    onSkyboxConfigChange(skyboxConfig) {
      tunerPort.applySkyboxConfig(skyboxConfig as unknown as Record<string, unknown>);
    },
    onBallVisualConfigChange(ballConfig) {
      tunerPort.applyBallVisualConfig(ballConfig as unknown as Record<string, unknown>);
    },
    onCustomVehicleTunerChange(vehicleId, hitboxPreset) {
      tunerPort.applyCustomVehicleTuner(vehicleId, hitboxPreset);
    },
    async onImportCustomVehicleGlb(vehicleId, arrayBuffer, fileName, alignPreset) {
      return tunerPort.importCustomVehicleGlb?.(vehicleId, arrayBuffer, fileName, alignPreset);
    },
    onApplyVehicleAlignPreset(vehicleId, alignPreset) {
      return Boolean(tunerPort.applyVehicleAlignPreset?.(vehicleId, alignPreset));
    },
    async onUnderDevelopmentChange(config, patch) {
      await tunerPort.applyUnderDevelopmentConfig(config, patch);
    },
  };
}
