import { BaseGameMode } from './BaseGameMode.ts';
import { StaticTrainingVisuals } from './StaticTrainingVisuals.ts';
import {
  useAppStore,
  useStaticTrainingPackStore,
  getActiveEditItemVariable,
  hudStore,
} from '../runtimeUiPort.ts';
import { getPreferredFreeplayTeam } from '../../ui-core/config/vehiclePresets';
import {
  StaticTrainingEditSubMode,
  StaticTrainingShotConfig,
} from './static-training/ShotGizmoMath.ts';
import { StaticTrainingArenaController } from './static-training/StaticTrainingArenaController.ts';
import { StaticTrainingReplayController } from './static-training/StaticTrainingReplayController.ts';
import { StaticTrainingShotEditor } from './static-training/StaticTrainingShotEditor.ts';
import { StaticTrainingSimulationController } from './static-training/StaticTrainingSimulationController.ts';
import { applyTrainingVariationsToShot } from './static-training/staticTrainingVariationMath.ts';

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
    if (r?.keyboard) {
      r.keyboard.ballControlEnabled = false;
    }
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
    const r = this.runtime;
    this.editor.unbindSessionEvents();
    this.editor.resetInputState();
    this.arenaController.clearEditBallOpacityOverride();

    this.replaySession.abortSession();
    this.replaySession.clearBuffer();
    this.visuals?.setVisible(false);

    if (r) {
      r.camera?.setEditorOverride?.(false);
      r.releaseGoalReplayCameraOverride();
      if (r.ballTrajectoryPredictor) {
        r.ballTrajectoryPredictor.forcePredictAnyMovement = false;
        r.ballTrajectoryPredictor.clearStaticPreview?.();
        r.ballTrajectoryPredictor.clear?.();
      }
      if (r.camera?.isFreeCam) {
        r.camera.setFreeCam(false);
      }
      if (r.keyboard) {
        r.keyboard.ballControlEnabled = true;
      }
      const innerBallMesh = r.arena?.ball?.children?.[0];
      if (innerBallMesh) {
        innerBallMesh.quaternion.identity();
      }
    }

    hudStore.getState().setReplayState({
      replayPaused: false,
      replayPersistent: false,
    });
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

  private _bindStoreRuntimeHandlers(): void {
    useStaticTrainingPackStore.getState().setRuntimeHandlers({
      onShotChanged: () => {
        if (!this._ensureActiveMode('onShotChanged')) return;
        this.isFreeCamTrajectoryTesting = false;
        this.isTestingSingleShot = false;
        const s = useStaticTrainingPackStore.getState();
        s.setFreeCamTrajectoryTesting(false);
        s.setTestingSingleShot(false);
        this.reloadCurrentShot();
      },
      onSessionModeChanged: () => {
        if (!this._ensureActiveMode('onSessionModeChanged')) return;
        this.isFreeCamTrajectoryTesting = false;
        this.isTestingSingleShot = false;
        const s = useStaticTrainingPackStore.getState();
        s.setFreeCamTrajectoryTesting(false);
        s.setTestingSingleShot(false);
        this.reloadCurrentShot();
      },
      onEditSubModeChanged: (subMode: StaticTrainingEditSubMode) => {
        if (!this._ensureActiveMode('onEditSubModeChanged')) return;
        if (this.isFreeCamTrajectoryTesting) {
          this.stopFreeCamTrajectoryTest();
        }
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
      this.reloadCurrentShot();
    } else {
      if (this.isFreeCamTrajectoryTesting) {
        this.isFreeCamTrajectoryTesting = false;
        store.setFreeCamTrajectoryTesting(false);
      }
      this.isTestingSingleShot = true;
      store.setTestingSingleShot(true);
      this.reloadCurrentShot();
    }
  }

  _getCurrentShotConfig(): StaticTrainingShotConfig | null {
    const store = useStaticTrainingPackStore.getState();
    if (store.sessionMode === 'edit' && store.isEditingItem) {
      const editVar = getActiveEditItemVariable();
      if (editVar) return editVar;
    }
    const pack = store.activePack;
    if (!pack || !Array.isArray(pack.items) || pack.items.length === 0) {
      return null;
    }
    const idx = Math.max(0, Math.min(pack.items.length - 1, store.currentShotIndex));
    return pack.items[idx] || pack.items[0];
  }

  reloadCurrentShot(): void {
    const r = this.runtime;
    if (!r?.physics) {
      console.warn('[StaticTrainingPackMode] reloadCurrentShot ignored: physics engine is not initialized.');
      return;
    }

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
    if (!shot) {
      console.warn('[StaticTrainingPackMode] reloadCurrentShot ignored: no active training shot configuration found.');
      return;
    }

    const isPlayableSession = store.sessionMode === 'play' || this.isTestingSingleShot;
    this.arenaController.ensureSinglePlayerCar();
    const preferredTeam = getPreferredFreeplayTeam();
    const enableFToMirror =
      store.variationToggles?.enableFToMirror !== false &&
      useAppStore.getState().gameplay?.enableFToMirror !== false;
    const activeMeta = store.activePack?.metadata;
    const effectiveShot = applyTrainingVariationsToShot({
      shot,
      toggles: store.variationToggles || {
        enableCustomVariationOverride: false,
        moreBoostAmount: 0,
        disableBallVariance: false,
        disableVehicleVariance: false,
        disableAllRandomAngularVelocity: false,
        disableRLRCSPackAngularVelocity: true,
        enableFToMirror: true,
      },
      customVariation: store.customVariation || {
        ballSpeedModifierPct: [0, 0],
        ballLocationModifierXY: [0, 0],
        ballHeightModifierZ: [0, 0],
        ballRotationModifierDeg: [0, 0],
        ballSpinModifier: [0, 0],
        vehicleSpeedRange: null,
        vehicleLocationModifier: [0, 0],
        vehicleRotationModifierDeg: [0, 0],
        boostLimitOverride: null,
        forceSpawnVehicleOnGround: false,
        forceUnlimitedBoost: false,
      },
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
      store.updateLiveTelemetry({
        remainingTimeoutSec: timeoutSec,
        activeCountdownSec: 0,
        isShotLaunched: false,
        isOvertimeWaitGround: false,
        isReplayActive: false,
        replayType: null,
      });
    } else {
      if (r.camera?.isFreeCam) {
        r.camera.setFreeCam(false);
      }
      r.camera?.resetView?.();

      store.updateLiveTelemetry({
        remainingTimeoutSec: timeoutSec,
        activeCountdownSec: store.downCounterEnabled ? store.downCounterValue : 0,
        isShotLaunched: false,
        isOvertimeWaitGround: false,
        isReplayActive: false,
        replayType: null,
      });
    }

    if (r.match?.state) {
      r.match.state.phase = 'playing';
    }
    hudStore.getState().setMatchState({
      matchPhase: 'playing',
      kickoffCountdown: 0,
      replayScorerName: null,
      replayScorerTeam: null,
      replayBallSpeedKph: null,
      replayAssistName: null,
    });
    hudStore.getState().setReplayState({
      replayPaused: false,
      replayPersistent: false,
    });
  }

  onPhysicsEvent(event: any): void {
    this.simulationController.onPhysicsEvent(
      event,
      this.arenaController,
      this.replaySession
    );
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
      () => this.replaySession.completeSessionAndAdvance(
        this.isTestingSingleShot,
        () => this.reloadCurrentShot()
      )
    );
  }

  skipGoalReplay(): void {
    if (!this.replaySession.isReplayActive && this.simulationController.goalResetTicks <= 0) return;
    this.simulationController.goalResetTicks = 0;
    this.replaySession.completeSessionAndAdvance(
      this.isTestingSingleShot,
      () => this.reloadCurrentShot()
    );
  }

  update(context: any): void {
    const dt = context.dt ?? 0.016;
    const store = useStaticTrainingPackStore.getState();
    this.arenaController.syncEditBallOpacityOverride(
      this.isTestingSingleShot,
      this.replaySession.isReplayActive
    );

    if (this.replaySession.isReplayActive && this.replaySession.replayController.sessionState.isActive) {
      this.replaySession.stepUpdate(
        context,
        dt,
        this.arenaController.stagedShot,
        this.visuals,
        () => this.replaySession.completeSessionAndAdvance(
          this.isTestingSingleShot,
          () => this.reloadCurrentShot()
        )
      );
      return;
    }

    if (store.sessionMode === 'edit' && !this.isTestingSingleShot) {
      this.editor.updateCameraAndContinuousInputs(dt);
      const shot = this._getCurrentShotConfig();
      if (!this.isFreeCamTrajectoryTesting) {
        this.arenaController.spinBallMeshInPlace(dt);
        if (shot) {
          const configuredCarSpeed = Math.max(0, Number(shot.car?.speed) || 0);
          context.overrideCarSpeed = configuredCarSpeed;
          context.isSupersonic = configuredCarSpeed >= 2200;
          const boostVal = shot.car?.unlimitedBoost
            ? 100
            : Math.max(0, Math.min(100, Number(shot.car?.initialBoost) || 0));
          hudStore.getState().setBoost(boostVal, false, Boolean(shot.car?.unlimitedBoost));
        }
      }
      if (this.visuals && shot) {
        this.visuals.update(shot, store.editSubMode, false);
      }
      return;
    }

    const isPreLaunch =
      this.simulationController.playPhase === 'countdown' ||
      this.simulationController.playPhase === 'waiting-input';
    if (isPreLaunch) {
      this.arenaController.spinBallMeshInPlace(dt);
      if (this.arenaController.stagedShot) {
        const configuredCarSpeed = Math.max(
          0,
          Number(this.arenaController.stagedShot.car?.speed) || 0
        );
        context.overrideCarSpeed = configuredCarSpeed;
        context.isSupersonic = configuredCarSpeed >= 2200;
      }
    }

    if (this.visuals && this.arenaController.stagedShot) {
      if (isPreLaunch) {
        this.visuals.update(this.arenaController.stagedShot, 'play', true);
      } else {
        this.visuals.setVisible(false);
      }
    }

    const { playerCarView } = context;
    if (playerCarView) {
      hudStore.getState().setBoost(
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
