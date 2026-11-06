import {
  CAR_COLOR_SLOTS,
  normalizeVisualId,
  packLoadoutCommandParam1,
  packLoadoutCommandParam2,
  resolveVehicleHitboxId,
} from '../../ui-core/config/vehicleConstants';
import {
  garageSettingsStore,
  getPreferredColorHex,
  getPreferredColorSlot,
  getPreferredFreeplayTeam,
  loadStoredColorPrefs,
} from '../../ui-core/config/vehiclePresets';
import { getMaterialsConfig } from '../../ui-core/config/materialsConfig';
import { gameAudio } from '../../audio/GameAudioEngineFacade.ts';
import { CLIENT_COMMAND_TYPES } from '../../network/protocol/GlobalPayloadCodec.ts';
import { useAppStore } from '../runtimeUiPort.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { EntityManager } from '../../entities/EntityManager.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type { FlipResetVisual } from '../../effects/FlipResetVisual.ts';
import type {
  MaterialsConfigLike,
  NetworkSessionChannelLike,
} from './onlineLobbyTransitionPipeline.ts';
import type { SignalAudioFacadeLike } from './RuntimeGoalReplaySignalSubController.ts';

export interface ActiveModeLoadoutPort {
  id?: string;
  humanPlayerCarIndex?: number;
  spawnedCars?: Record<number, Record<string, unknown>>;
  _publishSpawnedCarsTelemetry?(): void;
  rosterController?: {
    humanPlayerCarIndex?: number;
    spawnedCars?: Record<number, Record<string, unknown>>;
    publishSpawnedCarsTelemetry?(): void;
  } | null;
  standaloneReplayViewer?: { isActive?: boolean };
}

export interface RuntimeLoadoutHostPort {
  readonly arena: ArenaWorld | null;
  readonly entityManager: EntityManager | null;
  readonly physics: RocketSimPhysicsEngine | null;
  readonly camera: CameraManager | null;
  readonly cameraSubsystem?: { cameraDynamics: object | null } | null;
  readonly modeManager: { activeMode?: ActiveModeLoadoutPort | null } | null;
  readonly options: { gameAudio?: SignalAudioFacadeLike; [key: string]: unknown } | null;
  readonly authoritativeServer: AuthoritativeServerHost | null;
  readonly networkReconciler: PredictionReconciler | null;
  readonly networkChannel: NetworkSessionChannelLike | null;
  readonly playerCarIndex: number;
  readonly teamAssignment?: { playerTeam: number; opponentTeam: number } | null;
  readonly flipResetVisuals?: Map<number, FlipResetVisual>;
  selectedPreset: string;
  selectedHitbox: string | null;
  selectedColorSlot: number | null;
  flipResetVisual: FlipResetVisual | null;
  getFlipResetVisual(carIndex: number): FlipResetVisual | null;
}

/**
 * RuntimeLoadoutCoordinator
 * Autonomous SubController owning player vehicle preset swapping, car color slot syncing,
 * personal materials deduplication (`lastSyncedPersonalMaterialsKey`), network loadout broadcasts,
 * and restoration of the local player's single-car Freeplay loadout on mode transitions.
 */
export class RuntimeLoadoutCoordinator {
  private readonly host: RuntimeLoadoutHostPort;
  private lastSyncedPersonalMaterialsKey = '';

  constructor(host: RuntimeLoadoutHostPort) {
    this.host = host;
  }

