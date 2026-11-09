import { BaseGameMode } from '../BaseGameMode.ts';
import { StaticTrainingVisuals } from './StaticTrainingVisuals.ts';
import {
  useAppStore,
  useStaticTrainingPackStore,
  getActiveEditItemVariable,
  hudStore,
} from '../../runtimeUiPort.ts';
import { getPreferredFreeplayTeam } from '../../../ui-core/config/vehiclePresets.ts';
import { type StaticTrainingEditSubMode, type StaticTrainingShotConfig } from './ShotGizmoMath.ts';
import { StaticTrainingArenaController } from './StaticTrainingArenaController.ts';
import { StaticTrainingReplayController } from './StaticTrainingReplayController.ts';
import { StaticTrainingShotEditor } from './StaticTrainingShotEditor.ts';
import { StaticTrainingSimulationController } from './StaticTrainingSimulationController.ts';
import { applyTrainingVariationsToShot } from './staticTrainingVariationMath.ts';

const DEFAULT_VARIATION_TOGGLES = {
  enableCustomVariationOverride: false,
  moreBoostAmount: 0,
  disableBallVariance: false,
  disableVehicleVariance: false,
  disableAllRandomAngularVelocity: false,
  disableRLRCSPackAngularVelocity: true,
  enableFToMirror: true,
};

const DEFAULT_CUSTOM_VARIATION = {
  ballSpeedModifierPct: [0, 0] as [number, number],
  ballLocationModifierXY: [0, 0] as [number, number],
  ballHeightModifierZ: [0, 0] as [number, number],
  ballRotationModifierDeg: [0, 0] as [number, number],
  ballSpinModifier: [0, 0] as [number, number],
  vehicleSpeedRange: null,
  vehicleLocationModifier: [0, 0] as [number, number],
  vehicleRotationModifierDeg: [0, 0] as [number, number],
  boostLimitOverride: null,
  forceSpawnVehicleOnGround: false,
  forceUnlimitedBoost: false,
};

export class StaticTrainingPackMode extends BaseGameMode {
  public readonly arenaController: StaticTrainingArenaController;
  public readonly replaySession: StaticTrainingReplayController;
  public readonly editor: StaticTrainingShotEditor;
  public readonly simulationController: StaticTrainingSimulationController;

  public visuals: StaticTrainingVisuals | null = null;
  public isFreeCamTrajectoryTesting = false;
  public isTestingSingleShot = false;

  constructor(runtime: any) {
    super('static-training-pack', runtime);

    this.arenaController = new StaticTrainingArenaController(runtime);
    this.replaySession = new StaticTrainingReplayController(runtime);
    this.simulationController = new StaticTrainingSimulationController(runtime);
    this.editor = new StaticTrainingShotEditor({
      getRuntime: () => this.runtime,
      isReplayActive: () => this.replaySession.isReplayActive,
      getReplayController: () => this.replaySession.replayController,
      isTestingSingleShot: () => this.isTestingSingleShot,
      isFreeCamTrajectoryTesting: () => this.isFreeCamTrajectoryTesting,
      getCurrentShotConfig: () => this._getCurrentShotConfig(),
      reloadCurrentShot: () => this.reloadCurrentShot(),
      toggleSingleShotTest: () => this.toggleSingleShotTest(),
      toggleFreeCamTrajectoryTest: () => this.toggleFreeCamTrajectoryTest(),
      stopFreeCamTrajectoryTest: () => this.stopFreeCamTrajectoryTest(),
    });
  }

  get replayRingBuffer() {
    return this.replaySession.replayRingBuffer;
  }
  get replayController() {
    return this.replaySession.replayController;
  }
  get isReplayActive(): boolean {
    return this.replaySession.isReplayActive;
  }
  set isReplayActive(val: boolean) {
    this.replaySession.isReplayActive = val;
  }
  get replayCameraMode() {
    return this.replaySession.replayCameraMode;
  }
  set replayCameraMode(val: 'director' | 'pov') {
    this.replaySession.replayCameraMode = val;
  }
  get playPhase() {
    return this.simulationController.playPhase;
  }
  get stagedShot(): StaticTrainingShotConfig | null {
    return this.arenaController.stagedShot;
  }

