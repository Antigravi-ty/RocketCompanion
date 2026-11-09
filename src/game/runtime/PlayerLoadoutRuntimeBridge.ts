import {
  useAppStore,
  hudStore,
  getNameTagRuntimeState,
  setNameTagRuntimeState,
  type RuntimeTunerPort,
} from '../runtimeUiPort.ts';
import {
  getPreferredColorHex,
  getPreferredFreeplayTeam,
  garageSettingsStore,
} from '../../ui-core/config/vehiclePresets.ts';
import { getMaterialsConfig } from '../../ui-core/config/materialsConfig.ts';
import { getVehicleDescriptor } from '../../ui-core/config/vehicleTunerConfig.ts';
import type { MaterialsConfigLike } from './onlineLobbyTransitionPipeline.ts';
import {
  isOnlineSessionOrBotMatchActive,
  type RuntimeDomainPortOwner,
} from './GoalBarrierRuntimeBridge.ts';

export type PlayerLoadoutTunerSlice = Pick<
  RuntimeTunerPort,
  | 'getInitialVehiclePreset'
  | 'changePlayerVehicle'
  | 'applyPlayerColorChoice'
  | 'syncInitialFreeplayTeamAndColor'
  | 'syncMaterialsConfig'
  | 'applyCustomVehicleTuner'
  | 'importCustomVehicleGlb'
  | 'applyVehicleAlignPreset'
>;

export function createPlayerLoadoutRuntimeBridge(
  target: RuntimeDomainPortOwner
): PlayerLoadoutTunerSlice {
  return {
    getInitialVehiclePreset: () => {
      const garagePrefs = garageSettingsStore?.get?.() as { vehiclePreset?: string } | null;
      return garagePrefs?.vehiclePreset || target.selectedPreset || null;
    },
    changePlayerVehicle: (carId) => target.loadoutCoordinator.changePlayerVehicle(carId),
    applyPlayerColorChoice: (hex) => {
      const playerIdx = target.playerCarIndex ?? 0;
      const replayViewer = target.modeManager?.activeMode?.standaloneReplayViewer;
      if (replayViewer?.hasLoadedReplay) {
        if (!replayViewer.isActive) replayViewer._applyUserLoadoutToTakenOverCar?.(playerIdx);
        return;
      }
      let effectiveHex = hex;
      const onlineSession = useAppStore.getState().onlineSession;
      const isActiveOnlineRoom = isOnlineSessionOrBotMatchActive(target);
      const currentMode = target.match?.state?.mode;
      if (
        (currentMode === 'freeplay' || currentMode === 'static-training-pack') &&
        !isActiveOnlineRoom
      ) {
        const freeplayTeam = getPreferredFreeplayTeam();
        const prevTeam = target.teamAssignment?.playerTeam;
        if (target.teamAssignment) target.teamAssignment.playerTeam = freeplayTeam;
        target.arena?.vehicleRegistry.setCarTeam(playerIdx, freeplayTeam);
        target.physics?.setCarTeam?.(playerIdx, freeplayTeam);
        target.networkManager.sessionCoordinator.authoritativeServer?.fallbackSim?.setCarTeam?.(
          playerIdx,
          freeplayTeam
        );
        hudStore.getState().setMatchState({ localTeam: freeplayTeam });
        const ntState = getNameTagRuntimeState();
        if (Array.isArray(ntState?.carEntries) && ntState.carEntries.length > 0) {
          setNameTagRuntimeState({
            carEntries: ntState.carEntries.map((c) =>
              c.carIndex === playerIdx ? { ...c, team: freeplayTeam } : c
            ),
          });
        }
        target.loadoutCoordinator.setCarColor(playerIdx, effectiveHex);
        if (currentMode === 'static-training-pack' && prevTeam !== freeplayTeam) {
          (
            target.modeManager?.activeMode as { reloadCurrentShot?: () => void } | null
          )?.reloadCurrentShot?.();
        }
        return;
      } else if (isActiveOnlineRoom) {
        const localTeamStr = onlineSession?.localTeam;
        const assignedTeam: 0 | 1 | null =
          localTeamStr === 'orange'
            ? 1
            : localTeamStr === 'blue'
              ? 0
              : target.botCoordinator.isBotMatch
                ? 0
                : null;
        if (assignedTeam === 0 || assignedTeam === 1) {
          effectiveHex = getPreferredColorHex(null, assignedTeam);
        }
      }
      target.loadoutCoordinator.setCarColor(playerIdx, effectiveHex);
    },
    syncInitialFreeplayTeamAndColor: (targetHex, freeplayTeam) => {
      const playerIdx = target.playerCarIndex ?? 0;
      if (targetHex) target.loadoutCoordinator.setCarColor(playerIdx, targetHex);
      const currentMode = target.match?.state?.mode || useAppStore.getState().matchMode;
      if (!currentMode || currentMode === 'freeplay') {
        if (target.teamAssignment) {
          target.teamAssignment.playerTeam = freeplayTeam;
          target.teamAssignment.opponentTeam = freeplayTeam === 0 ? 1 : 0;
        }
        target.physics?.setCarTeam?.(playerIdx, freeplayTeam);
        target.networkManager.sessionCoordinator.authoritativeServer?.fallbackSim?.setCarTeam?.(
          playerIdx,
          freeplayTeam
        );
        target.arena?.vehicleRegistry.setCarTeam(playerIdx, freeplayTeam);
        hudStore.getState().setMatchState({ localTeam: freeplayTeam });
      }
    },
    syncMaterialsConfig: (materialsConfig = null) => {
      const config = (materialsConfig || getMaterialsConfig()) as MaterialsConfigLike;
      target.loadoutCoordinator.syncPlayerMaterialsLoadout(config);
      target.arena?.vehicleRegistry.refreshCustomVehicle();
      target.arena?.markRenderTreeChanged?.();
    },
    applyCustomVehicleTuner: (vehicleId, hitboxPreset) => {
      target.arena?.vehicleRegistry.refreshCustomVehicle(vehicleId);
      const desc = getVehicleDescriptor(vehicleId);
      if (
        target.selectedPreset === vehicleId &&
        (hitboxPreset || desc?.threeWheels || vehicleId === 'trioctane-threewheel')
      ) {
        const isThreeWheels = Boolean(
          desc?.threeWheels ||
          vehicleId === 'trioctane-threewheel' ||
          hitboxPreset === 'hitbox-psyclops'
        );
        const hb = isThreeWheels
          ? 'hitbox-psyclops'
          : hitboxPreset || desc?.hitboxPreset || target.selectedHitbox || 'hitbox-octane';
        target.selectedHitbox = hb;
        target.physics?.setCarHitbox?.(target.playerCarIndex ?? 0, hb);
      }
      target.arena?.markRenderTreeChanged?.();
    },
    importCustomVehicleGlb: async (vehicleId, arrayBuffer, fileName, alignPreset) =>
      target.arena?.vehicleRegistry.loadout.importCustomVehicleGlb(
        vehicleId,
        arrayBuffer,
        fileName,
        alignPreset
      ),
    applyVehicleAlignPreset: (vehicleId, alignPreset) =>
      Boolean(
        target.arena?.vehicleRegistry.loadout.applyVehicleAlignPreset(vehicleId, alignPreset)
      ),
  };
}
