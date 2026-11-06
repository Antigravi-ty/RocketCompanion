import {
  useAppStore,
  networkDiagnosticsStore,
  floatingStore,
  type RuntimeCameraPort,
  type RuntimeMatchPort,
  type RuntimeTunerPort,
  type RuntimeReplayPort,
  type GameRuntimeUiBridgePort,
} from '../runtimeUiPort.ts';
import {
  resolveEffectiveClockPacingParams,
  type ClockPacingMode,
  type ClockPacingPriority,
  type ClockPacingParams,
} from '../../ui-core/config/clockPacingConfig';
import type { PacingControllerParams } from '../../ui-core/config/pacingControllerEvaluator';
import { createRuntimeTunerPort } from './runtimeTunerPort.ts';
import {
  createRuntimeReplayPort,
  type FreeplayModeCleanupPort,
  type RuntimeDomainPortOwner,
} from './runtimeReplayAndDiagnosticsPort.ts';

function leaveActiveBotMatchIfNeeded(owner: RuntimeDomainPortOwner): void {
  if (owner.botCoordinator.isBotMatch || owner.match?.state?.mode === 'match') {
    owner.botCoordinator.leaveBotMatch();
  }
}

function stopActiveOnlineOrLoopbackSessionIfNeeded(owner: RuntimeDomainPortOwner): void {
  const session = owner.multiplayerSession;
  if (session) {
    if (session.isHosting) {
      void session.stopHosting?.();
    } else if (session.clientController || session.signalingHandler) {
      void session.leaveSession?.();
    }
  }
  const netSession = owner.networkManager?.sessionCoordinator;
  if (netSession && (netSession.authoritativeServer || netSession.networkChannel || netSession.networkReconciler)) {
    netSession.cleanupOnlineSession?.();
    void netSession.stopOnlineServer?.({ rebindLoopback: false });
  }
}

function transitionToTrainingMode(
  owner: RuntimeDomainPortOwner,
  modeId: string,
  reEnterIfActive = false,
): void {
  stopActiveOnlineOrLoopbackSessionIfNeeded(owner);
  leaveActiveBotMatchIfNeeded(owner);
  const alreadyActive = owner.modeManager?.activeMode?.id === modeId;
  if (owner.match) {
    owner.match.leave();
    owner.match.state.mode = modeId;
    owner.match.state.countdown = 0;
  }
  if (reEnterIfActive && alreadyActive) {
    owner.modeManager?.activeMode?.onEnter?.();
  } else {
    owner.modeManager?.setMode?.(modeId);
  }
  owner.domEventManager.syncPausedAndInputState();
}

function transitionToExpMultiBotsMode(owner: RuntimeDomainPortOwner): void {
  stopActiveOnlineOrLoopbackSessionIfNeeded(owner);
  leaveActiveBotMatchIfNeeded(owner);
  const activeMode = owner.modeManager?.activeMode;
  const alreadyExpMode = activeMode?.id === 'exp-multi-bots';
  if (owner.match) {
    owner.match.start();
    owner.match.state.mode = 'exp-multi-bots';
  }
  if (alreadyExpMode) {
    void activeMode?.applyRosterAndStartMatch?.();
  } else {
    owner.modeManager?.setMode?.('exp-multi-bots');
  }
  owner.domEventManager.syncPausedAndInputState();
}

/**
 * Factory creating the 4 narrow domain ports (cameraPort, matchPort, tunerPort, replayPort)
 * for a GameRuntime instance so UI Bridge handlers never read/mutate internal GameRuntime fields.
 */
