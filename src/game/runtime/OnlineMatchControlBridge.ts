import type { RuntimeCameraPort, RuntimeMatchPort } from '../runtimeUiPort.ts';
import {
  resolveEffectiveClockPacingParams,
  type ClockPacingMode,
  type ClockPacingPriority,
  type ClockPacingParams,
} from '../../ui-core/config/clockPacingConfig.ts';
import type { PacingControllerParams } from '../../ui-core/config/pacingControllerEvaluator.ts';
import type { RuntimeDomainPortOwner } from './GoalBarrierRuntimeBridge.ts';
import { createMatchModeTransitionBridge } from './MatchModeTransitionBridge.ts';

export function createRuntimeCameraPort(target: RuntimeDomainPortOwner): RuntimeCameraPort {
  return {
    applyPovSettings: (cameraConfig) => {
      target.camera?.applyPovSettings?.(cameraConfig);
    },
    setFreeCam: (enabled) => {
      target.camera?.setFreeCam?.(enabled);
    },
    setFreeCamFov: (fov) => {
      target.camera?.setFreeCamFov?.(fov);
    },
    resetFreeCamOverview: () => {
      target.camera?.resetFreeCamOverview?.();
    },
    setDiagnosticObservationTarget: (targetCarIndex) =>
      target.networkManager.diagnosticsProbe.setDiagnosticObservationTarget(targetCarIndex),
  };
}

export function createRuntimeMatchPort(target: RuntimeDomainPortOwner): RuntimeMatchPort {
  const modeTransitionSlice = createMatchModeTransitionBridge(target);

  return {
    ...modeTransitionSlice,
    hostOnlineWarmup: async (opts) => {
      const session = target.multiplayerSession;
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
      await target.networkManager.sessionCoordinator.hostOnlineServer({
        roomId: opts.roomId,
        playerName: opts.playerName,
        ...roomConfig,
      });
      return true;
    },
    joinOnlineWarmup: async (opts) => {
      const session = target.multiplayerSession;
      if (session) {
        if (opts.playerName) session.playerName = opts.playerName;
        return Boolean(await session.joinRoom(opts.roomId, opts.password || '', 10000));
      }
      await target.networkManager.sessionCoordinator.joinOnlineServer({
        playerName: opts.playerName,
      });
      return true;
    },
    approvePendingPeer: (peerId) => {
      target.multiplayerSession?.approvePendingPeer?.(peerId);
    },
    declinePendingPeer: (peerId) => {
      target.multiplayerSession?.declinePendingPeer?.(peerId);
    },
    leaveOnlineServer: async () => {
      const session = target.multiplayerSession;
      if (session) {
        if (session.isHosting) {
          await session.stopHosting?.();
        } else {
          await session.leaveSession?.();
        }
      }
      await target.networkManager.sessionCoordinator.stopOnlineServer();
    },
    returnToOnlineLobby: async () => {
      await target.networkManager.sessionCoordinator.returnOnlineMatchToLobby();
      target.multiplayerSession?.notifyReturnedToLobby?.();
    },
    pauseOnlineMatch: (pause) => {
      const server = target.networkManager.sessionCoordinator.authoritativeServer;
      if (!server) return;
      server.pauseMatch?.(Boolean(pause));
    },
    removeRemotePlayer: async (carIndex) => {
      await target.networkManager.rosterSyncCoordinator.removeRemotePlayer(carIndex);
    },
    reconnectSignaling: async () => {
      const session = target.multiplayerSession;
      if (session) {
        if (session.isHosting) {
          await session.reprobeAndRefreshHostSignaling?.();
        } else if (session.joinRoomId) {
          await session.joinRoom?.(session.joinRoomId, session.joinPassword);
        }
      }
    },
    forceStartOnlineMatch: (durationSeconds = 90) => {
      target.networkManager.forceStartOnlineMatch(durationSeconds);
      target.multiplayerSession?.notifyMatchStarted?.();
    },
    setOnlineGameMode: (gameMode) => {
      target.networkManager.setOnlineGameMode(gameMode);
    },
    setOnlineMatchDuration: (durationSeconds) => {
      target.networkManager.setOnlineMatchDuration(durationSeconds);
    },
    setOnlineBotFillMode: (botFillMode) => {
      target.networkManager.setOnlineBotFillMode(botFillMode);
    },
    setClientReady: (ready) => {
      target.networkManager.setClientReady(ready);
    },
    addOnlineBot: (team = null) => {
      target.networkManager.addOnlineBot(team);
    },
    voteRematch: (ready) => {
      if (target.match?.state?.mode === 'exp-multi-bots') {
        void target.modeManager?.getActiveMode?.()?.applyRosterAndStartMatch?.();
        return;
      }
      target.networkManager.voteRematch(ready);
    },
    switchOnlineRoleOrTeam: (role, team) => {
      target.networkManager.switchOnlineRoleOrTeam(role, team);
    },
    setClockPacingMode: (pacingMode) => {
      target.networkManager.sessionCoordinator.networkReconciler?.setClockPacingMode?.(pacingMode);
    },
    setClockPacingPriority: (priority) => {
      target.networkManager.sessionCoordinator.networkReconciler?.setClockPacingPriority?.(
        priority
      );
    },
    setClockPacingParams: (params) => {
      if (params) {
        target.networkManager.sessionCoordinator.networkReconciler?.setClockPacingParams?.(
          params as PacingControllerParams
        );
      }
    },
    setInputBufferTarget: (bufferTarget) => {
      target.networkManager.sessionCoordinator.networkReconciler?.setInputBufferTarget?.(
        bufferTarget
      );
    },
    setInputBufferThresholds: (minOffset, maxOffset) => {
      target.networkManager.sessionCoordinator.networkReconciler?.setInputBufferThresholds?.(
        minOffset,
        maxOffset
      );
    },
    syncInitialClockPacing: (state) => {
      const reconciler = target.networkManager.sessionCoordinator.networkReconciler;
      if (!reconciler) return;
      reconciler.setClockPacingMode?.(state.clockPacingMode);
      reconciler.setClockPacingPriority?.(state.clockPacingPriority);
      reconciler.setInputBufferTarget?.(state.inputBufferTarget);
      if (Array.isArray(state.inputBufferThreshold)) {
        reconciler.setInputBufferThresholds?.(
          state.inputBufferThreshold[0],
          state.inputBufferThreshold[1]
        );
      }
      if (state.customClockPacingParams) {
        reconciler.setClockPacingParams?.(
          resolveEffectiveClockPacingParams(
            state.clockPacingMode as ClockPacingMode,
            state.clockPacingPriority as ClockPacingPriority,
            state.inputBufferTarget,
            state.inputBufferThreshold,
            state.customClockPacingParams as unknown as ClockPacingParams
          )
        );
      }
    },
  };
}