  public changePlayerVehicle(visualId: string, hitboxId: string | null = null): void {
    const h = this.host;
    const normalizedVisual = normalizeVisualId(visualId);
    const resolvedHitboxId = hitboxId || resolveVehicleHitboxId(normalizedVisual);
    h.selectedPreset = normalizedVisual;
    h.selectedHitbox = resolvedHitboxId;
    const activeMode = h.modeManager?.activeMode ?? null;
    if (activeMode?.standaloneReplayViewer?.isActive) {
      return;
    }
    const expMode = activeMode?.id === 'exp-multi-bots' ? activeMode : null;
    const targetCarIdx =
      expMode && typeof expMode.humanPlayerCarIndex === 'number' && expMode.humanPlayerCarIndex >= 0
        ? expMode.humanPlayerCarIndex
        : h.playerCarIndex;

    if (h.entityManager) {
      h.entityManager.hotSwapVehicle(targetCarIdx, {
        visual: normalizedVisual,
        hitbox: resolvedHitboxId,
      });
    } else {
      h.arena?.swapCarVisual?.(targetCarIdx, normalizedVisual);
      h.physics?.setCarHitbox?.(targetCarIdx, resolvedHitboxId);
    }

    if (h.arena?.cars?.[targetCarIdx]) {
      const prevFx = h.flipResetVisuals?.get?.(targetCarIdx) ?? h.flipResetVisual;
      prevFx?.dispose?.();
      h.flipResetVisuals?.delete?.(targetCarIdx);
      try {
        h.getFlipResetVisual(targetCarIdx);
      } catch (err) {
        console.warn('[GameRuntime] FlipResetVisual re-bind skipped:', err);
      }
      h.camera?.update?.(
        h.arena.cars[h.playerCarIndex],
        h.arena.ball,
        0,
        h.cameraSubsystem?.cameraDynamics ?? {},
      );
    }

    const colorSlotId = h.selectedColorSlot ?? 0;
    const matCfg = getMaterialsConfig();
    const paintFinish = matCfg?.paintFinish || 'metallic';
    const boostVisual = matCfg?.boostVisual || 'cartoon';
    const boostAudio = matCfg?.boostAudio || 'standard';
    h.arena?.setCarLoadout?.(targetCarIdx, { paintFinish, boostVisual, boostAudio });
    (h.options?.gameAudio || gameAudio)?.setCarBoostAudioVariation?.(targetCarIdx, boostAudio);

    if (expMode) {
      const entry = expMode.spawnedCars?.[targetCarIdx];
      if (entry) {
        entry.visualId = normalizedVisual;
        entry.hitboxId = resolvedHitboxId;
        entry.paintFinish = paintFinish;
        entry.boostVisual = boostVisual;
        entry.boostAudio = boostAudio;
        expMode._publishSpawnedCarsTelemetry?.();
      }
    }

    if (h.authoritativeServer) {
      h.authoritativeServer.setLoadout?.(
        'host',
        normalizedVisual,
        colorSlotId,
        resolvedHitboxId,
        { paintFinish, boostVisual, boostAudio },
      );
    }
    if (h.networkReconciler) {
      h.networkReconciler.setCarVisualPreset?.(h.playerCarIndex, normalizedVisual);
      h.networkReconciler.queueClientCommand?.(
        CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
        packLoadoutCommandParam1(normalizedVisual, resolvedHitboxId),
        packLoadoutCommandParam2(colorSlotId, paintFinish, boostVisual, boostAudio),
      );
    }
  }

  public setCarColor(carIndex: number, colorVal: number | string, broadcast = true): void {
    const h = this.host;
    const activeMode = h.modeManager?.activeMode ?? null;
    if (!activeMode?.standaloneReplayViewer?.isActive) {
      h.arena?.setCarColor?.(carIndex, colorVal);
    }
    if (!broadcast) return;

    const hex =
      typeof colorVal === 'number'
        ? '#' + colorVal.toString(16).padStart(6, '0')
        : String(colorVal);
    const slot =
      CAR_COLOR_SLOTS.find((s) => s.hex.toLowerCase() === hex.toLowerCase()) ||
      CAR_COLOR_SLOTS[0];
    h.selectedColorSlot = slot.id;

    const activeVisual = h.selectedPreset || 'fennec';
    const activeHitbox = h.selectedHitbox || resolveVehicleHitboxId(activeVisual);
    const matCfg = getMaterialsConfig();
    const paintFinish = matCfg?.paintFinish || 'metallic';
    const boostVisual = matCfg?.boostVisual || 'cartoon';
    const boostAudio = matCfg?.boostAudio || 'standard';

    if (h.authoritativeServer && carIndex === h.playerCarIndex) {
      h.authoritativeServer.setLoadout?.(
        'host',
        activeVisual,
        slot.id,
        activeHitbox,
        { paintFinish, boostVisual, boostAudio },
      );
    }
    if (h.networkReconciler && carIndex === h.playerCarIndex) {
      h.networkReconciler.queueClientCommand?.(
        CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
        packLoadoutCommandParam1(activeVisual, activeHitbox),
        packLoadoutCommandParam2(slot.id, paintFinish, boostVisual, boostAudio),
      );
    }
    if (h.networkChannel?.sendColorChange) {
      try {
        h.networkChannel.sendColorChange(slot.id, hex, carIndex);
      } catch (err) {
        console.error('[GameRuntime] Failed to broadcast color change over network channel:', err);
      }
    }
  }

