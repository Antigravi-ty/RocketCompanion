import { getTeamAssignment } from '../../physics/RocketSimPhysicsEngine.js';
import { garageSettingsStore } from '../../ui-core/config/vehiclePresets.js';
import { botSettingsStore } from '../../ui-core/config/trainingDefaults.js';
import { preloadKickoffPPOWeights } from '../../ai/KickoffPPOAgent.js';
import { preloadGroundReachabilityLut } from '../../entities/reachability/groundReachabilityLut.js';
import { ensureExperimentalEngine } from '../../ai/experimental/ExperimentalBotAgent.js';
import { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.js';
import { PredictionReconciler } from '../../network/client/PredictionReconciler.js';
import { networkDiagnosticsStore } from '../../ui-core/stores/networkDiagnosticsStore';
import { hudStore } from '../../ui-core/stores/hudStore';
import { useAppStore } from '../../ui-core/stores/appStore';
import { resetRuntimeReconcilerSignalState } from './RuntimeReconcilerSignalHandler.js';

export const BOT_CAR_INDEX = 1;

/**
 * RuntimeBotCoordinator
 * Coordinates single-player bot AI simulation, decision scheduling, and local match lifecycle.
 */
export class RuntimeBotCoordinator {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async setupBot(onProgress = null) {
    const r = this.runtime;
    const tasks = [
      preloadKickoffPPOWeights().catch((err) => {
        console.warn('[GameRuntime] Kickoff PPO weights preload deferred or failed:', err);
      }),
      preloadGroundReachabilityLut().catch((err) => {
        console.warn('[GameRuntime] Ground reachability LUT preload deferred or failed:', err);
      }),
      ensureExperimentalEngine('nexto').then(() => {
        if (onProgress) onProgress(1, 2, 'nexto');
      }).catch((err) => {
        console.warn('[GameRuntime] Nexto SafeTensors preload deferred or failed:', err);
      }),
      ensureExperimentalEngine('necto').then(() => {
        if (onProgress) onProgress(2, 2, 'necto');
      }).catch((err) => {
        console.warn('[GameRuntime] Necto SafeTensors preload deferred or failed:', err);
      }),
    ];
    if (r.bot) {
      tasks.push(
        r.bot.preloadAll(onProgress).catch((err) => {
          console.warn('[GameRuntime] Bot preload deferred or failed:', err);
        })
      );
    }
    await Promise.all(tasks);
  }

  stepBot() {
    const r = this.runtime;
    if (!r.isBotMatch || r.authoritativeServer || r.networkReconciler) {
      return true;
    }

    if (r.match.state.paused || r.match.state.phase === 'ended' || r.isBotPaused) {
      return false;
    }

    if (r.match.state.phase === 'playing') {
      const kickoffControls = r.bot?.getKickoffControls?.(r.physics.state, r.botKickoffStep);
      if (kickoffControls) {
        r.botControls = kickoffControls;
        r.bot?.overrideControls?.(kickoffControls);
      } else if (r.botTickSkip === 0) {
        this.scheduleBotDecision();
        return false;
      }

      r.physics.setControls(BOT_CAR_INDEX, r.botControls);
      r.physics.step(1);
      r.botKickoffStep++;
      if (!kickoffControls) r.botTickSkip--;

      const ballView = r.physics.getBallStateView();
      const kickoffTouched =
        Math.abs(ballView.posX) + Math.abs(ballView.posY) > 1 ||
        Math.hypot(ballView.velX, ballView.velY) > 1;

      const transition = r.match.tick({
        goal: r.physics.pollGoal(),
        ballOnGround: r.physics.ballOnGround,
        kickoffTouched
      });

      if (transition === 'kickoff') {
        r.resetKickoff();
      }

      if (
        r.match.state.phase === 'playing' &&
        r.botTickSkip === 0 &&
        !r.bot?.getKickoffControls?.(r.physics.state, r.botKickoffStep)
      ) {
        this.scheduleBotDecision();
      }
    } else {
      const transition = r.match.tick();
      if (transition === 'kickoff') {
        r.resetKickoff();
      }
    }
    return true;
  }

  scheduleBotDecision() {
    const r = this.runtime;
    if (r.isBotDeciding || !r.isBotMatch || !r.bot) return;
    r.isBotDeciding = true;
    const epoch = r.botDecisionEpoch;
    const pads = r.physics.getPads();
    const teamAssignment = getTeamAssignment(false);

    r.bot
      .decide(r.physics.state, pads, BOT_CAR_INDEX, teamAssignment.botTeam)
      .then((controls) => {
        if (epoch === r.botDecisionEpoch) {
          r.botControls = controls;
          r.botTickSkip = r.bot.option.tickSkip;
          r.isBotDeciding = false;
          if (r.authoritativeServer && r.isBotMatch) {
            r.authoritativeServer.setCarControls(BOT_CAR_INDEX, controls);
          }
        }
      })
      .catch((err) => {
        if (epoch === r.botDecisionEpoch) {
          r.isBotDeciding = false;
          r.isBotPaused = true;
          r.match.state.paused = true;
          console.warn(
            '[GameRuntime] Bot opponent stopped responding:',
            err instanceof Error ? err.message : err
          );
        }
      });
  }

  resetBotState() {
    const r = this.runtime;
    if (r.bot) r.bot.reset();
    r.botDecisionEpoch++;
    r.botTickSkip = 0;
    r.isBotDeciding = false;
    r.botControls = { ...r.neutralControls };
    r.botKickoffStep = 0;
  }

  async startBotMatch(botId = this.runtime.bot?.id || 'nexto', durationSeconds = 300) {
    const r = this.runtime;
    r.isBotMatch = true;
    if (botId && r.bot) {
      this.resetBotState();
      r.bot.select(botId);
      botSettingsStore.save({ botId });
    }
    await Promise.all([r.bot?.load(), r.arena?.ensureOpponent?.()]);
    if (r.arena?.cars?.[1]) {
      r.arena.cars[1].visible = true;
    }
    r.physics?.configureCars('default', true);
    r.physics?.setUnlimitedBoost(false);
    r.isBotPaused = false;

    // Dispose existing server if running
    if (r.authoritativeServer) {
      r.authoritativeServer.destroy?.();
      r.authoritativeServer = null;
    }

    const initialSnapshot = r.physics.saveCompactState();

    const presetId = r.selectedPreset || garageSettingsStore.get()?.vehiclePreset || 'fennec';

    // Spawn 120Hz Authoritative Local Server Worker directly in match kickoff state
    r.authoritativeServer = new AuthoritativeServerHost(null, {
      snapshotInterval: 1,
      initialState: Array.from(initialSnapshot),
      hostPlayerName: 'Player',
      hostVisualId: presetId,
      hostColorSlot: r.selectedColorSlot ?? 0,
      roomId: 'local_bot_match',
      isBotMatch: true,
      startAsMatch: true,
      skipReplayByDefault: false,
      botPlayerName: r.bot?.name || 'AI Bot',
      numCars: 2,
      durationSeconds
    });
    await r.authoritativeServer.init();

    r.authoritativeServer.sim.setUnlimitedBoost(false);

    // Connect player client to server worker via dedicated 0ms loopback hostChannel
    const snapMetrics = networkDiagnosticsStore.getSnapshot()?.metrics;
    const prevExtraUplinkMs = typeof r.networkChannel?.extraUplinkMs === 'number' && Number.isFinite(r.networkChannel.extraUplinkMs)
      ? r.networkChannel.extraUplinkMs
      : (snapMetrics?.extraUplinkMs ?? snapMetrics?.extraLatencyMs ?? 0);
    const prevExtraDownlinkMs = typeof r.networkChannel?.extraDownlinkMs === 'number' && Number.isFinite(r.networkChannel.extraDownlinkMs)
      ? r.networkChannel.extraDownlinkMs
      : (snapMetrics?.extraDownlinkMs ?? snapMetrics?.extraLatencyMs ?? 0);
    r.networkChannel = r.authoritativeServer.channel;
    if (r.networkChannel && (prevExtraUplinkMs > 0 || prevExtraDownlinkMs > 0)) {
      if (typeof r.networkChannel.setAsymmetricLatency === 'function') {
        r.networkChannel.setAsymmetricLatency(prevExtraUplinkMs, prevExtraDownlinkMs);
      } else {
        r.networkChannel.extraUplinkMs = prevExtraUplinkMs;
        r.networkChannel.extraDownlinkMs = prevExtraDownlinkMs;
      }
    }
    r.playerCarIndex = 0;
    if (r.arena) {
      r.arena.playerCarIndex = 0;
    }

    const serverSnap = r.authoritativeServer.sim.saveCompactState();
    const serverTick = Math.floor(r.authoritativeServer.sim.getHeaderView().tickCount);
    r.physics?.restoreState?.(serverSnap);
    r.interpolator?.sync?.(performance.now());

    const uiState = useAppStore?.getState?.();
    const initialBufferTarget = typeof uiState?.inputBufferTarget === 'number' ? uiState.inputBufferTarget : 3;
    const initialBufferThreshold = Array.isArray(uiState?.inputBufferThreshold) ? uiState.inputBufferThreshold : [-2, 2];

    r.networkReconciler = new PredictionReconciler(r.physics, r.networkChannel, {
      localCarIndex: 0,
      redundantHistoryCount: 10,
      enableRedundantInputs: true,
      useBitPacking: false,
      interpolator: r.interpolator,
      clockPacingMode: uiState?.clockPacingMode || 'legacy',
      inputBufferTarget: initialBufferTarget,
      catchupThresholdOffset: initialBufferThreshold[0],
      skipThresholdOffset: initialBufferThreshold[1]
    });
    r.networkReconciler.setCarVisualPreset(0, presetId);
    r.networkReconciler.setCarVisualPreset(1, 'fennec');
    r._bindReconcilerSignals(r.networkReconciler);
    r.networkReconciler.onHardResync = () => {
      if (r.interpolator) {
        r.interpolator.sync(performance.now());
      }
    };
    r.networkReconciler.syncTimeline(serverSnap, serverTick);
    networkDiagnosticsStore.setSession(r.networkReconciler, r.networkChannel, r);

    r.matchDurationSeconds = durationSeconds;
    r.audioLastOvertime = false;
    r.audioLastGoalScored = false;
    r.audioLastCountdown = -1;
    r.audioLast10sCountdown = -1;
    r.audioLastRemainingSec = durationSeconds;
    r.lastKickoffCountdownSec = -1;

    if (r.match) {
      r.match.state.mode = 'match';
      r.match.state.paused = false;
      r.match.state.phase = 'kickoff';
      r.match.state.overtime = false;
      r.match.state.winner = null;
    }

    hudStore.getState().setMatchState({
      matchPhase: 'kickoff',
      remainingSeconds: durationSeconds,
      overtimeSeconds: 0,
      isOvertime: false,
      blueScore: 0,
      orangeScore: 0,
      winner: null,
      kickoffCountdown: 3
    });

    if (useAppStore && typeof useAppStore.getState === 'function') {
      useAppStore.getState().setMatchMode('match');
    }
  }

  leaveBotMatch() {
    const r = this.runtime;
    r.isBotMatch = false;
    this.resetBotState();
    r.resetAudio();
    resetRuntimeReconcilerSignalState(r);
    r.setLobbyGhostMode?.(false);
    if (r.authoritativeServer) {
      r.authoritativeServer.destroy?.();
      r.authoritativeServer = null;
    }
    if (r.networkChannel) {
      r.networkChannel.destroy?.();
      r.networkChannel = null;
    }
    r.networkReconciler = null;
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
    r.match?.leave?.();
    if (r.match) {
      r.match.state.mode = 'freeplay';
      r.match.state.paused = false;
      r.match.state.phase = 'freeplay';
      r.match.state.overtime = false;
      r.match.state.winner = null;
      r.match.state.countdown = 0;
    }
    r.isBotPaused = false;
    r.physics?.configureCars('default', false, r.teamAssignment.playerTeam);
    r.physics?.setUnlimitedBoost(r.trainingOptions?.boostOption === 'unlimited');
    r.resetKickoff();
    r.interpolator?.sync?.(performance.now());
    hudStore.getState().setMatchState({
      kickoffCountdown: 0,
      matchPhase: 'freeplay',
      blueScore: 0,
      orangeScore: 0,
      remainingSeconds: 300,
      overtimeSeconds: 0,
      isOvertime: false,
      winner: null
    });
    if (useAppStore && typeof useAppStore.getState === 'function') {
      useAppStore.getState().setMatchMode('freeplay');
      useAppStore.getState().setOnlineSession({
        isHosting: false,
        roomId: '',
        signalingConnected: false,
        connectedPeers: [],
        roomType: 'warmup',
        isReady: false
      });
    }
  }
}
