import { getTeamAssignment } from '../../physics/RocketSimMeshLoader.ts';
import {
  CAR_COLOR_SLOTS,
  resolveVehicleHitboxId,
} from '../../ui-core/config/vehicleConstants';
import {
  garageSettingsStore,
  getPreferredColorSlot,
  loadStoredColorPrefs,
} from '../../ui-core/config/vehiclePresets';
import { botSettingsStore } from '../../ui-core/config/trainingDefaults';
import { preloadKickoffPPOWeights } from '../../ai/KickoffPPOAgent.ts';
import { preloadKickoffV1BestWeights } from '../../ai/KickoffV2SafeTensorsAgent.ts';
import { preloadGroundReachabilityLut } from '../../entities/reachability/groundReachabilityLut.ts';
import {
  BOTPACK_9700488_POLICIES,
  ensureExperimentalEngine,
} from '../../ai/experimental/ExperimentalBotAgent.ts';
import { ensureWasmSimdMatVec } from '../../ai/experimental/wasmSimdMatVec.ts';
import { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.ts';
import { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import { NEUTRAL_CAR_CONTROLS } from '../../network/client/PredictionHistoryBuffer.ts';
import { networkDiagnosticsStore, hudStore, useAppStore } from '../runtimeUiPort.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import type { CarControlsInput } from '../../network/protocol/GlobalPayloadCodec.ts';
import type { RuntimeNetworkManager } from './RuntimeNetworkManager.ts';
import type { NetworkSessionChannelLike } from './onlineLobbyTransitionPipeline.ts';

export const BOT_CAR_INDEX = 1;

export interface BotAgentLike {
  id?: string;
  name?: string;
  option: { name?: string; tickSkip: number; [key: string]: unknown };
  preloadAll(
    onProgress?: ((completed?: number, total?: number, name?: string) => void) | null,
  ): Promise<unknown>;
  getKickoffControls?(state: unknown, step: number): CarControlsInput | null | undefined;
  overrideControls?(controls: CarControlsInput): void;
  decide(
    state: unknown,
    pads?: unknown,
    carIndex?: number,
    team?: number,
  ): Promise<CarControlsInput>;
  reset(): void;
  select(botId: string): void;
  load(): Promise<unknown>;
  setDifficulty?(diff: string): void;
  setCarIndex?(idx: number): void;
  setTeam?(team: number): void;
  destroy?(): void;
}

export interface RuntimeBotCoordinatorHostPort {
  bot: BotAgentLike | null;
  readonly physics: RocketSimPhysicsEngine | null;
  readonly match: RuntimeMatchState | null;
  readonly arena: ArenaWorld | null;
  readonly interpolator: PhysicsStateInterpolator | null;
  readonly trainingOptions: { boostOption?: string; [key: string]: unknown } | null;
  readonly audioSubsystem: {
    resetMatchClockTracking(durationSeconds?: number): void;
    resetAudio(): void;
  } | null;
  readonly networkManager: RuntimeNetworkManager | null;
  readonly loadoutCoordinator?: {
    restoreLocalPlayerFreeplayLoadout(carIndex?: number): void;
  } | null;
  playerCarIndex: number;
  matchDurationSeconds: number;
  resetKickoff(seed?: number): void;
}

/**
 * RuntimeBotCoordinator
 * Stateful SubController owning single-player bot AI state, decision scheduling,
 * authoritative bot control stepping, and local bot match lifecycle.
 */
export class RuntimeBotCoordinator {
  public readonly runtime: RuntimeBotCoordinatorHostPort;
  public botControls: CarControlsInput;
  public botTickSkip = 0;
  public isBotDeciding = false;
  public botDecisionEpoch = 0;
  public botKickoffStep = 0;
  public isBotPaused = false;
  public isBotMatch = false;

  constructor(runtime: RuntimeBotCoordinatorHostPort) {
    this.runtime = runtime;
    this.botControls = { ...NEUTRAL_CAR_CONTROLS };
  }

  public async setupBot(
    onProgress: ((completed?: number, total?: number, name?: string) => void) | null = null,
  ): Promise<void> {
    const r = this.runtime;
    const botpackIds = BOTPACK_9700488_POLICIES.map((p) => p.id);
    const totalSteps = 6 + botpackIds.length;
    let completedSteps = 0;
    const report = (label: string) => {
      completedSteps++;
      if (onProgress) {
        onProgress(completedSteps, totalSteps, label);
      }
    };

    await ensureWasmSimdMatVec().catch(() => false);

    const coreTasks: Array<Promise<unknown>> = [
      AuthoritativeServerHost.prewarmWorkers()
        .then(() => report('server_and_bot_workers'))
        .catch((err: unknown) => {
          report('server_and_bot_workers');
          console.warn('[GameRuntime] Worker prewarm deferred or failed:', err);
        }),
      preloadGroundReachabilityLut()
        .then(() => report('ground_reachability_lut'))
        .catch((err: unknown) => {
          report('ground_reachability_lut');
          console.warn('[GameRuntime] Ground reachability LUT preload deferred or failed:', err);
        }),
      preloadKickoffPPOWeights()
        .then(() => report('ko_v1'))
        .catch((err: unknown) => {
          report('ko_v1');
          console.warn('[GameRuntime] Kickoff v1 PPO weights preload deferred or failed:', err);
        }),
      preloadKickoffV1BestWeights()
        .then(() => report('ko_v2'))
        .catch((err: unknown) => {
          report('ko_v2');
          console.warn('[GameRuntime] Kickoff v2 SafeTensors preload deferred or failed:', err);
        }),
      ensureExperimentalEngine('nexto')
        .then(() => report('nexto'))
        .catch((err: unknown) => {
          report('nexto');
          console.warn('[GameRuntime] Nexto SafeTensors preload deferred or failed:', err);
        }),
      ensureExperimentalEngine('necto')
        .then(() => report('necto'))
        .catch((err: unknown) => {
          report('necto');
          console.warn('[GameRuntime] Necto SafeTensors preload deferred or failed:', err);
        }),
    ];

    if (r.bot) {
      coreTasks.push(
        r.bot.preloadAll(null).catch((err: unknown) => {
          console.warn('[GameRuntime] Bot preload deferred or failed:', err);
        }),
      );
    }

    await Promise.all(coreTasks);

    for (const policyId of botpackIds) {
      try {
        await ensureExperimentalEngine(policyId);
      } catch (err: unknown) {
        console.warn(`[GameRuntime] Botpack policy "${policyId}" preload warning:`, err);
      }
      report(policyId);
      await new Promise((resolve) => setTimeout(resolve, 6));
    }
  }

  /**
   * Advances authoritative bot controls for single-player bot matches hosted on an AuthoritativeServerHost.
   */
  public stepAuthoritativeBotControls(isKickoff: boolean): void {
    const r = this.runtime;
    const server = r.networkManager?.sessionCoordinator.authoritativeServer;
    if (
      !server ||
      !r.physics ||
      !this.isBotMatch ||
      r.match?.state?.mode !== 'match' ||
      this.isBotPaused
    ) {
      return;
    }

    if (isKickoff) {
      this.botKickoffStep = 0;
      this.botControls = { ...NEUTRAL_CAR_CONTROLS };
      server.setCarControls(BOT_CAR_INDEX, this.botControls);
      r.physics.setControls(BOT_CAR_INDEX, this.botControls);
      return;
    }

    const kickoffControls = r.bot?.getKickoffControls?.(r.physics.state, this.botKickoffStep) as
      | CarControlsInput
      | null
      | undefined;
    if (kickoffControls) {
      this.botControls = kickoffControls;
      r.bot?.overrideControls?.(kickoffControls);
    } else if (this.botTickSkip <= 0) {
      this.scheduleBotDecision();
    }
    this.botKickoffStep++;
    if (!kickoffControls && this.botTickSkip > 0) {
      this.botTickSkip--;
    }
    server.setCarControls(BOT_CAR_INDEX, this.botControls);
    r.physics.setControls(BOT_CAR_INDEX, this.botControls);
  }

  public scheduleBotDecision(): void {
    const r = this.runtime;
    if (this.isBotDeciding || !this.isBotMatch || !r.bot || !r.physics) return;
    this.isBotDeciding = true;
    const epoch = this.botDecisionEpoch;
    const pads = r.physics.getPads();
    const teamAssignment = getTeamAssignment(false) as {
      playerTeam: number;
      opponentTeam: number;
      botTeam?: number;
    };
    const botTeam = teamAssignment.botTeam ?? teamAssignment.opponentTeam;

    r.bot
      .decide(r.physics.state, pads, BOT_CAR_INDEX, botTeam)
      .then((controls: CarControlsInput) => {
        if (epoch === this.botDecisionEpoch && r.bot) {
          this.botControls = controls;
          this.botTickSkip = r.bot.option.tickSkip;
          this.isBotDeciding = false;
          const server = r.networkManager?.sessionCoordinator.authoritativeServer;
          if (server && this.isBotMatch) {
            server.setCarControls(BOT_CAR_INDEX, controls);
          }
        }
      })
      .catch((err: unknown) => {
        if (epoch === this.botDecisionEpoch) {
          this.isBotDeciding = false;
          this.isBotPaused = true;
          if (r.match) {
            r.match.state.paused = true;
          }
          console.warn(
            '[GameRuntime] Bot opponent stopped responding:',
            err instanceof Error ? err.message : err,
          );
        }
      });
  }

  public resetBotState(): void {
    const r = this.runtime;
    if (r.bot) r.bot.reset();
    this.botDecisionEpoch++;
    this.botTickSkip = 0;
    this.isBotDeciding = false;
    this.botControls = { ...NEUTRAL_CAR_CONTROLS };
    this.botKickoffStep = 0;
  }

  public async startBotMatch(
    botId: string = this.runtime.bot?.id || 'nexto',
    durationSeconds = 300,
  ): Promise<void> {
    const r = this.runtime;
    const net = r.networkManager;
    if (!r.physics || !net) return;
    const session = net.sessionCoordinator;
    this.isBotMatch = true;
    if (botId && r.bot) {
      this.resetBotState();
      r.bot.select(botId);
      botSettingsStore.save({ botId });
    }
    await Promise.all([r.bot?.load(), r.arena?.ensureOpponent?.()]);
    if (r.arena?.cars?.[1]) {
      r.arena.cars[1].visible = true;
    }
    r.physics.configureCars('default', true);
    r.physics.setUnlimitedBoost(false);
    this.isBotPaused = false;

    if (session.authoritativeServer) {
      session.authoritativeServer.destroy?.();
      session.authoritativeServer = null;
    }

    const initialSnapshot = r.physics.saveCompactState();

    const garagePrefs = garageSettingsStore.get() as { vehiclePreset?: string } | null;
    const presetId =
      useAppStore?.getState?.()?.activeCar || garagePrefs?.vehiclePreset || 'fennec';
    const storedPrefs = loadStoredColorPrefs();
    const preferredBlueSlot = getPreferredColorSlot(storedPrefs, 0);
    const preferredOrangeSlot = getPreferredColorSlot(storedPrefs, 1);
    const hostColorSlot = preferredBlueSlot;
    const hostColorHex = CAR_COLOR_SLOTS[hostColorSlot]?.hex || '#42a5f5';
    r.arena?.setCarColor?.(0, hostColorHex);

    const server = new AuthoritativeServerHost(null, {
      snapshotInterval: 1,
      initialState: Array.from(initialSnapshot),
      hostPlayerName: 'Player',
      hostVisualId: presetId,
      hostColorSlot,
      hostBlueColorSlot: preferredBlueSlot,
      hostOrangeColorSlot: preferredOrangeSlot,
      roomId: 'local_bot_match',
      isBotMatch: true,
      startAsMatch: true,
      skipReplayByDefault: false,
      botPlayerName: r.bot?.name || 'AI Bot',
      numCars: 2,
      durationSeconds,
    });
    session.authoritativeServer = server;
    await server.init();

    server.sim.setUnlimitedBoost(false);

    const snapMetrics = networkDiagnosticsStore.getSnapshot()?.metrics;
    const prevChannel = session.networkChannel;
    const prevExtraUplinkMs =
      typeof prevChannel?.extraUplinkMs === 'number' &&
      Number.isFinite(prevChannel.extraUplinkMs)
        ? prevChannel.extraUplinkMs
        : (snapMetrics?.extraUplinkMs ?? snapMetrics?.extraLatencyMs ?? 0);
    const prevExtraDownlinkMs =
      typeof prevChannel?.extraDownlinkMs === 'number' &&
      Number.isFinite(prevChannel.extraDownlinkMs)
        ? prevChannel.extraDownlinkMs
        : (snapMetrics?.extraDownlinkMs ?? snapMetrics?.extraLatencyMs ?? 0);
    const nextChannel = server.channel as NetworkSessionChannelLike;
    session.networkChannel = nextChannel;
    if (nextChannel && (prevExtraUplinkMs > 0 || prevExtraDownlinkMs > 0)) {
      if (typeof nextChannel.setAsymmetricLatency === 'function') {
        nextChannel.setAsymmetricLatency(prevExtraUplinkMs, prevExtraDownlinkMs);
      } else {
        nextChannel.extraUplinkMs = prevExtraUplinkMs;
        nextChannel.extraDownlinkMs = prevExtraDownlinkMs;
      }
    }
    r.playerCarIndex = 0;
    if (r.arena) {
      r.arena.playerCarIndex = 0;
    }

    const serverSnap = server.sim.saveCompactState();
    const serverTick = Math.floor(server.sim.getHeaderView().tickCount);
    r.physics.restoreState?.(serverSnap);
    r.interpolator?.sync?.(performance.now());

    const uiState = useAppStore?.getState?.();
    const initialBufferTarget =
      typeof uiState?.inputBufferTarget === 'number' ? uiState.inputBufferTarget : 3;
    const initialBufferThreshold = Array.isArray(uiState?.inputBufferThreshold)
      ? uiState.inputBufferThreshold
      : [-2, 2];

    const reconciler = new PredictionReconciler(r.physics, nextChannel, {
      localCarIndex: 0,
      redundantHistoryCount: 10,
      enableRedundantInputs: true,
      useBitPacking: false,
      interpolator: r.interpolator,
      clockPacingMode: uiState?.clockPacingMode || 'legacy',
      inputBufferTarget: initialBufferTarget,
      catchupThresholdOffset: initialBufferThreshold[0],
      skipThresholdOffset: initialBufferThreshold[1],
    });
    session.networkReconciler = reconciler;
    reconciler.setCarVisualPreset(0, presetId);
    reconciler.setCarVisualPreset(1, 'fennec');
    net.signalCoordinator.bindReconcilerSignals(reconciler);
    reconciler.onHardResync = () => {
      if (r.interpolator) {
        r.interpolator.sync(performance.now());
      }
    };
    reconciler.syncTimeline(serverSnap, serverTick);
    networkDiagnosticsStore.setSession(reconciler, nextChannel, r);

    r.matchDurationSeconds = durationSeconds;
    r.audioSubsystem?.resetMatchClockTracking(durationSeconds);

    r.match?.start();

    hudStore.getState().setMatchState({
      matchPhase: 'kickoff',
      remainingSeconds: durationSeconds,
      overtimeSeconds: 0,
      isOvertime: false,
      blueScore: 0,
      orangeScore: 0,
      winner: null,
      kickoffCountdown: 3,
    });

    if (useAppStore && typeof useAppStore.getState === 'function') {
      useAppStore.getState().setMatchMode('match');
    }
  }

  public leaveBotMatch(): void {
    const r = this.runtime;
    const net = r.networkManager;
    const session = net?.sessionCoordinator;
    this.isBotMatch = false;
    this.resetBotState();
    r.audioSubsystem?.resetAudio();
    net?.signalCoordinator?.resetSignalState?.();
    net?.diagnosticsProbe.configureLobbyGhostMode(false);
    if (session?.authoritativeServer) {
      session.authoritativeServer.destroy?.();
      session.authoritativeServer = null;
    }
    if (session?.networkChannel) {
      session.networkChannel.destroy?.();
      session.networkChannel = null;
    }
    if (session) {
      session.networkReconciler = null;
    }
    r.playerCarIndex = 0;
    if (r.arena) {
      r.arena.playerCarIndex = 0;
      if (r.arena.cars) {
        if (r.arena.cars[0]) r.arena.cars[0].visible = true;
        for (let i = 1; i < r.arena.cars.length; i++) {
          if (r.arena.cars[i]) r.arena.cars[i].visible = false;
        }
      }
    }
    if (r.match) {
      r.match.leave();
      r.match.state.phase = 'freeplay';
      r.match.state.overtime = false;
      r.match.state.winner = null;
      r.match.state.countdown = 0;
    }
    this.isBotPaused = false;
    const freeplayPrefs = loadStoredColorPrefs();
    const freeplayTeam = freeplayPrefs.primaryTeam === 'orange' ? 1 : 0;
    const garagePrefs = garageSettingsStore.get() as { vehiclePreset?: string } | null;
    const presetId =
      useAppStore?.getState?.()?.activeCar || garagePrefs?.vehiclePreset || 'fennec';
    const playerHitbox = resolveVehicleHitboxId(presetId);
    r.physics?.configureCars(playerHitbox, false, freeplayTeam);
    if (r.loadoutCoordinator) {
      r.loadoutCoordinator.restoreLocalPlayerFreeplayLoadout(0);
    } else {
      const freeplayColorSlot = getPreferredColorSlot(freeplayPrefs, freeplayTeam);
      const freeplayColorHex = CAR_COLOR_SLOTS[freeplayColorSlot]?.hex || '#ffc107';
      r.arena?.setCarTeam?.(0, freeplayTeam);
      r.arena?.setCarColor?.(0, freeplayColorHex);
    }
    r.physics?.setUnlimitedBoost(r.trainingOptions?.boostOption === 'unlimited');
    r.resetKickoff();
    r.interpolator?.sync?.(performance.now());
    hudStore.getState().setMatchState({
      kickoffCountdown: 0,
      matchPhase: 'freeplay',
      localTeam: freeplayTeam,
      blueScore: 0,
      orangeScore: 0,
      remainingSeconds: 300,
      overtimeSeconds: 0,
      isOvertime: false,
      winner: null,
    });
    if (useAppStore && typeof useAppStore.getState === 'function') {
      useAppStore.getState().setMatchMode('freeplay');
      useAppStore.getState().setOnlineSession({
        isHosting: false,
        roomId: '',
        signalingConnected: false,
        connectedPeers: [],
        roomType: 'warmup',
        isReady: false,
      });
    }
  }
}