  onEnter(): void {
    const r = this.runtime;
    if (r?.authoritativeServer) {
      r.authoritativeServer.stop?.();
      r.authoritativeServer = null;
    }
    if (r?.networkReconciler) {
      r.networkReconciler.dispose?.();
      r.networkReconciler = null;
    }
    if (r?.keyboard) r.keyboard.ballControlEnabled = false;
    this.replaySession.attachPhysicsIfNeeded();
    if (!this.visuals && r?.arena?.scene) {
      this.visuals = new StaticTrainingVisuals(r.arena.scene);
    }

    this.arenaController.ensureSinglePlayerCar();
    this.editor.bindSessionEvents();
    this._bindStoreRuntimeHandlers();

    const store = useStaticTrainingPackStore.getState();
    const activeScope = store.storageScope === 'dev' ? 'dev' : 'normal';
    const isScopeReady = activeScope === 'dev' ? store.devInitialized : store.initialized;
    if (!isScopeReady && !store.activePack) {
      store.initStore(activeScope).then(() => {
        if (this.runtime?.match?.state?.mode === 'static-training-pack') {
          this.reloadCurrentShot();
        }
      });
    } else {
      this.reloadCurrentShot();
    }
  }

  onLeave(): void {
    this.editor.unbindSessionEvents();
    this.editor.resetInputState();
    this.replaySession.abortSession();
    this.replaySession.clearBuffer();
    this.visuals?.setVisible(false);
    this.arenaController.teardownRuntimeModeExit();

    hudStore.getState().setReplayState({ replayPaused: false, replayPersistent: false });
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      kickoffCountdown: 0,
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
  }

  private _ensureActiveMode(actionName: string): boolean {
    const activeMode = this.runtime?.match?.state?.mode;
    if (activeMode !== 'static-training-pack') {
      console.warn(
        `[StaticTrainingPackMode] ${actionName} ignored: active mode is "${activeMode ?? 'none'}", requires "static-training-pack".`
      );
      return false;
    }
    return true;
  }

  private _resetTestFlagsAndReload(): void {
    this.isFreeCamTrajectoryTesting = false;
    this.isTestingSingleShot = false;
    const s = useStaticTrainingPackStore.getState();
    s.setFreeCamTrajectoryTesting(false);
    s.setTestingSingleShot(false);
    this.reloadCurrentShot();
  }

  private _bindStoreRuntimeHandlers(): void {
    useStaticTrainingPackStore.getState().setRuntimeHandlers({
      onShotChanged: () => {
        if (this._ensureActiveMode('onShotChanged')) this._resetTestFlagsAndReload();
      },
      onSessionModeChanged: () => {
        if (this._ensureActiveMode('onSessionModeChanged')) this._resetTestFlagsAndReload();
      },
      onEditSubModeChanged: (subMode: StaticTrainingEditSubMode) => {
        if (!this._ensureActiveMode('onEditSubModeChanged')) return;
        if (this.isFreeCamTrajectoryTesting) this.stopFreeCamTrajectoryTest();
        this.editor.applyEditSubModeCamera(subMode);
      },
      onEditVariableMutated: (item: StaticTrainingShotConfig) => {
        if (!this._ensureActiveMode('onEditVariableMutated')) return;
        const s = useStaticTrainingPackStore.getState();
        if (this.isFreeCamTrajectoryTesting) {
          this.isFreeCamTrajectoryTesting = false;
          s.setFreeCamTrajectoryTesting(false);
        }
        const timeoutSec = Math.max(1, Math.min(60, Number(item?.timeoutSeconds) || 10));
        this.simulationController.setTimeoutSeconds(timeoutSec);
        if (s.remainingTimeoutSec !== timeoutSec) {
          s.updateLiveTelemetry({ remainingTimeoutSec: timeoutSec });
        }
        this.arenaController.applyStagedShot(
          item,
          true,
          this.editor.isLeftMouseDragging,
          this.replaySession.replayRingBuffer
        );
      },
      onResetShotRequested: () => {
        if (this._ensureActiveMode('onResetShotRequested')) this.reloadCurrentShot();
      },
    });
  }