export function createGameRuntimeDomainPorts(
  owner: RuntimeDomainPortOwner,
): GameRuntimeUiBridgePort {
  const cameraPort: RuntimeCameraPort = {
    applyPovSettings: (cameraConfig) => {
      owner.camera?.applyPovSettings?.(cameraConfig);
    },
    setFreeCam: (enabled) => {
      owner.camera?.setFreeCam?.(enabled);
    },
    setFreeCamFov: (fov) => {
      owner.camera?.setFreeCamFov?.(fov);
    },
    resetFreeCamOverview: () => {
      owner.camera?.resetFreeCamOverview?.();
    },
    setDiagnosticObservationTarget: (targetCarIndex) =>
      owner.networkManager.diagnosticsProbe.setDiagnosticObservationTarget(targetCarIndex),
  };

  const matchPort: RuntimeMatchPort = {
    getMatchMode: () => owner.match?.state?.mode || 'freeplay',
    isOnlineOrServerActive: () =>
      Boolean(
        owner.networkManager.sessionCoordinator.authoritativeServer ||
          owner.networkManager.sessionCoordinator.networkReconciler,
      ),
    isBotMatch: () => owner.botCoordinator.isBotMatch,
    getPlayerCarIndex: () => owner.playerCarIndex ?? 0,
    getMatchDurationSeconds: () => owner.matchDurationSeconds || 300,
    syncPausedAndInputState: (graphicsOverride = null) => {
      owner.domEventManager.syncPausedAndInputState(graphicsOverride);
    },
    handleOverlayChange: (overlayName, isOpen) => {
      owner.domEventManager.handleOverlayChange(overlayName, isOpen);
    },
    openMainMenu: () => {
      if (owner.gameUI) {
        owner.gameUI.openMenu('main-menu');
      } else {
        useAppStore.getState().openMenu('main-menu');
      }
    },
    startExpMultiBots: () => {
      transitionToExpMultiBotsMode(owner);
    },
    startKickoffTraining: () => {
      transitionToTrainingMode(owner, 'kickoff-training', false);
    },
    startReplayViewer: () => {
      transitionToTrainingMode(owner, 'replay-viewer', false);
    },
    startStaticTrainingPack: () => {
      transitionToTrainingMode(owner, 'static-training-pack', true);
    },
    startDevTestLab: () => {
      transitionToTrainingMode(owner, 'dev-test-lab', true);
    },
    restartMatch: async () => {
      const currentMode = owner.match?.state?.mode || useAppStore.getState().matchMode;
      if (currentMode === 'exp-multi-bots') {
        const activeMode = owner.modeManager?.getActiveMode?.();
        if (activeMode && typeof activeMode.applyRosterAndStartMatch === 'function') {
          await activeMode.applyRosterAndStartMatch();
        } else {
          transitionToExpMultiBotsMode(owner);
        }
        useAppStore.setState({ matchMode: 'exp-multi-bots' });
        return;
      }
      const duration = owner.matchDurationSeconds || 300;
      await owner.botCoordinator.startBotMatch(undefined, duration);
      useAppStore.setState({ matchMode: 'match' });
    },
    returnToFreeplay: (unlimitedBoost) => {
      floatingStore.closeWindow('subsystem-isolation-lab');
      floatingStore.closeWindow('experimental-multi-bots');
      floatingStore.closeWindow('experimental-bot-pack');
      floatingStore.closeWindow('kickoff-training');
      floatingStore.closeWindow('replay-viewer');

      if (owner.networkManager.diagnosticsProbe.diagnosticsFleetController?.enabled) {
        void owner.networkManager.diagnosticsProbe.toggleDiagnosticTestFleet(false);
        networkDiagnosticsStore.syncZeroGFleetState(false);
      }
      if (owner.networkManager.diagnosticsProbe.lobbyGhostMode) {
        owner.networkManager.diagnosticsProbe.configureLobbyGhostMode(false);
        networkDiagnosticsStore?.setLobbyGhostMode?.(false);
      }

      const session = owner.multiplayerSession;
      if (session) {
        if (session.isHosting) {
          void session.stopHosting?.();
        } else if (session.clientController || session.signalingHandler) {
          void session.leaveSession?.();
        }
      }
      const netSession = owner.networkManager.sessionCoordinator;
      if (netSession.authoritativeServer || netSession.networkChannel) {
        void netSession.stopOnlineServer({ rebindLoopback: false });
      }
      leaveActiveBotMatchIfNeeded(owner);
      owner.match?.leave();
      owner.modeManager?.setMode?.('freeplay');

      const freeplayMode = owner.modeManager?.modes?.get?.('freeplay') as
        | FreeplayModeCleanupPort
        | undefined;
      freeplayMode?.resetToCleanFreeplay?.();

      owner.physics?.setUnlimitedBoost?.(unlimitedBoost);
      if (owner.trainingOptions) {
        owner.trainingOptions.boostOption = unlimitedBoost ? 'unlimited' : 'standard';
      }
      owner.resetKickoff();
      owner.domEventManager.syncPausedAndInputState();
    },
    resetKickoff: () => {
      owner.resetKickoff();
    },
    hostOnlineWarmup: async (opts) => {
      const session = owner.multiplayerSession;
      const roomConfig = {
        roomType: opts.roomType || 'match',
        gameMode: opts.gameMode || '2v2',
        botFillMode: opts.botFillMode || 'auto_fill',
        durationSeconds: opts.durationSeconds ?? 300,
        lobbyMode: opts.lobbyMode !== undefined ? Boolean(opts.lobbyMode) : true,
      };
      if (session) {
        if (opts.playerName) session.playerName = opts.playerName;
        await session.startHosting(opts.roomId, opts.password || '', roomConfig);
        return true;
      }
      await owner.networkManager.sessionCoordinator.hostOnlineServer({
        roomId: opts.roomId,
        playerName: opts.playerName,
        ...roomConfig,
      });
      return true;
    },
    joinOnlineWarmup: async (opts) => {
      const session = owner.multiplayerSession;
      if (session) {
        if (opts.playerName) session.playerName = opts.playerName;
        return Boolean(await session.joinRoom(opts.roomId, opts.password || '', 10000));
      }
      await owner.networkManager.sessionCoordinator.joinOnlineServer({
        playerName: opts.playerName,
      });
      return true;
    },
    approvePendingPeer: (peerId) => {
      owner.multiplayerSession?.approvePendingPeer?.(peerId);
    },
    declinePendingPeer: (peerId) => {
      owner.multiplayerSession?.declinePendingPeer?.(peerId);
    },
    leaveOnlineServer: async () => {
      const session = owner.multiplayerSession;
      if (session) {
        if (session.isHosting) {
          await session.stopHosting?.();
        } else {
          await session.leaveSession?.();
        }
      }
      await owner.networkManager.sessionCoordinator.stopOnlineServer();
    },
    returnToOnlineLobby: async () => {
      await owner.networkManager.sessionCoordinator.returnOnlineMatchToLobby();
      owner.multiplayerSession?.notifyReturnedToLobby?.();
    },
    pauseOnlineMatch: (pause) => {
      const server = owner.networkManager.sessionCoordinator.authoritativeServer;
      if (!server) return;
      server.pauseMatch?.(Boolean(pause));
    },
    removeRemotePlayer: async (carIndex) => {
      await owner.networkManager.rosterSyncCoordinator.removeRemotePlayer(carIndex);
    },
    reconnectSignaling: async () => {
      const session = owner.multiplayerSession;
      if (session) {
        if (session.isHosting) {
          await session.reprobeAndRefreshHostSignaling?.();
        } else if (session.joinRoomId) {
          await session.joinRoom?.(session.joinRoomId, session.joinPassword);
        }
      }
    },
    forceStartOnlineMatch: (durationSeconds = 90) => {
      owner.networkManager.forceStartOnlineMatch(durationSeconds);
      owner.multiplayerSession?.notifyMatchStarted?.();
    },
    setOnlineGameMode: (gameMode) => {
      owner.networkManager.setOnlineGameMode(gameMode);
    },
    setOnlineMatchDuration: (durationSeconds) => {
      owner.networkManager.setOnlineMatchDuration(durationSeconds);
    },
    setOnlineBotFillMode: (botFillMode) => {
      owner.networkManager.setOnlineBotFillMode(botFillMode);
    },
    setClientReady: (ready) => {
      owner.networkManager.setClientReady(ready);
    },
    addOnlineBot: (team = null) => {
      owner.networkManager.addOnlineBot(team);
    },
    voteRematch: (ready) => {
      if (owner.match?.state?.mode === 'exp-multi-bots') {
        void owner.modeManager?.getActiveMode?.()?.applyRosterAndStartMatch?.();
        return;
      }
      owner.networkManager.voteRematch(ready);
    },
    switchOnlineRoleOrTeam: (role, team) => {
      owner.networkManager.switchOnlineRoleOrTeam(role, team);
    },
    setClockPacingMode: (mode) => {
      owner.networkManager.sessionCoordinator.networkReconciler?.setClockPacingMode?.(mode);
    },
    setClockPacingPriority: (priority) => {
      owner.networkManager.sessionCoordinator.networkReconciler?.setClockPacingPriority?.(priority);
    },
    setClockPacingParams: (params) => {
      if (params) {
        owner.networkManager.sessionCoordinator.networkReconciler?.setClockPacingParams?.(
          params as PacingControllerParams,
        );
      }
    },
    setInputBufferTarget: (target) => {
      owner.networkManager.sessionCoordinator.networkReconciler?.setInputBufferTarget?.(target);
    },
    setInputBufferThresholds: (minOffset, maxOffset) => {
      owner.networkManager.sessionCoordinator.networkReconciler?.setInputBufferThresholds?.(
        minOffset,
        maxOffset,
      );
    },
    syncInitialClockPacing: (state) => {
      const reconciler = owner.networkManager.sessionCoordinator.networkReconciler;
      if (!reconciler) return;
      reconciler.setClockPacingMode?.(state.clockPacingMode);
      reconciler.setClockPacingPriority?.(state.clockPacingPriority);
      reconciler.setInputBufferTarget?.(state.inputBufferTarget);
      if (Array.isArray(state.inputBufferThreshold)) {
        reconciler.setInputBufferThresholds?.(
          state.inputBufferThreshold[0],
          state.inputBufferThreshold[1],
        );
      }
      if (state.customClockPacingParams) {
        reconciler.setClockPacingParams?.(
          resolveEffectiveClockPacingParams(
            state.clockPacingMode as ClockPacingMode,
            state.clockPacingPriority as ClockPacingPriority,
            state.inputBufferTarget,
            state.inputBufferThreshold,
            state.customClockPacingParams as unknown as ClockPacingParams,
          ),
        );
      }
    },
  };

  return {
    cameraPort,
    matchPort,
    tunerPort: createRuntimeTunerPort(owner),
    replayPort: createRuntimeReplayPort(owner),
  };
}
