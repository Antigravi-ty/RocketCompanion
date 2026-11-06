/**
 * KickoffTrainingMode.ts
 * Dedicated Kickoff Training game mode powered by the optimal PPO model from RLRL101.
 * Delegates episode physics, dual-world ghost simulation, spawn settling, and timeline
 * comparison to KickoffEpisodeSubController.ts.
 */

import { BaseGameMode } from './BaseGameMode.ts';
import {
  KickoffEpisodeSubController,
  type KickoffSubMode,
  type KickoffGhostPlacement,
  type KickoffFrameUpdateContext,
} from './KickoffEpisodeSubController.ts';
import { KickoffGhostVisuals } from './KickoffGhostVisuals.ts';
import { useKickoffTrainingStore, hudStore } from '../runtimeUiPort.ts';
import { getPreferredFreeplayTeam } from '../../ui-core/config/vehiclePresets';

export class KickoffTrainingMode extends BaseGameMode {
  public ghostVisuals: KickoffGhostVisuals | null = null;
  public readonly episodeController: KickoffEpisodeSubController;

  constructor(runtime: Record<string, any> | null) {
    super('kickoff-training', runtime);
    this.episodeController = new KickoffEpisodeSubController({
      getRuntime: () => this.runtime,
      getGhostVisuals: () => this.ghostVisuals,
    });
  }

  public get spawnIndex(): number {
    return this.episodeController.getConfigSnapshot().spawnIndex;
  }

  public set spawnIndex(val: number) {
    this.episodeController.applyConfigPatch({ spawnIndex: val });
  }

  public get subMode(): KickoffSubMode {
    return this.episodeController.getConfigSnapshot().subMode;
  }

  public set subMode(val: KickoffSubMode) {
    this.episodeController.applyConfigPatch({ subMode: val });
  }

  public get ghostPlacement(): KickoffGhostPlacement {
    return this.episodeController.getConfigSnapshot().ghostPlacement;
  }

  public set ghostPlacement(val: KickoffGhostPlacement) {
    this.episodeController.applyConfigPatch({ ghostPlacement: val });
  }

  public get ghostModeEnabled(): boolean {
    return this.episodeController.getConfigSnapshot().ghostModeEnabled;
  }

  public set ghostModeEnabled(val: boolean) {
    this.episodeController.applyConfigPatch({ ghostModeEnabled: Boolean(val) });
  }

  public override onEnter(): void {
    const r = this.runtime;
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }

    const store = useKickoffTrainingStore.getState();
    store.resetToEntryDefaults?.();

    const ensureActiveKickoffMode = (actionName: string): boolean => {
      const activeMode = r?.match?.state?.mode;
      if (activeMode !== 'kickoff-training') {
        console.warn(
          `[KickoffTrainingMode] ${actionName} ignored: active mode is "${activeMode ?? 'none'}", requires "kickoff-training".`
        );
        return false;
      }
      return true;
    };

    store.setRuntimeHandlers({
      onSelectSpawn: (idx: number) => {
        if (ensureActiveKickoffMode('onSelectSpawn')) this.selectSpawn(idx);
      },
      onResetSpawn: () => {
        if (ensureActiveKickoffMode('onResetSpawn')) this.selectSpawn(this.spawnIndex);
      },
      onSubModeChange: (nextSubMode: KickoffSubMode) => {
        this.episodeController.applyConfigPatch({ subMode: nextSubMode });
        if (ensureActiveKickoffMode('onSubModeChange')) this.selectSpawn(this.spawnIndex);
      },
      onSpeedChange: (physicsRate: number) => {
        if (!ensureActiveKickoffMode('onSpeedChange')) return;
        if (r?.interpolator) {
          r.interpolator.setTrainingPhysicsRate?.(physicsRate);
        }
      },
      onRealisticWaitChange: () => {
        if (!ensureActiveKickoffMode('onRealisticWaitChange')) return;
        if (this.subMode === 'realistic') {
          this.selectSpawn(this.spawnIndex);
        }
      },
      onGhostPlacementChange: (placement: KickoffGhostPlacement) => {
        this.episodeController.applyConfigPatch({ ghostPlacement: placement });
        if (ensureActiveKickoffMode('onGhostPlacementChange') && !this.ghostModeEnabled) {
          this.selectSpawn(useKickoffTrainingStore.getState().spawnIndex);
        }
      },
      onGhostModeChange: (enabled: boolean) => {
        this.episodeController.applyConfigPatch({ ghostModeEnabled: enabled });
        if (ensureActiveKickoffMode('onGhostModeChange')) {
          this.selectSpawn(useKickoffTrainingStore.getState().spawnIndex);
        }
      },
      onGhostVisibilityChange: (showCar: boolean, showBall: boolean) => {
        this.episodeController.applyConfigPatch({
          ghostVisibility: { showCar, showBall },
        });
      },
    });

    if (r?.arena && !this.ghostVisuals) {
      this.ghostVisuals = new KickoffGhostVisuals(r.arena);
    }
    this.ghostVisuals?.ensureBuilt?.();

    r?.arena?.ensureOpponent?.();
    if (r?.physics) {
      r.physics.setUnlimitedBoost(false);
    }
    if (r?.interpolator) {
      r.interpolator.setTrainingPhysicsRate?.(120);
    }

    this.episodeController.onEnter(useKickoffTrainingStore.getState().spawnIndex || 0);
  }

  public override onLeave(): void {
    const r = this.runtime;
    const store = useKickoffTrainingStore.getState();
    store.setRuntimeHandlers({
      onSelectSpawn: undefined,
      onResetSpawn: undefined,
      onSubModeChange: undefined,
      onSpeedChange: undefined,
      onRealisticWaitChange: undefined,
      onGhostPlacementChange: undefined,
      onGhostModeChange: undefined,
      onGhostVisibilityChange: undefined,
    });

    if (this.ghostVisuals) {
      this.ghostVisuals.setVisible(false);
    }
    if (r?.arena?.cars?.[1]) {
      r.arena.cars[1].visible = false;
    }
    if (r?.physics) {
      r.physics.setSimulationFrozen?.(false, 0, false);
      const isTrainingUnlimited = r?.trainingOptions?.boostOption === 'unlimited';
      r.physics.setUnlimitedBoost(isTrainingUnlimited);
      r.physics.configureCars(
        r.arena?.carVisual || 'octane',
        false,
        r.teamAssignment?.playerTeam ?? 0
      );
    }
    if (r?.interpolator) {
      r.interpolator.setTrainingPhysicsRate?.(r?.trainingOptions?.gameSpeed || 120);
      r.interpolator.sync();
    }
    if (r?.match?.state) {
      r.match.state.phase = 'playing';
      r.match.state.countdownValue = 0;
    }
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      countdownText: undefined,
      localTeam: getPreferredFreeplayTeam(),
    });
    this.episodeController.onExit();
  }

  public selectSpawn(spawnIndex: number = this.spawnIndex): void {
    this.episodeController.selectSpawn(spawnIndex);
  }

  public override onResetKickoff(): void {
    this.episodeController.resetEpisode(this.spawnIndex);
  }

  public _resetKickoffEpisode(spawnIndex: number = this.spawnIndex): void {
    this.episodeController.resetEpisode(spawnIndex);
  }

  public onBeforePhysicsTick(): boolean {
    return this.episodeController.onBeforePhysicsTick();
  }

  public onStepPhysicsTick(): boolean {
    return this.episodeController.step();
  }

  public override update(context: KickoffFrameUpdateContext): void {
    this.episodeController.updateFrame(context);
  }
}
