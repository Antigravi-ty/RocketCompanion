import { RuntimeBloomOcclusion } from './runtime/RuntimeBloomOcclusion.js';
import { RuntimeBotCoordinator } from './runtime/RuntimeBotCoordinator.js';
import { RuntimeNetworkManager } from './runtime/RuntimeNetworkManager.js';
import { RuntimeDOMEventManager } from './runtime/RuntimeDOMEventManager.js';
import {
  setupRuntimePhysics,
  setupRuntimeScene,
  destroyRuntimeInstance
} from './runtime/RuntimeSceneBootstrap.js';
import { pollRuntimeInputs } from './runtime/RuntimeInputPoller.js';
import { useAppStore } from '../ui-core/stores/appStore';
import { determinismStore } from '../ui-core/stores/determinismStore';
import { networkDiagnosticsStore } from '../ui-core/stores/networkDiagnosticsStore';
import { toggleFloatingPreset } from '../ui-core/stores/floatingStore';
import {
  NETWORK_MONITOR_PRESET,
  DUAL_ARENA_DETERMINISM_HARNESS_PRESET
} from '../ui-core/stores/floatingPresets';
import {
  CAR_COLOR_SLOTS,
  packLoadoutCommandParam1,
  packLoadoutCommandParam2,
  resolveVehicleHitboxId
} from "../ui-core/config/vehicleConstants.js";
import { getMaterialsConfig } from "../ui-core/config/materialsConfig.js";
import { gameAudio } from "../audio/GameAudioEngineFacade.js";
import { CLIENT_COMMAND_TYPES } from '../network/protocol/GlobalPayloadCodec.js';
import { RenderClockScheduler } from './RenderClockScheduler.js';
import { DEFAULT_TRAINING_SETTINGS } from '../ui-core/config/trainingDefaults.js';
import { FlipResetVisual } from '../effects/FlipResetVisual.js';
import { PerformanceProfiler } from '../utils/PerformanceProfiler.js';

// --- Architecture Pipeline & Modular Subsystems ---
import { FramePipeline } from './pipeline/FramePipeline.js';
import { InputStage } from './pipeline/stages/InputStage.js';
import { SimulationStage } from './pipeline/stages/SimulationStage.js';
import { GameplayModeStage } from './pipeline/stages/GameplayModeStage.js';
import { PresentationStage } from './pipeline/stages/PresentationStage.js';
import { AudioStage } from './pipeline/stages/AudioStage.js';
import { RenderStage } from './pipeline/stages/RenderStage.js';
import { TelemetryStage } from './pipeline/stages/TelemetryStage.js';

import { GameAudioSubsystem } from './subsystems/GameAudioSubsystem.js';
import { GameCameraSubsystem } from './subsystems/GameCameraSubsystem.js';
import { GameRenderSubsystem } from './subsystems/GameRenderSubsystem.js';
import { GameModeManager } from './modes/GameModeManager.js';

export const PLAYER_CAR_INDEX = 0;
export const BOT_CAR_INDEX = 1;