  toggleFreeCamTrajectoryTest(): void {
    if (this.isFreeCamTrajectoryTesting) {
      this.stopFreeCamTrajectoryTest();
      return;
    }
    if (this.isTestingSingleShot) {
      this.isTestingSingleShot = false;
      useStaticTrainingPackStore.getState().setTestingSingleShot(false);
    }
    this.isFreeCamTrajectoryTesting = true;
    useStaticTrainingPackStore.getState().setFreeCamTrajectoryTesting(true);
    this.arenaController.launchFreeCamTrajectoryPreview(
      this.editor.isLeftMouseDragging,
      this.replaySession.replayRingBuffer
    );
  }

  stopFreeCamTrajectoryTest(): void {
    if (!this.isFreeCamTrajectoryTesting) return;
    this.isFreeCamTrajectoryTesting = false;
    useStaticTrainingPackStore.getState().setFreeCamTrajectoryTesting(false);
    const shot = this._getCurrentShotConfig();
    if (shot) {
      this.arenaController.applyStagedShot(
        shot,
        true,
        this.editor.isLeftMouseDragging,
        this.replaySession.replayRingBuffer
      );
    }
  }

  toggleSingleShotTest(): void {
    const store = useStaticTrainingPackStore.getState();
    if (this.isTestingSingleShot) {
      this.isTestingSingleShot = false;
      store.setTestingSingleShot(false);
    } else {
      if (this.isFreeCamTrajectoryTesting) {
        this.isFreeCamTrajectoryTesting = false;
        store.setFreeCamTrajectoryTesting(false);
      }
      this.isTestingSingleShot = true;
      store.setTestingSingleShot(true);
    }
    this.reloadCurrentShot();
  }

  _getCurrentShotConfig(): StaticTrainingShotConfig | null {
    const store = useStaticTrainingPackStore.getState();
    if (store.sessionMode === 'edit' && store.isEditingItem) {
      const editVar = getActiveEditItemVariable();
      if (editVar) return editVar;
    }
    const items = store.activePack?.items;
    if (!Array.isArray(items) || items.length === 0) return null;
    const idx = Math.max(0, Math.min(items.length - 1, store.currentShotIndex));
    return items[idx] || items[0];
  }

  reloadCurrentShot(): void {
    const r = this.runtime;
    if (!r?.physics) return;

    this.replaySession.abortSession();
    this.isFreeCamTrajectoryTesting = false;
    this.replaySession.clearBuffer();
    r.camera?.setEditorOverride?.(false);
    r.releaseGoalReplayCameraOverride();

    const store = useStaticTrainingPackStore.getState();
    store.setFreeCamTrajectoryTesting(false);
    this.arenaController.syncEditBallOpacityOverride(
      this.isTestingSingleShot,
      this.replaySession.isReplayActive,
      true
    );
    const shot = this._getCurrentShotConfig();
    if (!shot) return;

    const isPlayableSession = store.sessionMode === 'play' || this.isTestingSingleShot;
    this.arenaController.ensureSinglePlayerCar();
    const preferredTeam = getPreferredFreeplayTeam();
    const enableFToMirror =
      store.variationToggles?.enableFToMirror !== false &&
      useAppStore.getState().gameplay?.enableFToMirror !== false;
    const activeMeta = store.activePack?.metadata;
    const effectiveShot = applyTrainingVariationsToShot({
      shot,
      toggles: store.variationToggles || DEFAULT_VARIATION_TOGGLES,
      customVariation: store.customVariation || DEFAULT_CUSTOM_VARIATION,
      recommendedVariation: activeMeta?.recommendedVariation,
      sourcePackType: activeMeta?.sourcePackType,
      isPlayOrTestSession: isPlayableSession,
      invertForOrangeTeam: preferredTeam === 1,
      mirrorHorizontal: Boolean(store.isShotMirrored) && enableFToMirror,
    });

    this.arenaController.applyStagedShot(
      effectiveShot,
      false,
      this.editor.isLeftMouseDragging,
      this.replaySession.replayRingBuffer
    );

    const timeoutSec = Math.max(1, Math.min(60, Number(effectiveShot.timeoutSeconds) || 10));
    this.simulationController.configureShotSession(
      timeoutSec,
      isPlayableSession,
      Boolean(store.downCounterEnabled),
      Number(store.downCounterValue) || 1
    );

    if (!isPlayableSession) {
      this.editor.applyEditSubModeCamera(store.editSubMode as StaticTrainingEditSubMode);
    } else {
      if (r.camera?.isFreeCam) r.camera.setFreeCam(false);
      r.camera?.resetView?.();
    }

    store.updateLiveTelemetry({
      remainingTimeoutSec: timeoutSec,
      activeCountdownSec:
        isPlayableSession && store.downCounterEnabled ? store.downCounterValue : 0,
      isShotLaunched: false,
      isOvertimeWaitGround: false,
      isReplayActive: false,
      replayType: null,
    });

    if (r.match?.state) r.match.state.phase = 'playing';
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      kickoffCountdown: 0,
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
    hudStore.getState().setReplayState({ replayPaused: false, replayPersistent: false });
  }

