import { BaseGameMode } from './BaseGameMode.ts';
import { ensureExperimentalEngine } from '../../ai/experimental/ExperimentalBotAgent.ts';
import { useExperimentalMultiBotsStore, hudStore } from '../runtimeUiPort.ts';
import { ExperimentalMultiBotsRosterController } from './experimental-multi-bots/ExperimentalMultiBotsRosterController.ts';
import { ExperimentalMultiBotsReplayController } from './experimental-multi-bots/ExperimentalMultiBotsReplayController.ts';
import { ExperimentalMultiBotsMatchLifecycleController } from './experimental-multi-bots/ExperimentalMultiBotsMatchLifecycleController.ts';
import { ExperimentalMultiBotsSimulationController } from './experimental-multi-bots/ExperimentalMultiBotsSimulationController.ts';

export class ExperimentalMultiBotsMode extends BaseGameMode {
  public readonly rosterController: ExperimentalMultiBotsRosterController;
  public readonly replaySession: ExperimentalMultiBotsReplayController;
  public readonly lifecycleController: ExperimentalMultiBotsMatchLifecycleController;
  public readonly simulationController: ExperimentalMultiBotsSimulationController;

  constructor(runtime: any) {
    super('exp-multi-bots', runtime);

    this.rosterController = new ExperimentalMultiBotsRosterController(runtime);
    this.replaySession = new ExperimentalMultiBotsReplayController(runtime);
    this.lifecycleController = new ExperimentalMultiBotsMatchLifecycleController(runtime);
    this.simulationController = new ExperimentalMultiBotsSimulationController(runtime);

    useExperimentalMultiBotsStore.getState().setRuntimeHandlers({
      onPreloadEngines: () => this.rosterController.preloadNativeModels(),
    });
  }

  onEnter(): void {
    const r = this.runtime;
    const store = useExperimentalMultiBotsStore.getState();

    if (r) {
      r.podiumController = this.lifecycleController.podiumController;
    }
    this.replaySession.attachPhysicsIfNeeded();

    const ensureActiveExpMode = (actionName: string): boolean => {
      const activeMode = r?.match?.state?.mode;
      if (activeMode !== 'exp-multi-bots') {
        console.warn(
          `[ExperimentalMultiBotsMode] ${actionName} ignored: active mode is "${activeMode ?? 'none'}", requires "exp-multi-bots".`
        );
        return false;
      }
      return true;
    };

    store.setRuntimeHandlers({
      onApplyRosterAndStart: () => {
        if (ensureActiveExpMode('onApplyRosterAndStart')) this.applyRosterAndStartMatch();
      },
      onSelectCameraCar: (carIdx: number) => {
        if (ensureActiveExpMode('onSelectCameraCar')) this._applyCameraCarIndex(carIdx);
      },
      onSpeedMultiplierChange: (mult: number) => {
        if (ensureActiveExpMode('onSpeedMultiplierChange')) {
          this.rosterController.applySpeedMultiplier(mult);
        }
      },
      onUnlimitedBoostChange: (unlimited: boolean) => {
        if (ensureActiveExpMode('onUnlimitedBoostChange')) {
          r.physics?.setUnlimitedBoost?.(Boolean(unlimited));
        }
      },
      onTriggerAction: (action: string) => {
        if (ensureActiveExpMode('onTriggerAction')) this.triggerSandboxAction(action);
      },
      onHotSwapSlotBotType: (team: number, slotIndex: number, botType: string) => {
        if (ensureActiveExpMode('onHotSwapSlotBotType')) {
          this._hotSwapSlotBotType(team, slotIndex, botType);
        }
      },
      onHotSwapSlotColor: () => {
        if (ensureActiveExpMode('onHotSwapSlotColor')) {
          this.rosterController.syncCarColorsFromStore();
        }
      },
      onPreloadEngines: () => this.rosterController.preloadNativeModels(),
    });

    this.applyRosterAndStartMatch();
  }