export class GameRuntime {
  constructor(container, options = {}) {
    this.container = container || (typeof document !== 'undefined' ? document.querySelector('#app') : null);
    this.options = options;

    this.physics = null;
    this.interpolator = null;
    this.match = null;
    this.bot = null;
    this.arena = null;
    this.entityManager = null;
    this.camera = null;
    this.renderer = null;
    this.composer = null;
    this.boostBloom = null;
    this.bloomEnabled = false;
    this.speedLinesPass = null;
    this.flipResetVisuals = new Map();
    this.clockScheduler = null;

    this.keyboard = null;
    this.gamepad = null;
    this.gameUI = null;
    this.profiler = new PerformanceProfiler();
    this.physicsRate = 120;
    this.ballTrajectoryPredictor = null;
    this.determinismHarness = null;
    this.networkChannel = null;
    this.networkReconciler = null;
    this.authoritativeServer = null;
    this.multiplayerSession = null;

    this.playerCarIndex = PLAYER_CAR_INDEX;
    this.neutralControls = {
      throttle: 0,
      steer: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      jump: false,
      boost: false,
      handbrake: false
    };
    this.botControls = { ...this.neutralControls };
    this.botTickSkip = 0;
    this.isBotDeciding = false;
    this.botDecisionEpoch = 0;
    this.botKickoffStep = 0;
    this.isBotPaused = false;
    this.isBotMatch = false;
    this.lobbyGhostMode = false;
    this.playerControls = { ...this.neutralControls };
    this.playerThrottle = 0;
    this.lastKickoffCountdownSec = -1;

    this.openOverlays = new Set();
    this.isCursorBrowsing = false;
    this.bloomOcclusion = new RuntimeBloomOcclusion(this);
    this.botCoordinator = new RuntimeBotCoordinator(this);
    this.networkManager = new RuntimeNetworkManager(this);
    this.domEventManager = new RuntimeDOMEventManager(this);
    this.pendingClickToPlay = false;
    this.gamepadSettingsJustClosed = false;
    this.lastGamepadId = null;
    this.lastGamepadButton8 = false;
    this.trainingOptions = { ...DEFAULT_TRAINING_SETTINGS };

    this.bloomOccluderMeshes = [];
    this.bloomSavedMaterials = [];
    this.bloomInvisibleObjects = [];
    this.bloomHiddenObjects = [];
    this.lastBloomTreeVersion = -1;
    this.lastBloomActive = true;
    this.bloomDarkMaterial = null;

    this.lastTimestamp = performance.now();
    this.activeGraphicsSettings = null;
    this.running = false;

    this.audioSubsystem = new GameAudioSubsystem(this);
    this.cameraSubsystem = new GameCameraSubsystem(this);
    this.renderSubsystem = new GameRenderSubsystem(this);
    this.modeManager = new GameModeManager(this);

    this.pipeline = new FramePipeline(this)
      .addStage(new InputStage(this))
      .addStage(new SimulationStage(this))
      .addStage(new GameplayModeStage(this))
      .addStage(new PresentationStage(this))
      .addStage(new AudioStage(this))
      .addStage(new RenderStage(this))
      .addStage(new TelemetryStage(this));
  }

  get engineSynths() { return this.audioSubsystem.engineSynths; }
  set engineSynths(v) { this.audioSubsystem.engineSynths = v; }
  get scratchGroundNormal() { return this.cameraSubsystem.scratchGroundNormal; }
  get scratchVelocity() { return this.cameraSubsystem.scratchVelocity; }
  get cameraDynamics() { return this.cameraSubsystem.cameraDynamics; }

  async setupPhysics(options = {}) {
    return setupRuntimePhysics(this, options);
  }

  getFlipResetVisual(carIndex) {
    if (this.flipResetVisuals.has(carIndex)) {
      return this.flipResetVisuals.get(carIndex);
    }
    const carRoot = this.arena?.cars?.[carIndex];
    if (carRoot) {
      const visual = new FlipResetVisual(carRoot);
      this.flipResetVisuals.set(carIndex, visual);
      return visual;
    }
    return null;
  }

  get flipResetVisual() { return this.getFlipResetVisual(this.playerCarIndex); }
  set flipResetVisual(v) {
    if (v) this.flipResetVisuals.set(this.playerCarIndex, v);
  }

  _bindReconcilerSignals(reconciler) {
    return this.networkManager._bindReconcilerSignals(reconciler);
  }

  async setupScene(onProgress = null) { return setupRuntimeScene(this, onProgress); }
  async setupAudio(onProgress = null) { return this.audioSubsystem.setupAudio(onProgress); }
  async setupBot(onProgress = null) { return this.botCoordinator.setupBot(onProgress); }
  async setupShaders(onProgress = null) { return this.bloomOcclusion.setupShaders(onProgress); }