  public syncPlayerMaterialsLoadout(materialsConfig: MaterialsConfigLike | null = null): void {
    const h = this.host;
    const matCfg = materialsConfig || getMaterialsConfig();
    const paintFinish = matCfg?.paintFinish || 'metallic';
    const boostVisual = matCfg?.boostVisual || 'cartoon';
    const boostAudio = matCfg?.boostAudio || 'standard';

    const activeMode = h.modeManager?.activeMode ?? null;
    if (activeMode?.standaloneReplayViewer?.isActive) {
      return;
    }

    const expMode = activeMode?.id === 'exp-multi-bots' ? activeMode : null;
    const expHumanCarIdx = expMode?.rosterController?.humanPlayerCarIndex;
    const targetCarIdx =
      typeof expHumanCarIdx === 'number' && expHumanCarIdx >= 0
        ? expHumanCarIdx
        : h.playerCarIndex;

    h.arena?.setCarLoadout?.(targetCarIdx, {
      paintFinish,
      boostVisual,
      boostAudio,
    });
    (h.options?.gameAudio || gameAudio)?.setCarBoostAudioVariation?.(targetCarIdx, boostAudio);

    if (expMode) {
      const entry = expMode.rosterController?.spawnedCars?.[targetCarIdx];
      if (entry) {
        entry.paintFinish = paintFinish;
        entry.boostVisual = boostVisual;
        entry.boostAudio = boostAudio;
        expMode.rosterController?.publishSpawnedCarsTelemetry?.();
      }
    }

    const nextKey = `${paintFinish}:${boostVisual}:${boostAudio}`;
    if (this.lastSyncedPersonalMaterialsKey === nextKey) return;
    this.lastSyncedPersonalMaterialsKey = nextKey;

    const activeVisual = h.selectedPreset || 'fennec';
    const activeHitbox = h.selectedHitbox || resolveVehicleHitboxId(activeVisual);
    const colorSlotId = h.selectedColorSlot ?? 0;

    if (h.authoritativeServer) {
      h.authoritativeServer.setLoadout?.(
        'host',
        activeVisual,
        colorSlotId,
        activeHitbox,
        { paintFinish, boostVisual, boostAudio },
      );
    }
    if (h.networkReconciler) {
      h.networkReconciler.queueClientCommand?.(
        CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
        packLoadoutCommandParam1(activeVisual, activeHitbox),
        packLoadoutCommandParam2(colorSlotId, paintFinish, boostVisual, boostAudio),
      );
    }
  }

  /**
   * Restores the local player's saved Freeplay vehicle preset, hitbox, preferred team,
   * color slot, paint finish, boost visual, and boost audio onto `carIndex` (default 0).
   * Prevents multi-car modes (Exhibition / Multi-Bots / Replay Viewer / Online) where
   * `carIndex = 0` may have been occupied by a bot or remote peer from leaking that
   * loadout into Freeplay or subsequent single-car training modes.
   */
  public restoreLocalPlayerFreeplayLoadout(carIndex = 0): void {
    const h = this.host;
    const appCar = useAppStore?.getState?.()?.activeCar;
    const garagePrefs = garageSettingsStore?.get?.() as { vehiclePreset?: string } | null;
    const visualId = normalizeVisualId(
      h.selectedPreset || appCar || garagePrefs?.vehiclePreset || 'fennec',
    );
    const hitboxId = h.selectedHitbox || resolveVehicleHitboxId(visualId);
    h.selectedPreset = visualId;
    h.selectedHitbox = hitboxId;

    const freeplayPrefs = loadStoredColorPrefs();
    const freeplayTeam = getPreferredFreeplayTeam(freeplayPrefs);
    const freeplayColorSlot = getPreferredColorSlot(freeplayPrefs, freeplayTeam);
    const freeplayColorHex = getPreferredColorHex(freeplayPrefs, freeplayTeam);
    h.selectedColorSlot = freeplayColorSlot;

    if (h.teamAssignment) {
      h.teamAssignment.playerTeam = freeplayTeam;
      h.teamAssignment.opponentTeam = freeplayTeam === 0 ? 1 : 0;
    }

    const matCfg = getMaterialsConfig();
    const paintFinish = matCfg?.paintFinish || 'metallic';
    const boostVisual = matCfg?.boostVisual || 'cartoon';
    const boostAudio = matCfg?.boostAudio || 'standard';

    h.physics?.setCarTeam?.(carIndex, freeplayTeam);
    h.physics?.setCarHitbox?.(carIndex, hitboxId);

    if (h.entityManager) {
      h.entityManager.hotSwapVehicle(carIndex, {
        visual: visualId,
        hitbox: hitboxId,
      });
    }

    if (h.arena) {
      h.arena.ensureCar?.(carIndex, freeplayTeam, visualId);
      if (h.arena.vehiclePresets?.[carIndex] !== visualId) {
        h.arena.swapCarVisual?.(carIndex, visualId);
      }
      h.arena.setCarTeam?.(carIndex, freeplayTeam);
      h.arena.setCarColor?.(carIndex, freeplayColorHex);
      h.arena.setCarLoadout?.(carIndex, {
        visualId,
        colorHex: freeplayColorHex,
        paintFinish,
        boostVisual,
        boostAudio,
      });
      if (h.arena.cars?.[carIndex]) {
        h.arena.cars[carIndex].visible = true;
      }
    }

    if (h.arena?.cars?.[carIndex]) {
      const prevFx = h.flipResetVisuals?.get?.(carIndex) ?? h.flipResetVisual;
      prevFx?.dispose?.();
      h.flipResetVisuals?.delete?.(carIndex);
      try {
        h.getFlipResetVisual(carIndex);
      } catch (err) {
        console.warn('[GameRuntime] FlipResetVisual re-bind skipped:', err);
      }
    }

    (h.options?.gameAudio || gameAudio)?.setCarBoostAudioVariation?.(carIndex, boostAudio);
  }
}