  onLeave(): void {
    const r = this.runtime;

    if (
      this.lifecycleController.goalResetTicks > 0 &&
      this.lifecycleController.goalTracker.goalIncidentTick > 0
    ) {
      this.replaySession.retainGoalReplayBuffer(
        this.lifecycleController.getGoalIncidentMeta(),
        this.rosterController.spawnedCars
      );
    }

    this.lifecycleController.podiumController?.exitPodium?.();
    this.replaySession.replayController?.endReplaySession?.();
    this.replaySession.clearSignalsAndBuffer();
    this.replaySession.isReplayActive = false;
    if (r) {
      r.releaseGoalReplayCameraOverride();
    }

    this.rosterController.cleanupExtraCarsOnLeave();

    useExperimentalMultiBotsStore.getState().updateLiveTelemetry({
      matchActive: false,
    });
  }

  _applyCameraCarIndex(carIdx = 0): void {
    const clamped = this.rosterController.applyCameraCarIndex(carIdx);
    if (this.replaySession.isReplayActive) {
      this.replaySession.replayPovCarIndex = clamped;
    }
  }

  private _hotSwapSlotBotType(_team: number, _slotIndex: number, botType: string): void {
    if (botType && botType !== 'heuristic') {
      ensureExperimentalEngine(botType);
    }
    this.applyRosterAndStartMatch();
  }

  _publishSpawnedCarsTelemetry(): void {
    this.rosterController.publishSpawnedCarsTelemetry();
  }

  getCarControls(carIndex: number): any {
    return this.rosterController.getCarControls(carIndex);
  }

  async applyRosterAndStartMatch(): Promise<void> {
    return this.lifecycleController.applyRosterAndStartMatch(
      this.rosterController,
      this.replaySession
    );
  }

  triggerSandboxAction(action: string): void {
    this.lifecycleController.triggerSandboxAction(
      action,
      this.rosterController,
      this.replaySession
    );
  }

  skipGoalReplay(): void {
    if (!this.replaySession.isReplayActive && this.lifecycleController.goalResetTicks <= 0) return;
    this.lifecycleController.goalResetTicks = 0;
    this.lifecycleController.completePostGoalOrReplayTransition(
      this.rosterController,
      this.replaySession
    );
  }

  onPhysicsEvent(event: any): void {
    this.simulationController.onPhysicsEvent(
      event,
      this.rosterController,
      this.replaySession,
      this.lifecycleController
    );
  }

  onBeforePhysicsTick(): boolean {
    return this.simulationController.stepBeforePhysics(
      this.rosterController,
      this.replaySession,
      this.lifecycleController
    );
  }

  onAfterPhysicsTick(): void {
    this.simulationController.stepAfterPhysics(
      this.rosterController,
      this.replaySession,
      this.lifecycleController
    );
  }

  update(context: any): void {
    const r = this.runtime;
    const unlimited = Boolean(useExperimentalMultiBotsStore.getState().unlimitedBoost);

    if (
      this.lifecycleController.isMatchEnded &&
      this.lifecycleController.podiumController?.isActive
    ) {
      this.lifecycleController.podiumController.update(context);
      return;
    }

    if (
      this.replaySession.isReplayActive &&
      this.replaySession.replayController.sessionState.isActive
    ) {
      this.replaySession.stepUpdate(context, unlimited, this.rosterController, () =>
        this.lifecycleController.completePostGoalOrReplayTransition(
          this.rosterController,
          this.replaySession
        )
      );
      return;
    }

    const { playerCarView } = context;
    if (playerCarView) {
      const activeCarIdx = context.activeCar ?? r?.playerCarIndex ?? 0;
      const carUnlimited = r?.physics?.getCarUnlimitedBoost?.(activeCarIdx) ?? unlimited;
      hudStore.getState().setBoost(playerCarView.boost, playerCarView.isBoosting, carUnlimited);
    }
  }

  onResetKickoff(): void {
    this.applyRosterAndStartMatch();
  }
}