  ignite() {
    this.boostBloom?.clear?.();
    if (this.renderer?.shadowMap) this.renderer.shadowMap.needsUpdate = true;
    this.composer?.render?.(0);
    this.lastTimestamp = performance.now();
    this.interpolator.sync(this.lastTimestamp);
    this.start();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const glContext = this.renderer ? this.renderer.getContext() : null;
    this.clockScheduler = new RenderClockScheduler(
      glContext,
      timestamp => this.renderFrame(timestamp),
      timestamp => this.profiler && this.profiler.displayFrame(timestamp),
      timestamp => this.stepSimulation(timestamp)
    );
    if (this.activeGraphicsSettings) {
      this.clockScheduler.setFpsLimit(
        this.activeGraphicsSettings.limitFps ? this.activeGraphicsSettings.maxFps : null
      );
    }
    this.updateInteractionState();
    this.clockScheduler.start();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.clockScheduler) this.clockScheduler.stop();
  }

  renderFrame(timestamp) { return this.pipeline.execute(timestamp); }
  stepSimulation(timestamp) { return this.pipeline.executeSimulationOnly(timestamp); }

  triggerGameAudioEvents(goalScored, curBoost, isSupersonic, curr) {
    return this.audioSubsystem.triggerGameAudioEvents(goalScored, curBoost, isSupersonic, curr);
  }

  pollInputs(commitPhysicsStep = true) { return pollRuntimeInputs(this, commitPhysicsStep); }

  async enableNetworkPrediction(showHUD = true, options = {}) {
    return this.networkManager.enableNetworkPrediction(showHUD, options);
  }

  changePlayerVehicle(visualId, hitboxId = null) {
    const resolvedHitboxId = hitboxId || resolveVehicleHitboxId(visualId);
    this.selectedPreset = visualId;
    this.selectedHitbox = resolvedHitboxId;
    const expMode = this.modeManager?.activeMode?.id === 'exp-multi-bots' ? this.modeManager.activeMode : null;
    const targetCarIdx = (expMode && expMode.humanPlayerCarIndex >= 0) ? expMode.humanPlayerCarIndex : this.playerCarIndex;

    if (this.entityManager) {
      this.entityManager.hotSwapVehicle(targetCarIdx, { visual: visualId, hitbox: resolvedHitboxId });
    } else {
      this.arena?.swapCarVisual?.(targetCarIdx, visualId);
      this.physics?.setCarHitbox?.(targetCarIdx, resolvedHitboxId);
    }

    if (this.arena?.cars?.[targetCarIdx]) {
      this.flipResetVisual?.dispose?.();
      try {
        this.getFlipResetVisual(targetCarIdx);
      } catch (err) {
        console.warn("[GameRuntime] FlipResetVisual re-bind skipped:", err);
      }
      this.camera?.update?.(this.arena.cars[this.playerCarIndex], this.arena.ball, 0, this.cameraDynamics);
    }

    const colorSlotId = this.selectedColorSlot ?? 0;
    const matCfg = getMaterialsConfig();
    const paintFinish = matCfg?.paintFinish || 'metallic';
    const boostVisual = matCfg?.boostVisual || 'gold-rush';
    const boostAudio = matCfg?.boostAudio || 'rush';
    this.arena?.setCarLoadout?.(targetCarIdx, { paintFinish, boostVisual, boostAudio });
    (this.options?.gameAudio || gameAudio)?.setCarBoostAudioVariation?.(targetCarIdx, boostAudio);

    if (expMode) {
      const entry = expMode.spawnedCars?.[targetCarIdx];
      if (entry) {
        entry.visualId = visualId;
        entry.hitboxId = resolvedHitboxId;
        entry.paintFinish = paintFinish;
        entry.boostVisual = boostVisual;
        entry.boostAudio = boostAudio;
        expMode._publishSpawnedCarsTelemetry?.();
      }
    }

    if (this.authoritativeServer) {
      this.authoritativeServer.setLoadout?.(
        'host',
        visualId,
        colorSlotId,
        resolvedHitboxId,
        { paintFinish, boostVisual, boostAudio }
      );
    }
    if (this.networkReconciler) {
      this.networkReconciler.setCarVisualPreset?.(this.playerCarIndex, visualId);
      this.networkReconciler.queueClientCommand?.(
        CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
        packLoadoutCommandParam1(visualId, resolvedHitboxId),
        packLoadoutCommandParam2(colorSlotId, paintFinish, boostVisual, boostAudio)
      );
    }
  }

  setCarColor(carIndex, colorVal, broadcast = true) {
    this.arena?.setCarColor?.(carIndex, colorVal);
    if (broadcast) {
      const hex = typeof colorVal === 'number'
        ? '#' + colorVal.toString(16).padStart(6, '0')
        : String(colorVal);
      const slot = CAR_COLOR_SLOTS.find(s => s.hex.toLowerCase() === hex.toLowerCase()) || CAR_COLOR_SLOTS[0];
      this.selectedColorSlot = slot.id;

      const activeVisual = this.selectedPreset || 'octane';
      const activeHitbox = this.selectedHitbox || resolveVehicleHitboxId(activeVisual);
      const matCfg = getMaterialsConfig();
      const paintFinish = matCfg?.paintFinish || 'metallic';
      const boostVisual = matCfg?.boostVisual || 'gold-rush';
      const boostAudio = matCfg?.boostAudio || 'rush';

      if (this.authoritativeServer && carIndex === this.playerCarIndex) {
        this.authoritativeServer.setLoadout?.(
          'host',
          activeVisual,
          slot.id,
          activeHitbox,
          { paintFinish, boostVisual, boostAudio }
        );
      }
      if (this.networkReconciler && carIndex === this.playerCarIndex) {
        this.networkReconciler.queueClientCommand?.(
          CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
          packLoadoutCommandParam1(activeVisual, activeHitbox),
          packLoadoutCommandParam2(slot.id, paintFinish, boostVisual, boostAudio)
        );
      }
      if (this.networkChannel?.sendColorChange) {
        try {
          this.networkChannel.sendColorChange(slot.id, hex, carIndex);
        } catch (err) {
          console.error('[GameRuntime] Failed to broadcast color change over network channel:', err);
        }
      }
    }
  }

  syncPlayerMaterialsLoadout(materialsConfig = null) {
    const matCfg = materialsConfig || getMaterialsConfig();
    const paintFinish = matCfg?.paintFinish || 'metallic';
    const boostVisual = matCfg?.boostVisual || 'gold-rush';
    const boostAudio = matCfg?.boostAudio || 'rush';

    const expMode = this.modeManager?.activeMode?.id === 'exp-multi-bots' ? this.modeManager.activeMode : null;
    const targetCarIdx = (expMode && expMode.humanPlayerCarIndex >= 0) ? expMode.humanPlayerCarIndex : this.playerCarIndex;

    this.arena?.setCarLoadout?.(targetCarIdx, {
      paintFinish,
      boostVisual,
      boostAudio
    });
    (this.options?.gameAudio || gameAudio)?.setCarBoostAudioVariation?.(targetCarIdx, boostAudio);

    if (expMode) {
      const entry = expMode.spawnedCars?.[targetCarIdx];
      if (entry) {
        entry.paintFinish = paintFinish;
        entry.boostVisual = boostVisual;
        entry.boostAudio = boostAudio;
        expMode._publishSpawnedCarsTelemetry?.();
      }
    }

    const nextKey = `${paintFinish}:${boostVisual}:${boostAudio}`;
    if (this._lastSyncedPersonalMaterialsKey === nextKey) return;
    this._lastSyncedPersonalMaterialsKey = nextKey;

    const activeVisual = this.selectedPreset || 'octane';
    const activeHitbox = this.selectedHitbox || resolveVehicleHitboxId(activeVisual);
    const colorSlotId = this.selectedColorSlot ?? 0;

    if (this.authoritativeServer) {
      this.authoritativeServer.setLoadout?.(
        'host',
        activeVisual,
        colorSlotId,
        activeHitbox,
        { paintFinish, boostVisual, boostAudio }
      );
    }
    if (this.networkReconciler) {
      this.networkReconciler.queueClientCommand?.(
        CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
        packLoadoutCommandParam1(activeVisual, activeHitbox),
        packLoadoutCommandParam2(colorSlotId, paintFinish, boostVisual, boostAudio)
      );
    }
  }

  cleanupOnlineSession() { return this.networkManager.cleanupOnlineSession(); }
  async stopOnlineServer() { return this.networkManager.stopOnlineServer(); }
  async returnOnlineMatchToLobby(options = {}) { return this.networkManager.returnOnlineMatchToLobby(options); }
  async hostOnlineServer(options = {}) { return this.networkManager.hostOnlineServer(options); }
  async joinOnlineServer(options = {}) { return this.networkManager.joinOnlineServer(options); }
  async onRemotePlayerConnected(channel, remotePlayerName = "Player 2", assignedCarIndex = null) {
    return this.networkManager.onRemotePlayerConnected(channel, remotePlayerName, assignedCarIndex);
  }
  async removeRemotePlayer(carIndex) { return this.networkManager.removeRemotePlayer(carIndex); }
  forceStartOnlineMatch(durationSeconds = 300) { return this.networkManager.forceStartOnlineMatch(durationSeconds); }
  setOnlineGameMode(gameMode = '3v3', durationSeconds = null) { return this.networkManager.setOnlineGameMode(gameMode, durationSeconds); }
  setOnlineMatchDuration(durationSeconds = 300) { return this.networkManager.setOnlineMatchDuration(durationSeconds); }
  setOnlineBotFillMode(botFillMode = 'no_bots') { return this.networkManager.setOnlineBotFillMode(botFillMode); }
  addOnlineBot(team = null) { return this.networkManager.addOnlineBot(team); }
  setClientReady(ready = true) { return this.networkManager.setClientReady(ready); }
  voteSkipReplay() {
    gameAudio?.stadiumSpatialEngine?.notifyGoalReplaySkipped?.();
    return this.networkManager.voteSkipReplay();
  }
  voteRematch(ready = true) { return this.networkManager.voteRematch(ready); }
  switchOnlineRoleOrTeam(role = 'player', team = 0) { return this.networkManager.switchOnlineRoleOrTeam(role, team); }
  getPhysicsRate() { return this.networkManager.getPhysicsRate(); }
  adjustPhysicsRate(delta, options) { return this.networkManager.adjustPhysicsRate(delta, options); }
  setPhysicsRate(rate, options) { return this.networkManager.setPhysicsRate(rate, options); }
  setPhysicsTickScale(scale, options) { return this.networkManager.setPhysicsTickScale(scale, options); }
  resetPhysicsRate() { return this.networkManager.resetPhysicsRate(); }
  dropPacketBurst(count = null) { return this.networkManager.dropPacketBurst(count); }
  dropSinglePacket() { return this.networkManager.dropSinglePacket(); }
  dumpNextNetworkPacket() { return this.networkManager.dumpNextNetworkPacket(); }
  dumpLatestNetworkPacket(packet = null) { return this.networkManager.dumpLatestNetworkPacket(packet); }
  adjustSimulatedLatency(direction) { return this.networkManager.adjustSimulatedLatency(direction); }
  adjustNetworkLatency(deltaLatencyMs) { return this.networkManager.adjustNetworkLatency(deltaLatencyMs); }
  adjustNetworkRtt(deltaMs) { return this.networkManager.adjustNetworkRtt(deltaMs); }
  async spawnHeadlessCarEntity() { return this.networkManager.spawnHeadlessCarEntity(); }
  async spawnDiagnosticTestFleet(options = {}) { return this.networkManager.spawnDiagnosticTestFleet(options); }
  despawnDiagnosticTestFleet() { return this.networkManager.despawnDiagnosticTestFleet(); }
  async toggleDiagnosticTestFleet(forceEnabled = null, anchorMode = null) {
    return this.networkManager.toggleDiagnosticTestFleet(forceEnabled, anchorMode);
  }
  setDiagnosticObservationTarget(targetCarIndex = 0) {
    return this.networkManager.setDiagnosticObservationTarget(targetCarIndex);
  }
  setTestCarAudioEnabled(enabled = false) {
    return this.networkManager.setTestCarAudioEnabled(enabled);
  }
  toggleTestCarAudio(forceEnabled = null) {
    return this.networkManager.toggleTestCarAudio(forceEnabled);
  }
  sampleDiagnosticFleetTelemetry() {
    return this.networkManager.sampleDiagnosticFleetTelemetry();
  }
  setLobbyGhostMode(enabled = true, interactWithBall = false) {
    return this.networkManager.setLobbyGhostMode(enabled, interactWithBall);
  }
  async enableDeterminismHarness(showHUD = true) { return this.networkManager.enableDeterminismHarness(showHUD); }

  onSessionReady(reconciler, channel) {
    networkDiagnosticsStore.setSession(reconciler, channel, this);
  }

  onShowNetworkHUD() {
    toggleFloatingPreset(NETWORK_MONITOR_PRESET);
  }

  onDeterminismHarnessReady(harness, showHUD = false) {
    determinismStore.setHarness(harness);
    if (showHUD) toggleFloatingPreset(DUAL_ARENA_DETERMINISM_HARNESS_PRESET);
  }

  stepBot() { return this.botCoordinator.stepBot(); }
  scheduleBotDecision() { return this.botCoordinator.scheduleBotDecision(); }
  resetKickoff(seed = -1) { this.modeManager.onResetKickoff(seed); }
  resetAudio() { return this.audioSubsystem.resetAudio(); }
  resetBotState() { return this.botCoordinator.resetBotState(); }
  updateViewport(graphics = null) { return this.domEventManager.updateViewport(graphics); }
  applyBloomOccluders() { return this.bloomOcclusion.applyBloomOccluders(); }
  restoreBloomMaterials() { return this.bloomOcclusion.restoreBloomMaterials(); }
  async startBotMatch(botId = this.bot?.id || "nexto", durationSeconds = 300) {
    return this.botCoordinator.startBotMatch(botId, durationSeconds);
  }
  leaveBotMatch() { return this.botCoordinator.leaveBotMatch(); }
  startKickoffTraining() {
    if (this.match?.state?.mode === 'match') {
      this.leaveBotMatch();
    }
    if (this.match?.state) {
      this.match.state.mode = 'kickoff-training';
      this.match.state.phase = 'playing';
      this.match.state.paused = false;
      this.match.state.countdown = 0;
    }
    this.modeManager?.setMode?.('kickoff-training');
    this.syncPausedAndInputState?.();
  }
  startReplayViewer() {
    if (this.match?.state?.mode === 'match') {
      this.leaveBotMatch();
    }
    if (this.match?.state) {
      this.match.state.mode = 'replay-viewer';
      this.match.state.phase = 'playing';
      this.match.state.paused = false;
      this.match.state.countdown = 0;
    }
    this.modeManager?.setMode?.('replay-viewer');
    this.syncPausedAndInputState?.();
  }
  startDevTestLab() {
    if (this.match?.state?.mode === 'match') {
      this.leaveBotMatch();
    }
    const alreadyDevLab = this.modeManager?.activeMode?.id === 'dev-test-lab';
    if (this.match?.state) {
      this.match.state.mode = 'dev-test-lab';
      this.match.state.phase = 'playing';
      this.match.state.paused = false;
      this.match.state.countdown = 0;
    }
    if (alreadyDevLab) {
      const activeMode = this.modeManager.activeMode;
      activeMode?.onEnter?.();
    } else {
      this.modeManager?.setMode?.('dev-test-lab');
    }
    this.syncPausedAndInputState?.();
  }
  startExpMultiBots() {
    if (this.match?.state?.mode === 'match') {
      this.leaveBotMatch();
    }
    const alreadyExpMode = this.modeManager?.activeMode?.id === 'exp-multi-bots';
    if (this.match?.state) {
      this.match.state.mode = 'exp-multi-bots';
      this.match.state.phase = 'kickoff';
      this.match.state.paused = false;
      this.match.state.countdown = 3;
    }
    if (alreadyExpMode) {
      this.modeManager?.activeMode?.applyRosterAndStartMatch?.();
    } else {
      this.modeManager?.setMode?.('exp-multi-bots');
    }
    this.syncPausedAndInputState?.();
  }
  startStaticTrainingPack() {
    if (this.match?.state?.mode === 'match') {
      this.leaveBotMatch();
    }
    const alreadyStaticPack = this.modeManager?.activeMode?.id === 'static-training-pack';
    if (this.match?.state) {
      this.match.state.mode = 'static-training-pack';
      this.match.state.phase = 'playing';
      this.match.state.paused = false;
      this.match.state.countdown = 0;
    }
    if (alreadyStaticPack) {
      this.modeManager?.activeMode?.onEnter?.();
    } else {
      this.modeManager?.setMode?.('static-training-pack');
    }
    this.syncPausedAndInputState?.();
  }
  handleOverlayChange(name, isOpen) { return this.domEventManager.handleOverlayChange(name, isOpen); }
  syncPausedAndInputState(graphicsOverride = null) { return this.domEventManager.syncPausedAndInputState(graphicsOverride); }
  updateInteractionState() { return this.domEventManager.updateInteractionState(); }
  updateCursorHint() { return this.domEventManager.updateCursorHint(); }
  setupHudButtons() { return this.domEventManager.setupHudButtons(); }
  setupWindowEvents() { return this.domEventManager.setupWindowEvents(); }

  destroy() { destroyRuntimeInstance(this); }
  dispose() { this.destroy(); }
}
