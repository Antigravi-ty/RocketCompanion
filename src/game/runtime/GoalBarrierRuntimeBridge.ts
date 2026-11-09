import type * as THREE from 'three';
import {
  useAppStore,
  type GoalBarrierDecompositionPort,
  type GraphicsSettingsPort,
} from '../runtimeUiPort.ts';
import {
  isFreeplayConfigScopeActive,
  isTrainingGoalBarrierScopeActive,
} from '../../ui-core/config/trainingDefaults.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { KeyboardMouseController } from '../../input/KeyboardMouseController.ts';
import type { GamepadController } from '../../input/GamepadController.ts';
import type { BallTrajectoryPredictor } from '../../entities/BallTrajectoryPredictor.ts';
import type { MultiplayerSessionManager } from '../../network/transport/MultiplayerSessionManager.ts';
import type { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import type { RuntimeNetworkManager } from './RuntimeNetworkManager.ts';
import type { RuntimeBotCoordinator } from './RuntimeBotCoordinator.ts';
import type { RuntimeDOMEventManager } from './RuntimeDOMEventManager.ts';
import type { RuntimeLoadoutCoordinator } from './RuntimeLoadoutCoordinator.ts';
import type { MountedGameUIHandle } from './RuntimeSceneBootstrap.ts';
import type { MaterialsConfigLike } from './onlineLobbyTransitionPipeline.ts';

interface StandaloneReplayViewerCarLoadoutPort {
  hasLoadedReplay?: boolean;
  isActive?: boolean;
  _applyUserLoadoutToTakenOverCar?(carIndex: number): void;
}

export interface FreeplayModeCleanupPort {
  nameTagTunerController?: { isActive?: boolean; exitTunerArena(): void } | null;
  directorPreview?: { isReplayActive?: boolean } | null;
  isGoalReplayActive?(): boolean;
  exitDirectorPatternPreview?(): void;
  rewinderController?: { isBlockingLivePhysics?: boolean; clearBuffer?(): void } | null;
  resetToCleanFreeplay?(): void;
}

export interface RuntimeDomainPortOwner {
  readonly physics: RocketSimPhysicsEngine | null;
  readonly interpolator: PhysicsStateInterpolator | null;
  readonly match: RuntimeMatchState | null;
  readonly arena: ArenaWorld | null;
  readonly camera: CameraManager | null;
  readonly renderer: THREE.WebGLRenderer | null;
  readonly profiler: unknown;
  readonly keyboard: KeyboardMouseController | null;
  readonly gamepad: GamepadController | null;
  readonly gameUI: MountedGameUIHandle | null;
  readonly ballTrajectoryPredictor: BallTrajectoryPredictor | null;
  readonly multiplayerSession: MultiplayerSessionManager | null;
  readonly replayTimelineController: ReplayTimelineController | null;
  readonly networkManager: RuntimeNetworkManager;
  readonly botCoordinator: RuntimeBotCoordinator;
  readonly domEventManager: RuntimeDOMEventManager;
  readonly loadoutCoordinator: RuntimeLoadoutCoordinator;
  readonly modeManager: {
    activeMode?: {
      id?: string;
      onEnter?(): void;
      applyRosterAndStartMatch?(): Promise<void> | void;
      skipGoalReplay?(): void;
      standaloneReplayViewer?: StandaloneReplayViewerCarLoadoutPort;
    } | null;
    modes?: Map<string, unknown>;
    getActiveMode?(): {
      id?: string;
      onEnter?(): void;
      applyRosterAndStartMatch?(): Promise<void> | void;
      skipGoalReplay?(): void;
    } | null;
    setMode?(modeId: string): void;
  } | null;
  trainingOptions: {
    boostOption?: string;
    disableGoalReset?: boolean;
    showCarHitbox?: boolean;
    showAllCarHitboxes?: boolean;
    [key: string]: unknown;
  };
  readonly teamAssignment: { playerTeam: number; opponentTeam: number } | null;
  readonly playerCarIndex: number;
  readonly matchDurationSeconds: number;
  readonly selectedPreset: string;
  selectedHitbox: string | null;
  activeGraphicsSettings: GraphicsSettingsPort | null;
  bloomEnabled: boolean;
  changePlayerVehicle(visualId: string, hitboxId?: string | null): void;
  setCarColor(carIndex: number, colorVal: number | string, broadcast?: boolean): void;
  syncPlayerMaterialsLoadout(materialsConfig?: MaterialsConfigLike | null): void;
  restoreLocalPlayerFreeplayLoadout?(carIndex?: number): void;
  resetKickoff(seed?: number): void;
}

export function isOnlineSessionOrBotMatchActive(target: RuntimeDomainPortOwner): boolean {
  const onlineSession = useAppStore.getState().onlineSession;
  return Boolean(
    onlineSession?.isHosting ||
    onlineSession?.signalingConnected ||
    onlineSession?.roomId ||
    target.botCoordinator.isBotMatch
  );
}

export function resolveActiveGameplayModeId(
  target: RuntimeDomainPortOwner,
  overrideMode?: string | null
): string {
  return (
    overrideMode ||
    target.modeManager?.activeMode?.id ||
    target.match?.state?.mode ||
    useAppStore.getState().matchMode ||
    'freeplay'
  );
}

/**
 * Self-contained domain bridge owning goal barrier cache state and training ruleset reconciliation.
 */
export class GoalBarrierRuntimeBridge {
  private readonly target: RuntimeDomainPortOwner;
  private cachedGoalBarrier: {
    decomposition: GoalBarrierDecompositionPort;
    targetGoal: 'blue' | 'orange' | 'both';
    enabled: boolean;
    opacity: number;
    chunks: Uint8Array[];
  } | null = null;
  private appliedGoalBarrierEffectiveEnabled = false;

  constructor(target: RuntimeDomainPortOwner) {
    this.target = target;
  }

  public applyEffectiveGoalBarrier(modeOverride?: string | null, forcePhysicsUpdate = false): void {
    if (!this.cachedGoalBarrier) return;
    const t = this.target;
    const { decomposition, targetGoal, enabled, opacity, chunks } = this.cachedGoalBarrier;
    const effectiveEnabled = Boolean(
      enabled &&
      isTrainingGoalBarrierScopeActive(
        resolveActiveGameplayModeId(t, modeOverride),
        isOnlineSessionOrBotMatchActive(t)
      )
    );
    t.arena?.environment.updateGoalBarrier(
      decomposition as unknown as Parameters<ArenaWorld['environment']['updateGoalBarrier']>[0],
      targetGoal,
      effectiveEnabled,
      opacity
    );
    if (
      (forcePhysicsUpdate || effectiveEnabled !== this.appliedGoalBarrierEffectiveEnabled) &&
      t.physics?.setGoalBarrierChunks
    ) {
      this.appliedGoalBarrierEffectiveEnabled = effectiveEnabled;
      const meta = effectiveEnabled
        ? {
            enabled: decomposition.mergedRects.length > 0,
            targetGoal,
            rects: decomposition.mergedRects,
          }
        : null;
      const activeChunks = effectiveEnabled ? chunks : [];
      t.physics.setGoalBarrierChunks(activeChunks, meta);
      t.networkManager.sessionCoordinator.authoritativeServer?.fallbackSim?.setGoalBarrierChunks?.(
        activeChunks,
        meta
      );
      t.interpolator?.sync?.();
    }
  }

  public syncGoalBarrier(
    decomposition: GoalBarrierDecompositionPort,
    targetGoal: 'blue' | 'orange' | 'both',
    enabled: boolean,
    opacity: number,
    chunks: unknown,
    updatePhysicsChunks: boolean
  ): void {
    const nextChunks = updatePhysicsChunks
      ? Array.isArray(chunks)
        ? (chunks as Uint8Array[])
        : []
      : (this.cachedGoalBarrier?.chunks ?? []);
    this.cachedGoalBarrier = {
      decomposition,
      targetGoal,
      enabled,
      opacity,
      chunks: nextChunks,
    };
    this.applyEffectiveGoalBarrier(null, updatePhysicsChunks);
  }

  public applyGameplaySettings(gameplayConfig: {
    unlimitedBoost: boolean;
    goalRestart: boolean;
    showCarHitbox: boolean;
    showAllCarHitboxes?: boolean;
  }): void {
    const t = this.target;
    const showAll = Boolean(gameplayConfig.showAllCarHitboxes);
    if (t.trainingOptions) {
      t.trainingOptions = {
        ...t.trainingOptions,
        boostOption: gameplayConfig.unlimitedBoost ? 'unlimited' : 'standard',
        disableGoalReset: !gameplayConfig.goalRestart,
        showCarHitbox: gameplayConfig.showCarHitbox,
        showAllCarHitboxes: showAll,
      };
    }
    if (
      isFreeplayConfigScopeActive(
        resolveActiveGameplayModeId(t),
        isOnlineSessionOrBotMatchActive(t)
      )
    ) {
      t.physics?.setUnlimitedBoost?.(gameplayConfig.unlimitedBoost);
      const server = t.networkManager.sessionCoordinator.authoritativeServer;
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
    t.arena?.vehicleRegistry.setCarHitboxesVisible(
      gameplayConfig.showCarHitbox,
      showAll,
      t.arena.playerCarIndex ?? 0
    );
  }

  public reconcileTrainingScopeForMode(modeId?: string): void {
    const t = this.target;
    this.applyEffectiveGoalBarrier(modeId, false);
    if (
      isFreeplayConfigScopeActive(
        resolveActiveGameplayModeId(t, modeId),
        isOnlineSessionOrBotMatchActive(t)
      )
    ) {
      const unlimited =
        t.trainingOptions?.boostOption !== undefined
          ? t.trainingOptions.boostOption === 'unlimited'
          : Boolean(useAppStore.getState().gameplay?.unlimitedBoost);
      const disableGoalReset =
        t.trainingOptions?.disableGoalReset !== undefined
          ? Boolean(t.trainingOptions.disableGoalReset)
          : !Boolean(useAppStore.getState().gameplay?.goalRestart ?? true);
      t.physics?.setUnlimitedBoost?.(unlimited);
      const server = t.networkManager.sessionCoordinator.authoritativeServer;
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
  }
}