  onPhysicsEvent(event: any): void {
    this.simulationController.onPhysicsEvent(event, this.arenaController, this.replaySession);
  }

  onBeforePhysicsTick(): boolean {
    return this.simulationController.stepBeforePhysics(
      this.arenaController,
      this.replaySession,
      this.isTestingSingleShot,
      this.isFreeCamTrajectoryTesting
    );
  }

  onAfterPhysicsTick(): void {
    this.simulationController.stepAfterPhysics(
      this.arenaController,
      this.replaySession,
      this.isTestingSingleShot,
      this.isFreeCamTrajectoryTesting,
      () =>
        this.replaySession.completeSessionAndAdvance(this.isTestingSingleShot, () =>
          this.reloadCurrentShot()
        )
    );
  }

  skipGoalReplay(): void {
    if (!this.replaySession.isReplayActive && this.simulationController.goalResetTicks <= 0) return;
    this.simulationController.goalResetTicks = 0;
    this.replaySession.completeSessionAndAdvance(this.isTestingSingleShot, () =>
      this.reloadCurrentShot()
    );
  }

  update(context: any): void {
    const dt = context.dt ?? 0.016;
    const store = useStaticTrainingPackStore.getState();
    this.arenaController.syncEditBallOpacityOverride(
      this.isTestingSingleShot,
      this.replaySession.isReplayActive
    );

    if (
      this.replaySession.isReplayActive &&
      this.replaySession.replayController.sessionState.isActive
    ) {
      this.replaySession.stepUpdate(
        context,
        dt,
        this.arenaController.stagedShot,
        this.visuals,
        () =>
          this.replaySession.completeSessionAndAdvance(this.isTestingSingleShot, () =>
            this.reloadCurrentShot()
          )
      );
      return;
    }

    if (store.sessionMode === 'edit' && !this.isTestingSingleShot) {
      this.editor.updateCameraAndContinuousInputs(dt);
      const shot = this._getCurrentShotConfig();
      if (!this.isFreeCamTrajectoryTesting) {
        this.arenaController.applyPreLaunchCarHudOverride(context, shot, dt, true);
      }
      if (this.visuals && shot) this.visuals.update(shot, store.editSubMode, false);
      return;
    }

    const isPreLaunch =
      this.simulationController.playPhase === 'countdown' ||
      this.simulationController.playPhase === 'waiting-input';
    if (isPreLaunch) {
      this.arenaController.applyPreLaunchCarHudOverride(
        context,
        this.arenaController.stagedShot,
        dt,
        false
      );
    }

    if (this.visuals && this.arenaController.stagedShot) {
      if (isPreLaunch) this.visuals.update(this.arenaController.stagedShot, 'play', true);
      else this.visuals.setVisible(false);
    }

    const { playerCarView } = context;
    if (playerCarView) {
      hudStore
        .getState()
        .setBoost(
          playerCarView.boost,
          playerCarView.isBoosting,
          Boolean(this.arenaController.stagedShot?.car?.unlimitedBoost)
        );
    }
  }

  onResetKickoff(): void {
    this.reloadCurrentShot();
  }
}
